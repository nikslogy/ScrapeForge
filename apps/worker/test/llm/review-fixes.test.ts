// Regression tests for defects found while reviewing the model layer.

import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/extract/llm/budget.js';
import { CircuitBreaker } from '../../src/extract/llm/breaker.js';
import { ModelClient } from '../../src/extract/llm/client.js';
import { classifyFailure, LlmCallError, MAX_PARTIAL_TEXT_CHARS } from '../../src/extract/llm/errors.js';
import { parseExtractionResponse } from '../../src/extract/llm/parse.js';
import { resolveModels } from '../../src/extract/llm/registry.js';
import { fakeCaps, fakeError, fakeResponse, FakeProvider, scripted, type FakeStep } from '../../src/extract/llm/providers/fake.js';
import { OpenAICompatibleProvider } from '../../src/extract/llm/providers/openai-compatible.js';
import { normalizeSchema } from '../../src/extract/schema/normalize.js';
import { LlmError, type LlmProvider, type LlmRequest, type ModelCapabilities } from '../../src/extract/types.js';

const OR_A = fakeCaps({ provider: 'openrouter', model: 'a', contextTokens: 100_000 });
const GROQ = fakeCaps({ provider: 'groq', model: 'g', contextTokens: 100_000 });
const REQ: LlmRequest = { system: 'sys', user: 'user', maxOutputTokens: 1_000 };

