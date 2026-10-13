// Reasoning control, reasoning reserve and temperature handling, found by the
// first live benchmark: GPT-5 Nano and Gemini 3.8 Flash spent the whole
// answer budget on hidden reasoning (output_truncated), and OpenRouter found
// no endpoint for Claude Haiku 5.5 because it does not accept temperature.
import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/extract/llm/budget.js';
import { CircuitBreaker } from '../../src/extract/llm/breaker.js';
import { ModelClient } from '../../src/extract/llm/client.js';
import { fakeCaps, fakeResponse, FakeProvider } from '../../src/extract/llm/providers/fake.js';
import { buildChatBody, OpenAICompatibleProvider } from '../../src/extract/llm/providers/openai-compatible.js';
import { resolveModels } from '../../src/extract/llm/registry.js';
import { planInputBudget, requestedOutputTokens } from '../../src/extract/llm/tokens.js';
import type { LlmRequest, ModelCapabilities } from '../../src/extract/types.js';

const REQ: LlmRequest = { system: 's', user: 'u', maxOutputTokens: 2_000 };

function known(key: string): ModelCapabilities {
  const { models } = resolveModels({ EXTRACT_MODELS: key, OPENROUTER_API_KEY: 'k', OPENAI_API_KEY: 'k' });
  expect(models).toHaveLength(1);
  return models[0]!;
}

describe('registry entries for the benchmarked models', () => {
  it('knows which models reject temperature and which need minimal reasoning', () => {
    const haiku = known('openrouter:anthropic/claude-haiku-5.5');
    expect(haiku.acceptsTemperature).toBe(false);
    expect(haiku.reasoningEffort).toBeUndefined();
    expect(haiku.contextTokens).toBeLessThanOrEqual(100_000); // 5x price above 100k prompt tokens

    for (const key of ['openrouter:openai/gpt-5-nano', 'openrouter:google/gemini-3.8-flash', 'openai:gpt-5-nano']) {
      const caps = known(key);
      expect(caps.reasoningEffort, key).toBe('minimal');
      expect(caps.reasoningReserveTokens, key).toBeGreaterThan(0);
    }
  });

  it('accepts the new fields in EXTRACT_MODEL_CAPS and rejects bad values', () => {
    const { models, warnings } = resolveModels({
      EXTRACT_MODELS: 'openrouter:vendor/new-model',
      OPENROUTER_API_KEY: 'k',
      EXTRACT_MODEL_CAPS: JSON.stringify({
        'openrouter:vendor/new-model': { acceptsTemperature: false, reasoningEffort: 'low', reasoningReserveTokens: 2048 },
      }),
    });
    expect(models[0]).toMatchObject({ acceptsTemperature: false, reasoningEffort: 'low', reasoningReserveTokens: 2048 });

    const bad = resolveModels({
      EXTRACT_MODELS: 'openrouter:vendor/new-model',
      OPENROUTER_API_KEY: 'k',
      EXTRACT_MODEL_CAPS: JSON.stringify({
        'openrouter:vendor/new-model': { acceptsTemperature: 'no', reasoningEffort: 'max', reasoningReserveTokens: -1 },
      }),
    });
    expect(bad.models[0]!.reasoningEffort).toBeUndefined();
    expect(bad.warnings.filter((w) => w.includes('is invalid'))).toHaveLength(3);
    expect(warnings.some((w) => w.includes('is invalid'))).toBe(false);
  });
});

describe('request body', () => {
  it('asks OpenRouter for minimal, excluded reasoning and reserves room for it', () => {
    const caps = known('openrouter:openai/gpt-5-nano');
    const body = buildChatBody('openrouter', caps, REQ);
    expect(body.reasoning).toEqual({ effort: 'minimal', exclude: true });
    expect(body.max_tokens).toBe(2_000 + caps.reasoningReserveTokens!);
    expect(body).not.toHaveProperty('temperature');
  });

  it('uses reasoning_effort and max_completion_tokens on OpenAI directly', () => {
    const caps = known('openai:gpt-5-nano');
    const body = buildChatBody('openai', caps, REQ);
    expect(body.reasoning_effort).toBe('minimal');
    expect(body).not.toHaveProperty('reasoning');
    expect(body.max_completion_tokens).toBe(2_000 + caps.reasoningReserveTokens!);
  });

  it('omits temperature for models that reject it, keeps it for the rest', () => {
    expect(buildChatBody('openrouter', known('openrouter:anthropic/claude-haiku-5.5'), REQ)).not.toHaveProperty('temperature');
    expect(buildChatBody('openrouter', known('openrouter:google/gemini-2.5-flash-lite'), REQ).temperature).toBe(0);
  });

  it('never exceeds the model output limit with the reserve added', () => {
    const caps = fakeCaps({ maxOutputTokens: 4_096, reasoningReserveTokens: 1_024 });
    expect(requestedOutputTokens(caps, 3_500)).toBe(4_096);
    expect(requestedOutputTokens(caps, 100)).toBe(1_124);
  });

  it('counts the reserve when planning how much page fits the context', () => {
    const base = fakeCaps({ contextTokens: 50_000, maxOutputTokens: 16_000 });
    const opts = { systemText: '', schemaText: '', reservedOutputTokens: 2_000, safetyMargin: 0 };
    const without = planInputBudget(base, opts);
    const withReserve = planInputBudget({ ...base, reasoningReserveTokens: 3_000 }, opts);
    expect(without - withReserve).toBe(3_000);
  });
});

