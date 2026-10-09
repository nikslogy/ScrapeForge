// Regression tests for model-layer defects found in the third review pass.

import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/extract/llm/budget.js';
import { CircuitBreaker } from '../../src/extract/llm/breaker.js';
import { ModelClient } from '../../src/extract/llm/client.js';
import type { LlmCallError } from '../../src/extract/llm/errors.js';
import { estimateCostUsd } from '../../src/extract/llm/registry.js';
import { delay, fakeCaps, fakeError, fakeResponse, FakeProvider, scripted, type FakeStep } from '../../src/extract/llm/providers/fake.js';
import { LlmError, type LlmProvider, type LlmRequest, type ModelCapabilities } from '../../src/extract/types.js';

// $0.40 / $1.60 per million tokens.
const PRICED = fakeCaps({ provider: 'openrouter', model: 'priced', contextTokens: 1_000_000, maxOutputTokens: 32_768, inputCostPerMTok: 0.4, outputCostPerMTok: 1.6 });
const REQ: LlmRequest = { system: 'sys', user: 'user', maxOutputTokens: 8_000 };

function setup(
  models: ModelCapabilities[],
  scripts: Partial<Record<ModelCapabilities['provider'], FakeStep[]>>,
  maxCostUsd: number,
  perCallTimeoutMs?: number,
) {
  const providers: Record<string, FakeProvider> = {};
  for (const [name, steps] of Object.entries(scripts)) {
    providers[name] = new FakeProvider(scripted(...(steps as FakeStep[])), name as ModelCapabilities['provider']);
  }
  const client = new ModelClient({
    models,
    providers: providers as Partial<Record<ModelCapabilities['provider'], LlmProvider>>,
    breaker: new CircuitBreaker(),
    sleep: async () => undefined,
    ...(perCallTimeoutMs !== undefined ? { perCallTimeoutMs } : {}),
  });
  const budget = new Budget({ deadlineMs: Date.now() + 60_000, maxCostUsd });
  return { client, budget, providers };
}

async function failure(p: Promise<unknown>): Promise<LlmCallError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(LlmError);
    return err as LlmCallError;
  }
  throw new Error('expected failure');
}

/** A provider call that never answers on its own (it honours the abort signal). */
const hang: FakeStep = async (_caps, req) => {
  await delay(30_000, req.signal);
  return fakeResponse();
};

describe('cost cap: abandoned calls', () => {
  it('a timed-out call counts at its worst case, so the retry cannot push spend past the cap', async () => {
    const s = setup([PRICED], { openrouter: [hang, fakeResponse()] }, 0.02, 50);
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget, estimatedInputTokens: 2_000 });
    const sent = s.providers.openrouter.calls.map((c) => c.req.maxOutputTokens);
    expect(sent[0]).toBe(8_000);
    // Non-streaming calls keep running (and are billed) after the client gives up.
    const worst = sent.map((out) => estimateCostUsd(PRICED, 2_000, out));
    expect(worst[0] + worst[1]).toBeLessThanOrEqual(0.02);
    expect(sent[1]).toBeLessThan(8_000);

    const [timedOut] = result.attempts;
    expect(timedOut.errorCategory).toBe('timeout');
    expect(timedOut.costUsd).toBeCloseTo(worst[0], 12);
    expect(timedOut.note).toMatch(/usage unknown after timeout: worst-case cost \$0\.013600 counted/);
    expect(s.budget.spentUsd).toBeCloseTo(worst[0] + result.attempts[1].costUsd, 12);
  }, 10_000);

  it('a timeout the provider reports itself (the client did not abandon the call) adds no estimate', async () => {
    const s = setup([PRICED], { openrouter: [fakeError('timeout'), fakeResponse()] }, 0.02);
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget, estimatedInputTokens: 2_000 });
    // A classified timeout from the provider (no abort by the client) carries its own usage: none.
    expect(result.attempts[0].costUsd).toBe(0);
    expect(s.providers.openrouter.calls[1].req.maxOutputTokens).toBe(8_000);
  });
});

