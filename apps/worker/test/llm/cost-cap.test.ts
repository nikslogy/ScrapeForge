import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/extract/llm/budget.js';
import { CircuitBreaker } from '../../src/extract/llm/breaker.js';
import { ModelClient } from '../../src/extract/llm/client.js';
import type { LlmCallError } from '../../src/extract/llm/errors.js';
import { estimateCostUsd } from '../../src/extract/llm/registry.js';
import { fakeCaps, fakeError, fakeResponse, FakeProvider, scripted, type FakeStep } from '../../src/extract/llm/providers/fake.js';
import { LlmError, type LlmProvider, type LlmRequest, type ModelCapabilities } from '../../src/extract/types.js';

// $0.40 / $1.60 per million tokens (gpt-4.1-mini list prices).
const PRICED = fakeCaps({ provider: 'openrouter', model: 'priced', contextTokens: 1_000_000, maxOutputTokens: 32_768, inputCostPerMTok: 0.4, outputCostPerMTok: 1.6 });
const FREE = fakeCaps({ provider: 'groq', model: 'free', contextTokens: 1_000_000, maxOutputTokens: 32_768, inputCostPerMTok: 0, outputCostPerMTok: 0 });
const REQ: LlmRequest = { system: 'sys', user: 'user', maxOutputTokens: 8_000 };

function setup(models: ModelCapabilities[], scripts: Partial<Record<ModelCapabilities['provider'], FakeStep[]>>, maxCostUsd?: number) {
  const providers: Record<string, FakeProvider> = {};
  for (const [name, steps] of Object.entries(scripts)) {
    providers[name] = new FakeProvider(scripted(...(steps as FakeStep[])), name as ModelCapabilities['provider']);
  }
  const client = new ModelClient({
    models,
    providers: providers as Partial<Record<ModelCapabilities['provider'], LlmProvider>>,
    breaker: new CircuitBreaker(),
    sleep: async () => undefined,
  });
  const budget = new Budget({ deadlineMs: Date.now() + 60_000, ...(maxCostUsd !== undefined ? { maxCostUsd } : {}) });
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

/** Worst-case cost of a call as the provider would bill it at registry rates. */
function worstCase(caps: ModelCapabilities, inputTokens: number, maxOutputTokens: number): number {
  return estimateCostUsd(caps, inputTokens, Math.min(maxOutputTokens, caps.maxOutputTokens));
}

describe('ModelClient cost cap', () => {
  it('refuses a call whose input alone exceeds the cap: budget_exhausted before calling', async () => {
    // The review scenario: 100k input tokens at $0.40/M is $0.04, 40x a $0.001 cap.
    const s = setup([PRICED], { openrouter: [fakeResponse('{"records":[]}', { costUsd: 0.04 })] }, 0.001);
    const err = await failure(s.client.complete(REQ, { purpose: 'extract', budget: s.budget, estimatedInputTokens: 100_000 }));
    expect(err.category).toBe('budget_exhausted');
    expect(err.message).toContain('cost cap');
    expect(err.attempts).toEqual([]);
    expect(s.providers.openrouter.calls).toHaveLength(0);
    expect(s.budget.spentUsd).toBe(0);
  });

  it('lowers maxOutputTokens so the worst case fits the remaining budget', async () => {
    const s = setup([PRICED], { openrouter: [fakeResponse()] }, 0.01);
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget, estimatedInputTokens: 10_000 });
    const sent = s.providers.openrouter.calls[0].req.maxOutputTokens;
    expect(sent).toBeLessThan(REQ.maxOutputTokens);
    // Uses the room: within ~10% input margin of the exact limit, never over it.
    expect(worstCase(PRICED, 10_000, sent)).toBeLessThanOrEqual(0.01);
    expect(sent).toBeGreaterThan(3_000);
    expect(result.attempts[0].note).toBe(`maxOutputTokens lowered from 8000 to ${sent} by the cost cap`);
  });

  it('leaves the request alone when the worst case fits', async () => {
    const s = setup([PRICED], { openrouter: [fakeResponse()] }, 0.05);
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget, estimatedInputTokens: 10_000 });
    expect(s.providers.openrouter.calls[0].req.maxOutputTokens).toBe(8_000);
    expect(result.attempts[0].note).toBeUndefined();
  });

  it('refuses when the room left would allow only a uselessly small answer', async () => {
    // Input ~ $0.0044 with margin; $0.0001 leaves ~60 output tokens.
    const s = setup([PRICED], { openrouter: [fakeResponse()] }, 0.0045);
    const err = await failure(s.client.complete(REQ, { purpose: 'extract', budget: s.budget, estimatedInputTokens: 10_000 }));
    expect(err.category).toBe('budget_exhausted');
    expect(s.providers.openrouter.calls).toHaveLength(0);
  });

  it('falls back to a model the budget can afford', async () => {
    const s = setup([PRICED, FREE], { openrouter: [fakeResponse()], groq: [fakeResponse()] }, 0.001);
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget, estimatedInputTokens: 100_000 });
    expect(result.model.key).toBe(FREE.key);
    expect(s.providers.openrouter.calls).toHaveLength(0);
    expect(s.providers.groq.calls[0].req.maxOutputTokens).toBe(8_000);
  });

  it('sizes a retry by what earlier attempts left', async () => {
    const s = setup([PRICED], {
      openrouter: [fakeError('network', { costUsd: 0.012 }), fakeResponse()],
    }, 0.02);
    const result = await s.client.complete(REQ, { purpose: 'extract', budget: s.budget, estimatedInputTokens: 2_000 });
    const [first, second] = s.providers.openrouter.calls.map((c) => c.req.maxOutputTokens);
    // $0.0009 input + $0.0128 output fits $0.02; after $0.012 spent it does not.
    expect(first).toBe(8_000);
    expect(worstCase(PRICED, 2_000, second)).toBeLessThanOrEqual(0.02 - 0.012);
    expect(second).toBeLessThan(first);
    expect(result.attempts[1].note).toMatch(/^retry after network; maxOutputTokens lowered from 8000 to \d+ by the cost cap$/);
  });

  it('reports budget_exhausted when the cap stops further attempts after a failure', async () => {
    const s = setup([PRICED], { openrouter: [fakeError('network', { costUsd: 0.0095 }), fakeResponse()] }, 0.01);
    const err = await failure(s.client.complete(REQ, { purpose: 'extract', budget: s.budget, estimatedInputTokens: 2_000 }));
    expect(err.category).toBe('budget_exhausted');
    expect(err.attempts).toHaveLength(1);
    expect(s.providers.openrouter.calls).toHaveLength(1);
    expect(err.message).toContain('last error: fake network');
  });

  it('estimates the input itself when the caller gives no estimate', async () => {
    // ~40k tokens of user text at $0.40/M is ~$0.016 > $0.01.
    const s = setup([PRICED], { openrouter: [fakeResponse()] }, 0.01);
    const big = { ...REQ, user: 'x'.repeat(128_000) };
    const err = await failure(s.client.complete(big, { purpose: 'extract', budget: s.budget }));
    expect(err.category).toBe('budget_exhausted');
    expect(s.providers.openrouter.calls).toHaveLength(0);
  });

  it('counts the response schema in json_schema mode', async () => {
    const schemaModel = { ...PRICED, jsonMode: 'json_schema' as const };
    const schema = { type: 'object', properties: { pad: { type: 'string', description: 'y'.repeat(64_000) } } };
    // 20k tokens of schema alone: $0.0088 with margin; output then has < 256 tokens of room.
    const s = setup([schemaModel], { openrouter: [fakeResponse()] }, 0.009);
    const err = await failure(s.client.complete({ ...REQ, responseSchema: schema }, { purpose: 'extract', budget: s.budget }));
    expect(err.category).toBe('budget_exhausted');
  });

  it('does not limit calls without a cap or for models without prices', async () => {
    const unpriced = fakeCaps({ provider: 'openrouter', model: 'unpriced', contextTokens: 1_000_000 });
    const capped = setup([unpriced], { openrouter: [fakeResponse()] }, 0.001);
    await capped.client.complete(REQ, { purpose: 'extract', budget: capped.budget, estimatedInputTokens: 100_000 });
    expect(capped.providers.openrouter.calls[0].req.maxOutputTokens).toBe(8_000);

    const uncapped = setup([PRICED], { openrouter: [fakeResponse()] });
    await uncapped.client.complete(REQ, { purpose: 'extract', budget: uncapped.budget, estimatedInputTokens: 100_000 });
    expect(uncapped.providers.openrouter.calls[0].req.maxOutputTokens).toBe(8_000);
  });
});