function client(models: ModelCapabilities[], scripts: Partial<Record<ModelCapabilities['provider'], FakeStep[]>>) {
  const providers: Record<string, FakeProvider> = {};
  for (const [name, steps] of Object.entries(scripts)) {
    providers[name] = new FakeProvider(scripted(...(steps as FakeStep[])), name as ModelCapabilities['provider']);
  }
  return {
    providers,
    client: new ModelClient({
      models,
      providers: providers as Partial<Record<ModelCapabilities['provider'], LlmProvider>>,
      breaker: new CircuitBreaker(),
      sleep: async () => undefined,
    }),
  };
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

const budget = () => new Budget({ deadlineMs: Date.now() + 60_000 });

describe('output_truncated carries the partial answer', () => {
  it('attaches the truncated text so complete records can be salvaged', async () => {
    const partial = '{"records":[{"a":{"v":"1","b":"b1"}},{"a":{"v":"2","b":"b2"}},{"a":{"v":"3';
    const s = client([OR_A, GROQ], { openrouter: [fakeResponse(partial, { finishReason: 'length', outputTokens: 1_000 })] });
    const err = await failure(s.client.complete(REQ, { purpose: 'extract', budget: budget() }));
    expect(err).toBeInstanceOf(LlmCallError);
    expect(err.category).toBe('output_truncated');
    expect(err.partialText).toBe(partial);
    // Kept out of enumerable props so logging the error does not dump the answer.
    expect(Object.keys(err)).not.toContain('partialText');
    expect(JSON.stringify(err)).not.toContain('records');
  });

  it('bounds the attached text', async () => {
    const huge = `{"records":[${'{"a":{"v":"x","b":"b1"}},'.repeat(20_000)}`;
    expect(huge.length).toBeGreaterThan(MAX_PARTIAL_TEXT_CHARS);
    const s = client([OR_A], { openrouter: [fakeResponse(huge, { finishReason: 'length' })] });
    const err = await failure(s.client.complete(REQ, { purpose: 'extract', budget: budget() }));
    expect(err.partialText).toBe(huge.slice(0, MAX_PARTIAL_TEXT_CHARS));
  });

  it('has no partial text for other failures', async () => {
    const s = client([OR_A], { openrouter: [fakeResponse('', { finishReason: 'content_filter' })] });
    const err = await failure(s.client.complete(REQ, { purpose: 'extract', budget: budget() }));
    expect(err.category).toBe('content_filter');
    expect(err.partialText).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// Classification must not read page/model text the provider echoes back
// ─────────────────────────────────────────────────────────────

function groqWith(status: number, body: unknown): OpenAICompatibleProvider {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  return new OpenAICompatibleProvider({ name: 'groq', apiKey: 'gsk_0123456789abcdefSECRET', fetchImpl });
}

// Groq's real json_validate_failed shape: the model's (page-derived) output is echoed in failed_generation.
const JSON_VALIDATE_FAILED = {
  error: {
    message: "Failed to generate JSON. Please adjust your prompt. See 'failed_generation' for more details.",
    type: 'invalid_request_error',
    code: 'json_validate_failed',
    failed_generation: '{"records":[{"title":{"v":"Unauthorized access? Free credit check, billing and quota alerts","b":"b3"}',
  },
};

describe('error classification ignores echoed content', () => {
  it('a Groq json_validate_failed body is unsupported_request whatever the echoed text says', async () => {
    const caps = fakeCaps({ provider: 'groq', model: 'llama-3.3-70b-versatile', jsonMode: 'json_object' });
    const err = await failure(groqWith(400, JSON_VALIDATE_FAILED).complete(caps, REQ));
    expect(err.category).toBe('unsupported_request');
    expect(classifyFailure(400, JSON.stringify(JSON_VALIDATE_FAILED)).category).toBe('unsupported_request');
  });

  it('page text echoed by a provider cannot trip the breaker for every request', async () => {
    const groqCaps = fakeCaps({ provider: 'groq', model: 'llama-3.3-70b-versatile', jsonMode: 'json_object' });
    const breaker = new CircuitBreaker();
    const c = new ModelClient({ models: [groqCaps], providers: { groq: groqWith(400, JSON_VALIDATE_FAILED) }, breaker, sleep: async () => undefined });
    await failure(c.complete(REQ, { purpose: 'extract', budget: budget() }));
    expect(breaker.isOpen('groq')).toBe(false);
    expect(breaker.isOpen(groqCaps.key)).toBe(false);
  });

  it('OpenRouter upstream text in metadata.raw is classified without its echoed generation', () => {
    const raw = JSON.stringify({ error: { ...JSON_VALIDATE_FAILED.error } });
    const body = JSON.stringify({ error: { code: 400, message: 'Provider returned error', metadata: { raw, provider_name: 'Groq' } } });
    expect(classifyFailure(400, body).category).toBe('unsupported_request');
  });

  it('still classifies the provider wording itself', () => {
    expect(classifyFailure(400, JSON.stringify({ error: { message: 'Invalid API Key', code: 'invalid_api_key' } })).category).toBe('auth');
    const moderation = { error: { code: 403, message: 'Your input was flagged', metadata: { flagged_input: 'unauthorized credit' } } };
    expect(classifyFailure(403, JSON.stringify(moderation)).category).toBe('content_filter');
  });
});

// ─────────────────────────────────────────────────────────────
// Groq 413 "request too large ... tokens per minute" is a tier limit, not a context window
// ─────────────────────────────────────────────────────────────

const GROQ_TPM_413 = {
  error: {
    message:
      'Request too large for model `llama-3.3-70b-versatile` in organization `org_01abc` service tier `on_demand` on tokens per minute (TPM): Limit 12000, Requested 21612, please reduce your message size and try again.',
    type: 'tokens',
    code: 'rate_limit_exceeded',
  },
};

describe('input_too_large from a per-minute token limit', () => {
  it('is scoped to the model', () => {
    expect(classifyFailure(413, JSON.stringify(GROQ_TPM_413))).toEqual({ category: 'input_too_large', scope: 'model' });
    expect(classifyFailure(400, 'This model\'s maximum context length is 128000 tokens')).toEqual({ category: 'input_too_large' });
  });

  it('does not rule out other providers\' models with the same context window', async () => {
    const groqCaps = fakeCaps({ provider: 'groq', model: 'llama-3.3-70b-versatile', contextTokens: 128_000, jsonMode: 'json_object' });
    const orCaps = fakeCaps({ provider: 'openrouter', model: 'openai/gpt-4o-mini', contextTokens: 128_000 });
    const openrouter = new FakeProvider(scripted(fakeResponse()), 'openrouter');
    const c = new ModelClient({
      models: [groqCaps, orCaps],
      providers: { groq: groqWith(413, GROQ_TPM_413), openrouter },
      breaker: new CircuitBreaker(),
      sleep: async () => undefined,
    });
    const result = await c.complete(REQ, { purpose: 'extract', budget: budget(), estimatedInputTokens: 21_000 });
    expect(result.model.key).toBe(orCaps.key);
    expect(result.attempts.map((a) => a.errorCategory ?? 'ok')).toEqual(['input_too_large', 'ok']);
  });
});

// ─────────────────────────────────────────────────────────────
// Caller aborts during a backoff
// ─────────────────────────────────────────────────────────────

describe('abort during backoff', () => {
  it('stops waiting as soon as the caller aborts (default sleep)', async () => {
    const provider = new FakeProvider(scripted(fakeError('rate_limit', { retryAfterMs: 5_000 }), fakeResponse()), 'openrouter');
    const c = new ModelClient({ models: [OR_A], providers: { openrouter: provider }, breaker: new CircuitBreaker() });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const err = await failure(c.complete({ ...REQ, signal: controller.signal }, { purpose: 'extract', budget: budget() }));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(provider.calls).toHaveLength(1);
    expect(err.message).toMatch(/^aborted by the caller/);
  }, 10_000);

  it('makes no call (and records no attempt) when the caller already aborted', async () => {
    const provider = new FakeProvider(scripted(fakeResponse()), 'openrouter');
    const c = new ModelClient({ models: [OR_A], providers: { openrouter: provider }, breaker: new CircuitBreaker() });
    const err = await failure(c.complete({ ...REQ, signal: AbortSignal.abort() }, { purpose: 'extract', budget: budget() }));
    expect(provider.calls).toHaveLength(0);
    expect(err.attempts).toEqual([]);
    expect(err.message).toMatch(/^aborted by the caller/);
  });
});

// ─────────────────────────────────────────────────────────────
// Reasoning preamble in the answer text
// ─────────────────────────────────────────────────────────────

describe('parse: leading reasoning block', () => {
  const schema = normalizeSchema({ title: 'string' });

  it('ignores a <think> block before the JSON, even with unbalanced braces inside', () => {
    const text = '<think>The title is in {"title" b3, I think</think>\n{"records":[{"title":{"v":"Hello","b":"b3"}}]}';
    const parsed = parseExtractionResponse(text, schema);
    expect(parsed.records).toEqual([{ title: { v: 'Hello', b: 'b3' } }]);
    expect(parsed.warnings).toContain('ignored a reasoning block before the JSON');
  });

  it('an unclosed <think> block means the answer was cut off', () => {
    expect(() => parseExtractionResponse('<think>Looking at {"records"', schema)).toThrow(
      expect.objectContaining({ category: 'output_truncated' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────
// Models without prices cannot be held to the cost cap
// ─────────────────────────────────────────────────────────────

describe('registry: unpriced models', () => {
  it('says the cost cap cannot be checked for an unknown model without prices', () => {
    const { warnings } = resolveModels({ GROQ_API_KEY: 'gsk_x', EXTRACT_MODELS: 'groq:mystery-model' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^unknown model groq:mystery-model: using conservative defaults .*; no token prices, so the cost cap is not checked/);

    const allCaps = { contextTokens: 32_000, maxOutputTokens: 4_000, jsonMode: 'json_object', strictSchema: false };
    const overridden = resolveModels({
      GROQ_API_KEY: 'gsk_x',
      EXTRACT_MODELS: 'groq:mystery-model,groq:priced-model',
      EXTRACT_MODEL_CAPS: JSON.stringify({ 'groq:mystery-model': allCaps, 'groq:priced-model': { ...allCaps, inputCostPerMTok: 0.1, outputCostPerMTok: 0.2 } }),
    });
    expect(overridden.warnings).toEqual([
      'unknown model groq:mystery-model: no token prices, so the cost cap is not checked before calls (set inputCostPerMTok/outputCostPerMTok)',
    ]);
  });

  it('known models and legacy defaults carry prices', () => {
    expect(resolveModels({ GROQ_API_KEY: 'gsk_x', OPENROUTER_API_KEY: 'sk-or-x', GEMINI_API_KEY: 'AIzaX', OPENAI_API_KEY: 'sk-x' }).warnings).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Errors embedded in a 200 body are charged only for reported usage
// ─────────────────────────────────────────────────────────────

describe('embedded errors without usage', () => {
  const PRICED_OR = fakeCaps({ provider: 'openrouter', model: 'p', contextTokens: 1_000_000, inputCostPerMTok: 1, outputCostPerMTok: 2 });
  const PRICED_GEMINI = fakeCaps({ provider: 'gemini', model: 'gemini-2.5-flash', contextTokens: 1_000_000, inputCostPerMTok: 1, outputCostPerMTok: 2 });
  const bigReq = { ...REQ, user: 'x'.repeat(160_000) }; // ~50k estimated tokens, ~$0.05 at $1/M

  function stub(body: unknown): typeof fetch {
    return (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  }

  it('OpenRouter upstream error in a 200 body carries no invented cost', async () => {
    const p = new OpenAICompatibleProvider({ name: 'openrouter', apiKey: 'sk-or-v1-0123456789abcdef', fetchImpl: stub({ error: { code: 502, message: 'Provider returned error' } }) });
    const err = await failure(p.complete(PRICED_OR, bigReq));
    expect(err.category).toBe('overloaded');
    expect(err.costUsd).toBeUndefined();
    expect(err.inputTokens).toBeUndefined();
  });

  it('reported usage on an embedded error is still charged', async () => {
    const p = new OpenAICompatibleProvider({
      name: 'openrouter',
      apiKey: 'sk-or-v1-0123456789abcdef',
      fetchImpl: stub({ error: { code: 502, message: 'Provider returned error' }, usage: { prompt_tokens: 1_000, completion_tokens: 10 } }),
    });
    const err = await failure(p.complete(PRICED_OR, bigReq));
    expect(err.inputTokens).toBe(1_000);
    expect(err.costUsd).toBeCloseTo((1_000 * 1 + 10 * 2) / 1e6, 12);
  });

  it('Gemini error in a 200 body carries no invented cost', async () => {
    const { GeminiProvider } = await import('../../src/extract/llm/providers/gemini.js');
    const p = new GeminiProvider({ apiKey: 'AIza0123456789abcdefghij', fetchImpl: stub({ error: { code: 503, message: 'The model is overloaded.' } }) });
    const err = await failure(p.complete(PRICED_GEMINI, bigReq));
    expect(err.category).toBe('overloaded');
    expect(err.costUsd).toBeUndefined();
  });

  it('a phantom charge does not use up the cap and block the fallback', async () => {
    const failing = new OpenAICompatibleProvider({ name: 'openrouter', apiKey: 'sk-or-v1-0123456789abcdef', fetchImpl: stub({ error: { code: 502, message: 'Provider returned error' } }) });
    const groqCaps = fakeCaps({ provider: 'groq', model: 'cheap', contextTokens: 1_000_000, inputCostPerMTok: 0.05, outputCostPerMTok: 0.08 });
    const groq = new FakeProvider(scripted(fakeResponse()), 'groq');
    const c = new ModelClient({ models: [PRICED_OR, groqCaps], providers: { openrouter: failing, groq }, breaker: new CircuitBreaker(), sleep: async () => undefined });
    const b = new Budget({ deadlineMs: Date.now() + 60_000, maxCostUsd: 0.06 });
    // ~$0.055 worst case fits the cap; the two failed OpenRouter calls cost nothing.
    const result = await c.complete({ ...REQ, user: 'x'.repeat(150_000), maxOutputTokens: 1_000 }, { purpose: 'extract', budget: b });
    expect(result.model.key).toBe(groqCaps.key);
    expect(result.attempts.map((a) => a.errorCategory ?? 'ok')).toEqual(['overloaded', 'overloaded', 'ok']);
    expect(result.attempts.slice(0, 2).map((a) => a.costUsd)).toEqual([0, 0]);
  });
});