describe('cost cap: input estimate', () => {
  it('counts the response schema for a json_schema fallback even when the caller sized the input for a json_object primary', async () => {
    const primary = fakeCaps({ provider: 'groq', model: 'plain', contextTokens: 1_000_000, jsonMode: 'json_object', inputCostPerMTok: 0.4, outputCostPerMTok: 1.6 });
    const schemaModel = { ...PRICED, jsonMode: 'json_schema' as const };
    // ~20k tokens of schema: $0.0088 of input at $0.40/M (with margin) before any output.
    const schema = { type: 'object', properties: { pad: { type: 'string', description: 'y'.repeat(64_000) } } };
    const s = setup([primary, schemaModel], { groq: [fakeError('unknown')], openrouter: [fakeResponse()] }, 0.009);
    // The caller's estimate covers the prompt only (right for the json_object primary).
    const err = await failure(
      s.client.complete({ ...REQ, responseSchema: schema }, { purpose: 'extract', budget: s.budget, estimatedInputTokens: 100 }),
    );
    expect(err.category).toBe('budget_exhausted');
    expect(s.providers.openrouter.calls).toHaveLength(0);
  });

  it('never prices the input below what the request itself holds', async () => {
    // The caller claims 10 tokens; the user text alone is ~40k tokens ($0.016 at $0.40/M).
    const s = setup([PRICED], { openrouter: [fakeResponse()] }, 0.01);
    const err = await failure(
      s.client.complete({ ...REQ, user: 'x'.repeat(128_000) }, { purpose: 'extract', budget: s.budget, estimatedInputTokens: 10 }),
    );
    expect(err.category).toBe('budget_exhausted');
    expect(s.providers.openrouter.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Gemini 2.5 Flash: thinking tokens count against maxOutputTokens
// ─────────────────────────────────────────────────────────────

describe('Gemini 2.5 Flash thinking', () => {
  /**
   * Stand-in for generateContent with Gemini 2.5 Flash's documented
   * accounting: unless thinkingBudget is 0 the model thinks first (dynamic
   * budget, here 1,500 tokens) and those tokens count against maxOutputTokens.
   */
  function flashStub(bodies: Array<Record<string, unknown>>): typeof fetch {
    return (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      const config = body.generationConfig as { maxOutputTokens: number; thinkingConfig?: { thinkingBudget?: number } };
      const thinks = config.thinkingConfig?.thinkingBudget === 0 ? 0 : 1_500;
      const answer = '{"records":[{"title":{"v":"Acme","b":"b1"}}]}';
      const out =
        thinks >= config.maxOutputTokens
          ? { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 500, thoughtsTokenCount: config.maxOutputTokens } }
          : {
              candidates: [{ content: { role: 'model', parts: [{ text: answer }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, ...(thinks ? { thoughtsTokenCount: thinks } : {}) },
            };
      return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  }

  it('answers a small extraction within a 1,024-token output limit', async () => {
    const { GeminiProvider } = await import('../../src/extract/llm/providers/gemini.js');
    const { resolveModels } = await import('../../src/extract/llm/registry.js');
    const [flash] = resolveModels({ GEMINI_API_KEY: 'AIza0123456789abcdefghij', EXTRACT_MODELS: 'gemini:gemini-2.5-flash' }).models;
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new GeminiProvider({ apiKey: 'AIza0123456789abcdefghij', fetchImpl: flashStub(bodies) });
    const c = new ModelClient({ models: [flash], providers: { gemini: provider }, breaker: new CircuitBreaker(), sleep: async () => undefined });
    const result = await c.complete({ ...REQ, maxOutputTokens: 1_024 }, { purpose: 'extract', budget: new Budget({ deadlineMs: Date.now() + 60_000 }) });
    expect(result.response.text).toContain('Acme');
    expect((bodies[0].generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('leaves models without a thinking switch alone', async () => {
    const { buildGeminiBody } = await import('../../src/extract/llm/providers/gemini.js');
    for (const model of ['gemini-2.0-flash-lite', 'gemini-2.5-pro', 'gemini-3-pro-preview']) {
      const body = buildGeminiBody(fakeCaps({ provider: 'gemini', model }), REQ);
      expect((body.generationConfig as Record<string, unknown>).thinkingConfig).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// OpenAI reasoning models accept only the default temperature
// ─────────────────────────────────────────────────────────────

describe('reasoning models and temperature', () => {
  // OpenAI's answer to temperature 0 on o-series and gpt-5 models.
  const TEMPERATURE_400 = {
    error: {
      message: "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
      type: 'invalid_request_error',
      param: 'temperature',
      code: 'unsupported_value',
    },
  };

  function openAIStub(bodies: Array<Record<string, unknown>>): typeof fetch {
    return (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      const reasoning = /^(?:o\d|gpt-5)/.test(String(body.model));
      if (reasoning && body.temperature !== undefined && body.temperature !== 1) {
        return new Response(JSON.stringify(TEMPERATURE_400), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      const out = {
        model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"records":[]}' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      };
      return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  }

  it.each(['gpt-5-mini', 'o4-mini'])('%s is called without temperature and answers', async (model) => {
    const { OpenAICompatibleProvider } = await import('../../src/extract/llm/providers/openai-compatible.js');
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenAICompatibleProvider({ name: 'openai', apiKey: 'sk-0123456789abcdef', fetchImpl: openAIStub(bodies) });
    const caps = fakeCaps({ provider: 'openai', model, contextTokens: 400_000, maxOutputTokens: 32_000 });
    const c = new ModelClient({ models: [caps], providers: { openai: provider }, breaker: new CircuitBreaker(), sleep: async () => undefined });
    const result = await c.complete({ ...REQ, temperature: 0 }, { purpose: 'extract', budget: new Budget({ deadlineMs: Date.now() + 60_000 }) });
    expect(result.response.text).toBe('{"records":[]}');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('temperature');
  });

  it('keeps temperature for other models, also via OpenRouter', async () => {
    const { buildChatBody } = await import('../../src/extract/llm/providers/openai-compatible.js');
    expect(buildChatBody('openai', fakeCaps({ provider: 'openai', model: 'gpt-4.1-mini' }), REQ).temperature).toBe(0);
    expect(buildChatBody('groq', fakeCaps({ provider: 'groq', model: 'openai/gpt-oss-120b' }), REQ).temperature).toBe(0);
    expect(buildChatBody('openrouter', fakeCaps({ provider: 'openrouter', model: 'openai/gpt-5-mini' }), REQ)).not.toHaveProperty('temperature');
  });
});

// ─────────────────────────────────────────────────────────────
// Salvaging complete records from a truncated answer
// ─────────────────────────────────────────────────────────────

describe('salvageTruncatedRecords', () => {
  it('returns the complete records of a cut-off answer, from the error the client throws', async () => {
    const { normalizeSchema } = await import('../../src/extract/schema/normalize.js');
    const { parseExtractionResponse, salvageTruncatedRecords } = await import('../../src/extract/llm/parse.js');
    const schema = normalizeSchema({ title: 'string', price: 'number' });
    const partial =
      '```json\n{"records":[{"title":{"v":"A [1] {x}","b":"b1"},"price":{"v":"£1","b":"b2"}},\n {"title":{"v":"B","b":"b3"},"price":{"v":"£2","b":"b4"}}, {"title":{"v":"C","b":"b5"},"pri';
    expect(() => parseExtractionResponse(partial, schema)).toThrow(expect.objectContaining({ category: 'output_truncated' }));

    const s = setup([PRICED], { openrouter: [fakeResponse(partial, { finishReason: 'length' })] }, 1);
    const err = await failure(s.client.complete(REQ, { purpose: 'extract', budget: s.budget }));
    const salvaged = salvageTruncatedRecords(err.partialText ?? '', schema);
    expect(salvaged.records).toEqual([
      { title: { v: 'A [1] {x}', b: 'b1' }, price: { v: '£1', b: 'b2' } },
      { title: { v: 'B', b: 'b3' }, price: { v: '£2', b: 'b4' } },
    ]);
    expect(salvaged.warnings).toContain('kept 2 complete records of a truncated answer');
  });

  it('handles a bare top-level array, a reasoning preamble, and nothing to keep', async () => {
    const { normalizeSchema } = await import('../../src/extract/schema/normalize.js');
    const { salvageTruncatedRecords } = await import('../../src/extract/llm/parse.js');
    const schema = normalizeSchema({ title: 'string' });
    expect(salvageTruncatedRecords('[{"title":{"v":"A","b":"b1"}},{"title":{"v":"B"', schema).records).toEqual([{ title: { v: 'A', b: 'b1' } }]);
    expect(
      salvageTruncatedRecords('<think>{"records":[{"title":"no"}]}</think>{"records":[{"title":{"v":"A","b":"b1"}},{"ti', schema).records,
    ).toEqual([{ title: { v: 'A', b: 'b1' } }]);
    expect(salvageTruncatedRecords('{"records":[{"title":{"v":"A","b":"b1"', schema).records).toEqual([]);
    expect(salvageTruncatedRecords('I could not', schema).records).toEqual([]);
    expect(salvageTruncatedRecords('', schema).records).toEqual([]);
  });
});
