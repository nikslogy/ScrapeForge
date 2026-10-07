import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/extract/llm/budget.js';
import { CircuitBreaker } from '../../src/extract/llm/breaker.js';
import { AUTH_TRIP_MS, ModelClient, QUOTA_TRIP_MS, type ModelClientOptions } from '../../src/extract/llm/client.js';
import type { LlmCallError } from '../../src/extract/llm/errors.js';
import { delay, fakeCaps, fakeError, fakeResponse, FakeProvider, scripted, type FakeStep } from '../../src/extract/llm/providers/fake.js';
import { LlmError, type LlmProvider, type LlmRequest, type ModelCapabilities } from '../../src/extract/types.js';

/** Manual clock: sleep() advances it instead of waiting. */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const OR_A = fakeCaps({ provider: 'openrouter', model: 'a', contextTokens: 100_000 });
const OR_B = fakeCaps({ provider: 'openrouter', model: 'b', contextTokens: 100_000 });
const GROQ = fakeCaps({ provider: 'groq', model: 'g', contextTokens: 100_000 });
const GEMINI = fakeCaps({ provider: 'gemini', model: 'm', contextTokens: 1_000_000 });

const REQ: LlmRequest = { system: 'sys', user: 'user', maxOutputTokens: 1_000 };

interface Setup {
  client: ModelClient;
  budget: Budget;
  breaker: CircuitBreaker;
  sleeps: number[];
  providers: Record<string, FakeProvider>;
  c: ReturnType<typeof clock>;
}

function setup(
  models: ModelCapabilities[],
  scripts: Partial<Record<ModelCapabilities['provider'], FakeStep[]>>,
  opts: { deadlineIn?: number; maxCostUsd?: number; client?: Partial<ModelClientOptions> } = {},
): Setup {
  const c = clock();
  const breaker = new CircuitBreaker({ now: c.now });
  const sleeps: number[] = [];
  const providers: Record<string, FakeProvider> = {};
  for (const [name, steps] of Object.entries(scripts)) {
    providers[name] = new FakeProvider(
      scripted(...(steps as FakeStep[]).map((s) =>
        // Each call takes 40 ms of (fake) time so latency is observable.
        typeof s === 'function' || s instanceof Error
          ? (caps: ModelCapabilities, req: LlmRequest, i: number) => {
              c.advance(40);
              if (s instanceof Error) throw s;
              return s(caps, req, i);
            }
          : () => {
              c.advance(40);
              return s;
            },
      )),
      name as ModelCapabilities['provider'],
    );
  }
  const client = new ModelClient({
    models,
    providers: providers as Partial<Record<ModelCapabilities['provider'], LlmProvider>>,
    breaker,
    now: c.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      c.advance(ms);
    },
    random: () => 0.5,
    ...opts.client,
  });
  const budget = new Budget({ deadlineMs: c.now() + (opts.deadlineIn ?? 120_000), maxCostUsd: opts.maxCostUsd, now: c.now });
  return { client, budget, breaker, sleeps, providers, c };
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

const ok = (text = '{"records":[]}', extra: Parameters<typeof fakeResponse>[1] = {}) => fakeResponse(text, extra);