describe('budget_exhausted from the cost cap tells the caller what input would fit', () => {
  it('reports affordableInputTokens for the requested output limit', async () => {
    const s = setup([PRICED], { openrouter: [] }, 0.05);
    const err = await failure(s.client.complete(REQ, { purpose: 'extract', budget: s.budget, estimatedInputTokens: 200_000 }));
    expect(err.category).toBe('budget_exhausted');
    // ($0.05 - 8000 x $1.60/M) / ($0.40/M x 1.1) = 84 545 tokens.
    expect(err.affordableInputTokens).toBeGreaterThan(84_000);
    expect(err.affordableInputTokens).toBeLessThanOrEqual(84_545);

    // An input of that size is accepted with the full output limit.
    const t = setup([PRICED], { openrouter: [fakeResponse()] }, 0.05);
    await t.client.complete(REQ, { purpose: 'extract', budget: t.budget, estimatedInputTokens: err.affordableInputTokens as number });
    expect(t.providers.openrouter.calls[0].req.maxOutputTokens).toBe(8_000);
  });

  it('takes the most generous of the skipped models, and 0 when nothing fits', async () => {
    const cheaper = { ...PRICED, key: 'openrouter:cheaper', model: 'cheaper', inputCostPerMTok: 0.1, outputCostPerMTok: 0.4 };
    const s = setup([PRICED, cheaper], { openrouter: [] }, 0.05);
    const err = await failure(s.client.complete(REQ, { purpose: 'extract', budget: s.budget, estimatedInputTokens: 900_000 }));
    // ($0.05 - 8000 x $0.40/M) / ($0.10/M x 1.1) = 425 454 tokens.
    expect(err.affordableInputTokens).toBeGreaterThan(425_000);
    expect(err.affordableInputTokens).toBeLessThanOrEqual(425_454);

    const tiny = setup([PRICED], { openrouter: [] }, 0.01);
    const none = await failure(tiny.client.complete(REQ, { purpose: 'extract', budget: tiny.budget, estimatedInputTokens: 900_000 }));
    expect(none.affordableInputTokens).toBe(0);
  });
});

describe('Budget.remainingUsd', () => {
  it('is the cap minus spend, never negative, and infinite without a cap', () => {
    const b = new Budget({ deadlineMs: Date.now() + 1_000, maxCostUsd: 0.01 });
    b.charge(0.004);
    expect(b.remainingUsd()).toBeCloseTo(0.006, 12);
    b.charge(0.01);
    expect(b.remainingUsd()).toBe(0);
    expect(new Budget({ deadlineMs: Date.now() + 1_000 }).remainingUsd()).toBe(Number.POSITIVE_INFINITY);
  });
});
