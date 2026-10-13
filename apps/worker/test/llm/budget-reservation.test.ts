// Concurrent calls on one budget (partitioned extraction runs several chunk
// calls at once): each call holds its worst-case cost while it runs, so the
// calls together cannot pass the cost cap.
import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/extract/llm/budget.js';
import { CircuitBreaker } from '../../src/extract/llm/breaker.js';
import { ModelClient } from '../../src/extract/llm/client.js';
import { fakeCaps, fakeResponse, FakeProvider } from '../../src/extract/llm/providers/fake.js';

describe('Budget.reserve', () => {
  it('holds spend until released, once', () => {
    const b = new Budget({ deadlineMs: Date.now() + 60_000, maxCostUsd: 1 });
    const release = b.reserve(0.4);
    expect(b.remainingUsd()).toBeCloseTo(0.6);
    release();
    release();
    expect(b.remainingUsd()).toBeCloseTo(1);
    expect(b.reservedUsd).toBe(0);
    b.reserve(Number.NaN)();
    b.reserve(-1)();
    expect(b.remainingUsd()).toBeCloseTo(1);
  });

  it('concurrent calls see each other in flight and stay within the cap', async () => {
    const caps = fakeCaps({ provider: 'openrouter', model: 'priced', contextTokens: 100_000, maxOutputTokens: 4_000, inputCostPerMTok: 0, outputCostPerMTok: 1_000 });
    const asked: number[] = [];
    let open: Array<() => void> = [];
    const fake = new FakeProvider(async (_c, req) => {
      asked.push(req.maxOutputTokens);
      await new Promise<void>((resolve) => open.push(resolve));
      return fakeResponse('{"records":[]}', { costUsd: (req.maxOutputTokens * 1_000) / 1_000_000 });
    }, 'openrouter');
    const client = new ModelClient({ models: [caps], providers: { openrouter: fake }, breaker: new CircuitBreaker() });
    // $5 affords 5,000 output tokens in all; each call asks for 2,000.
    const budget = new Budget({ deadlineMs: Date.now() + 60_000, maxCostUsd: 5 });
    const req = { system: 's', user: 'u', maxOutputTokens: 2_000 };
    const calls = [1, 2, 3].map(() => client.complete(req, { purpose: 'extract', budget, estimatedInputTokens: 10 }).catch((e: unknown) => e));
    await new Promise((r) => setTimeout(r, 20));
    // Third call could only afford what the first two left: 1,000 tokens.
    expect(asked).toEqual([2_000, 2_000, 1_000]);
    for (const resolve of open) resolve();
    open = [];
    await Promise.all(calls);
    expect(budget.spentUsd).toBeLessThanOrEqual(5);
    expect(budget.reservedUsd).toBe(0);
  });
});