describe('OpenRouter "no endpoint can handle the requested parameters"', () => {
  const NO_ENDPOINT = JSON.stringify({ error: { code: 404, message: 'No endpoints found that can handle the requested parameters.' } });
  const OK = JSON.stringify({
    model: 'x', choices: [{ finish_reason: 'stop', message: { content: '{"records":[]}' } }], usage: { prompt_tokens: 5, completion_tokens: 3 },
  });

  function provider(handler: (body: Record<string, unknown>) => { status: number; text: string }) {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      const r = handler(body);
      return new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { bodies, provider: new OpenAICompatibleProvider({ name: 'openrouter', apiKey: 'sk-or-test-0123456789', fetchImpl }) };
  }

  it('retries once without temperature and stops sending it to that model', async () => {
    const caps = fakeCaps({ provider: 'openrouter', model: 'vendor/no-temp-a' });
    const { bodies, provider: p } = provider((b) => ('temperature' in b ? { status: 404, text: NO_ENDPOINT } : { status: 200, text: OK }));
    await expect(p.complete(caps, REQ)).resolves.toMatchObject({ finishReason: 'stop' });
    expect(bodies.map((b) => 'temperature' in b)).toEqual([true, false]);
    await p.complete(caps, REQ);
    expect(bodies.map((b) => 'temperature' in b)).toEqual([true, false, false]); // learned: one call
  });

  it('does not learn when temperature was not the problem', async () => {
    const caps = fakeCaps({ provider: 'openrouter', model: 'vendor/no-temp-b' });
    const { bodies, provider: p } = provider(() => ({ status: 404, text: NO_ENDPOINT }));
    await expect(p.complete(caps, REQ)).rejects.toMatchObject({ category: 'unsupported_request' });
    await expect(p.complete(caps, REQ)).rejects.toMatchObject({ category: 'unsupported_request' });
    expect(bodies.map((b) => 'temperature' in b)).toEqual([true, false, true, false]);
  });

  it('does not retry other errors', async () => {
    const caps = fakeCaps({ provider: 'openrouter', model: 'vendor/no-temp-c' });
    const { bodies, provider: p } = provider(() => ({ status: 400, text: JSON.stringify({ error: { code: 400, message: 'bad schema' } }) }));
    await expect(p.complete(caps, REQ)).rejects.toBeTruthy();
    expect(bodies).toHaveLength(1);
  });
});

describe('cost cap with a reasoning reserve', () => {
  it('lowers the answer budget so answer + reserve stays within what the budget affords', async () => {
    const caps = fakeCaps({
      provider: 'openrouter', model: 'priced-reasoner', contextTokens: 100_000, maxOutputTokens: 32_000,
      inputCostPerMTok: 0, outputCostPerMTok: 1_000, reasoningReserveTokens: 1_024,
    });
    const seen: number[] = [];
    const fake = new FakeProvider((_c, req) => {
      seen.push(req.maxOutputTokens);
      return fakeResponse('{"records":[]}', { costUsd: 0 });
    }, 'openrouter');
    const client = new ModelClient({ models: [caps], providers: { openrouter: fake }, breaker: new CircuitBreaker() });
    // $2 at $1000/M output affords 2,000 output tokens in total.
    const budget = new Budget({ deadlineMs: Date.now() + 60_000, maxCostUsd: 2 });
    await client.complete({ ...REQ, maxOutputTokens: 8_000 }, { purpose: 'extract', budget, estimatedInputTokens: 10 });
    expect(seen).toHaveLength(1);
    expect(requestedOutputTokens(caps, seen[0]!)).toBeLessThanOrEqual(2_000);
    expect(seen[0]!).toBeGreaterThan(0);
  });
});