describe('ModelClient', () => {
  it('returns the first successful response with one attempt record', async () => {
    const s = setup([OR_A, GROQ], { openrouter: [ok('{"records":[]}', { costUsd: 0.002, resolvedModel: 'up/a', resolvedProvider: 'X' })] });
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget, estimatedInputTokens: 500 });
    expect(result.response.text).toBe('{"records":[]}');
    expect(result.model.key).toBe(OR_A.key);
    expect(result.attempts).toEqual([
      {
        provider: 'openrouter',
        model: 'a',
        purpose: 'extract',
        ok: true,
        finishReason: 'stop',
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.002,
        latencyMs: 40,
        estimatedInputTokens: 500,
        jsonMode: 'json_object',
        resolvedModel: 'up/a',
        resolvedProvider: 'X',
      },
    ]);
    expect(s.budget.spentUsd).toBeCloseTo(0.002, 12);
    // The provider received the request plus an abort signal.
    const call = s.providers.openrouter.calls[0];
    expect(call.req.system).toBe('sys');
    expect(call.req.signal).toBeInstanceOf(AbortSignal);
  });

  it('auth: trips the provider for 5 min and continues with a different provider', async () => {
    const s = setup([OR_A, OR_B, GROQ], {
      openrouter: [fakeError('auth', { status: 401, provider: 'openrouter', model: 'a' })],
      groq: [ok()],
    });
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget });
    expect(result.model.key).toBe(GROQ.key);
    expect(result.attempts.map((a) => [a.model, a.ok, a.errorCategory])).toEqual([
      ['a', false, 'auth'],
      ['g', true, undefined],
    ]);
    expect(s.providers.openrouter.calls).toHaveLength(1);
    expect(s.breaker.get('openrouter')?.reason).toBe('auth');
    s.c.advance(AUTH_TRIP_MS - 41);
    expect(s.breaker.isOpen('openrouter')).toBe(true);
    s.c.advance(100);
    expect(s.breaker.isOpen('openrouter')).toBe(false);
  });

  it('quota: provider scope stops the provider, model scope only the model', async () => {
    const account = setup([OR_A, OR_B, GROQ], {
      openrouter: [fakeError('quota', { status: 402, scope: 'provider' })],
      groq: [ok()],
    });
    const r1 = await account.client.complete(REQ, { purpose: 'extract', budget: account.budget });
    expect(r1.model.key).toBe(GROQ.key);
    expect(account.breaker.isOpen('openrouter')).toBe(true);

    const perModel = setup([OR_A, OR_B, GROQ], {
      openrouter: [fakeError('quota', { status: 429, scope: 'model' }), ok()],
    });
    const r2 = await perModel.client.complete(REQ, { purpose: 'extract', budget: perModel.budget });
    expect(r2.model.key).toBe(OR_B.key);
    expect(perModel.breaker.isOpen(OR_A.key)).toBe(true);
    expect(perModel.breaker.isOpen('openrouter')).toBe(false);
    perModel.c.advance(QUOTA_TRIP_MS);
    expect(perModel.breaker.isOpen(OR_A.key)).toBe(false);
  });

  it('rate_limit: backs off with jitter, retries the same model once', async () => {
    const s = setup([OR_A, GROQ], { openrouter: [fakeError('rate_limit', { status: 429 }), ok()] });
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget });
    expect(result.model.key).toBe(OR_A.key);
    expect(s.sleeps).toEqual([1_000]); // 500 + 0.5 * 1000
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ ok: false, errorCategory: 'rate_limit', latencyMs: 40 });
    expect(result.attempts[1]).toMatchObject({ ok: true, note: 'retry after rate_limit (waited 1000 ms)' });
  });

  it('rate_limit: honours Retry-After, then falls back after a second failure', async () => {
    const s = setup([OR_A, GROQ], {
      openrouter: [fakeError('rate_limit', { retryAfterMs: 7_000 }), fakeError('overloaded')],
      groq: [ok()],
    });
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget });
    expect(s.sleeps).toEqual([7_000]);
    expect(result.model.key).toBe(GROQ.key);
    expect(result.attempts.map((a) => a.errorCategory ?? 'ok')).toEqual(['rate_limit', 'overloaded', 'ok']);
  });

  it('rate_limit: a Retry-After beyond 30 s trips the model instead of waiting', async () => {
    const s = setup([OR_A, GROQ], {
      openrouter: [fakeError('rate_limit', { retryAfterMs: 30_000, requestedRetryAfterMs: 3_600_000 })],
      groq: [ok()],
    });
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget });
    expect(s.sleeps).toEqual([]);
    expect(result.model.key).toBe(GROQ.key);
    // Tripped after the first call (40 ms in), for min(requested, 10 min).
    expect(s.breaker.get(OR_A.key)?.until).toBe(s.c.now() - 40 + QUOTA_TRIP_MS);
  });

  it('rate_limit: never sleeps past the deadline', async () => {
    const s = setup([OR_A, GROQ], {
      openrouter: [fakeError('rate_limit', { retryAfterMs: 5_000 })],
      groq: [ok()],
    }, { deadlineIn: 3_000 });
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget });
    expect(s.sleeps).toEqual([]);
    expect(result.model.key).toBe(GROQ.key);
  });

  it('timeout / network: one immediate retry, then the next model', async () => {
    const s = setup([OR_A, GROQ], {
      openrouter: [fakeError('timeout'), fakeError('network')],
      groq: [fakeError('network'), ok()],
    });
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget });
    expect(s.sleeps).toEqual([]);
    expect(result.attempts.map((a) => `${a.model}:${a.errorCategory ?? 'ok'}`)).toEqual(['a:timeout', 'a:network', 'g:network', 'g:ok']);
    expect(result.attempts[1].note).toBe('retry after timeout');
  });

  it('unsupported_request: retries once with a weaker JSON mode', async () => {
    const schemaModel = { ...OR_A, jsonMode: 'json_schema' as const };
    const s = setup([schemaModel, GROQ], { openrouter: [fakeError('unsupported_request', { status: 400 }), ok()] });
    const result = await s.client.complete({ ...REQ, responseSchema: { type: 'object' } }, { purpose: 'extract', budget: s.budget });
    expect(result.model.jsonMode).toBe('json_object');
    expect(s.providers.openrouter.calls.map((c) => c.caps.jsonMode)).toEqual(['json_schema', 'json_object']);
    expect(result.attempts[0]).toMatchObject({ jsonMode: 'json_schema', errorCategory: 'unsupported_request' });
    expect(result.attempts[1]).toMatchObject({
      ok: true,
      jsonMode: 'json_object',
      note: 'json mode downgraded from json_schema to json_object after unsupported_request',
    });
  });

  it('unsupported_request: only one downgrade per model; "none" cannot downgrade', async () => {
    const s = setup([{ ...OR_A, jsonMode: 'json_object' }, { ...GROQ, jsonMode: 'none' }, GEMINI], {
      openrouter: [fakeError('unsupported_request'), fakeError('unsupported_request')],
      groq: [fakeError('unsupported_request')],
      gemini: [ok()],
    });
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget });
    expect(s.providers.openrouter.calls.map((c) => c.caps.jsonMode)).toEqual(['json_object', 'none']);
    expect(s.providers.groq.calls).toHaveLength(1);
    expect(result.model.key).toBe(GEMINI.key);
  });

  it('input_too_large: moves only to a model with a larger context, else throws', async () => {
    const s = setup([OR_A, GROQ, GEMINI], {
      openrouter: [fakeError('input_too_large', { status: 413 })],
      gemini: [ok()],
    });
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget });
    expect(result.model.key).toBe(GEMINI.key);
    expect(s.providers.groq).toBeUndefined();

    const t = setup([OR_A, GROQ], { openrouter: [fakeError('input_too_large', { status: 413 })], groq: [ok()] });
    const err = await failure(t.client.complete(REQ, { purpose: 'extract', budget: t.budget }));
    expect(err.category).toBe('input_too_large');
    expect(err.attempts).toHaveLength(1);
    expect(t.providers.groq.calls).toHaveLength(0);
    expect(err.message).toContain('context window not larger');
  });

  it('skips models whose context cannot hold the estimated input plus output', async () => {
    const small = fakeCaps({ provider: 'openrouter', model: 'small', contextTokens: 8_000 });
    const s = setup([small, GEMINI], { gemini: [ok()] });
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget, estimatedInputTokens: 7_500 });
    expect(result.model.key).toBe(GEMINI.key);
    expect(result.attempts).toHaveLength(1);

    const only = setup([small], { openrouter: [] });
    const err = await failure(only.client.complete(REQ, { purpose: 'extract', budget: only.budget, estimatedInputTokens: 7_500 }));
    expect(err.category).toBe('input_too_large');
    expect(err.attempts).toEqual([]);
  });

  it('uses the capped output size for the context check', async () => {
    const tight = fakeCaps({ provider: 'openrouter', model: 'tight', contextTokens: 10_000, maxOutputTokens: 1_000 });
    const s = setup([tight], { openrouter: [ok()] });
    // 8 500 + min(50 000, 1 000) fits in 10 000.
    await s.client.complete({ ...REQ, maxOutputTokens: 50_000 }, { purpose: 'extract', budget: s.budget, estimatedInputTokens: 8_500 });
    expect(s.providers.openrouter.calls).toHaveLength(1);
  });

  it('finish_reason length: throws output_truncated without trying other models', async () => {
    const s = setup([OR_A, GROQ], {
      openrouter: [ok('{"records":[{"a"', { finishReason: 'length', outputTokens: 1_000, costUsd: 0.01 })],
      groq: [ok()],
    });
    const err = await failure(s.client.complete(REQ, { purpose: 'extract', budget: s.budget }));
    expect(err.category).toBe('output_truncated');
    expect(err.attempts).toEqual([expect.objectContaining({ ok: false, errorCategory: 'output_truncated', finishReason: 'length', outputTokens: 1_000 })]);
    expect(s.providers.groq.calls).toHaveLength(0);
    expect(s.budget.spentUsd).toBeCloseTo(0.01, 12);
  });

  it('content_filter: throws at once', async () => {
    const s = setup([OR_A, GROQ], { openrouter: [ok('', { finishReason: 'content_filter' })], groq: [ok()] });
    const err = await failure(s.client.complete(REQ, { purpose: 'extract', budget: s.budget }));
    expect(err.category).toBe('content_filter');
    expect(s.providers.groq.calls).toHaveLength(0);
  });

  it('empty_output / unknown: falls through to the next model', async () => {
    const s = setup([OR_A, OR_B, GROQ], {
      openrouter: [fakeError('empty_output', { inputTokens: 50, costUsd: 0.001 }), fakeError('unknown', { status: 404 })],
      groq: [ok()],
    });
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget });
    expect(result.model.key).toBe(GROQ.key);
    expect(result.attempts[0]).toMatchObject({ errorCategory: 'empty_output', inputTokens: 50, costUsd: 0.001 });
    // Failed calls that report usage are charged.
    expect(s.budget.spentUsd).toBeCloseTo(0.001, 12);
  });

  it('throws an aggregated error with every attempt when all models fail', async () => {
    const s = setup([OR_A, GROQ], {
      openrouter: [fakeError('unknown', { message: 'first failure' })],
      groq: [fakeError('overloaded'), fakeError('overloaded', { status: 503, message: 'still overloaded' })],
    });
    const err = await failure(s.client.complete(REQ, { purpose: 'repair', budget: s.budget }));
    expect(err.category).toBe('overloaded');
    expect(err.status).toBe(503);
    expect(err.attempts?.map((a) => a.errorCategory)).toEqual(['unknown', 'overloaded', 'overloaded']);
    expect(err.attempts?.every((a) => a.purpose === 'repair')).toBe(true);
    expect(err.message).toMatch(/^all models failed \(3 attempts\); last error: still overloaded/);
  });

  it('checks the budget before every attempt', async () => {
    const expired = setup([OR_A], { openrouter: [ok()] }, { deadlineIn: 0 });
    const e1 = await failure(expired.client.complete(REQ, { purpose: 'extract', budget: expired.budget }));
    expect(e1.category).toBe('budget_exhausted');
    expect(expired.providers.openrouter.calls).toHaveLength(0);

    const capped = setup([OR_A, GROQ], {
      openrouter: [fakeError('unknown', { costUsd: 0.05, inputTokens: 1 })],
      groq: [ok()],
    }, { maxCostUsd: 0.05 });
    const e2 = await failure(capped.client.complete(REQ, { purpose: 'extract', budget: capped.budget }));
    expect(e2.category).toBe('budget_exhausted');
    expect(e2.message).toContain('cost cap');
    expect(e2.attempts).toHaveLength(1);
    expect(capped.providers.groq.calls).toHaveLength(0);
  });

  it('falls back to registry rates when the provider reports no valid cost', async () => {
    const priced = { ...OR_A, inputCostPerMTok: 2, outputCostPerMTok: 10 };
    const s = setup([priced], { openrouter: [ok('{}', { costUsd: Number.NaN, inputTokens: 1_000, outputTokens: 100 })] });
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget });
    expect(result.response.costUsd).toBeCloseTo((1_000 * 2 + 100 * 10) / 1e6, 12);
    expect(s.budget.spentUsd).toBeCloseTo(0.003, 12);
  });

  it('skips models behind an open breaker and reports the breaker category when nothing ran', async () => {
    const s = setup([OR_A, GROQ], { openrouter: [ok()], groq: [ok()] });
    s.breaker.trip('openrouter', 60_000, 'auth');
    s.breaker.trip(GROQ.key, 60_000, 'quota');
    const err = await failure(s.client.complete(REQ, { purpose: 'extract', budget: s.budget }));
    expect(err.category).toBe('quota');
    expect(err.message).toContain('circuit open: auth');
    expect(err.attempts).toEqual([]);
  });

  it('skips models without a provider adapter and handles an empty model list', async () => {
    const s = setup([GEMINI, GROQ], { groq: [ok()] });
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget });
    expect(result.model.key).toBe(GROQ.key);

    const none = setup([], {});
    const err = await failure(none.client.complete(REQ, { purpose: 'extract', budget: none.budget }));
    expect(err.message).toBe('no models configured');
    expect(err.category).toBe('unknown');
  });

  it('enforces the per-call timeout even if the provider ignores the signal', async () => {
    let calls = 0;
    const hanging: LlmProvider = {
      name: 'openrouter',
      complete: () => {
        calls++;
        return new Promise(() => undefined);
      },
    };
    const client = new ModelClient({
      models: [OR_A],
      providers: { openrouter: hanging },
      breaker: new CircuitBreaker(),
      perCallTimeoutMs: 30,
    });
    const started = Date.now();
    const err = await failure(client.complete(REQ, { purpose: 'extract', budget: new Budget({ deadlineMs: Date.now() + 5_000 }) }));
    expect(err.category).toBe('timeout');
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('aborts the provider call at the budget deadline', async () => {
    const provider = new FakeProvider(async (_caps, req) => {
      await delay(5_000, req.signal);
      return fakeResponse();
    }, 'openrouter');
    const client = new ModelClient({ models: [OR_A], providers: { openrouter: provider }, breaker: new CircuitBreaker() });
    const started = Date.now();
    const err = await failure(client.complete(REQ, { purpose: 'extract', budget: new Budget({ deadlineMs: Date.now() + 80 }) }));
    // The first call times out at the deadline; the retry finds the budget spent.
    expect(['timeout', 'budget_exhausted']).toContain(err.category);
    expect(err.attempts?.[0]).toMatchObject({ ok: false, errorCategory: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    const s = setup([OR_A, GROQ], {
      openrouter: [
        () => {
          controller.abort();
          throw fakeError('network');
        },
      ],
      groq: [ok()],
    });
    const err = await failure(s.client.complete({ ...REQ, signal: controller.signal }, { purpose: 'extract', budget: s.budget }));
    expect(err.attempts).toHaveLength(1);
    expect(err.message).toMatch(/^aborted by the caller \(1 attempt\); last error: /);
    expect(s.providers.groq.calls).toHaveLength(0);
  });

  it('treats non-LlmError throws and malformed responses as failures, not crashes', async () => {
    const s = setup([OR_A, OR_B, GROQ], {
      openrouter: [
        () => {
          throw new TypeError('fetch failed');
        },
        () => {
          throw new TypeError('fetch failed');
        },
      ],
      groq: [() => ({ nope: true }) as never, ok()],
    });
    // network → retry → next model (same provider allowed) → but OR_B hits the script end.
    const err = await failure(s.client.complete(REQ, { purpose: 'extract', budget: s.budget }));
    expect(err.attempts?.[0].errorCategory).toBe('network');
    expect(err.attempts?.some((a) => a.provider === 'groq' && a.errorCategory === 'unknown')).toBe(true);
  });

  it('exposes configuration warnings and models', () => {
    const client = new ModelClient({ models: [OR_A], providers: {}, warnings: ['w1'] });
    expect(client.warnings).toEqual(['w1']);
    expect(client.models).toEqual([OR_A]);
  });
});
