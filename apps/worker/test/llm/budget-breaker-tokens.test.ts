import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/extract/llm/budget.js';
import { CircuitBreaker } from '../../src/extract/llm/breaker.js';
import { effectiveMaxOutput, estimateTokens, MESSAGE_OVERHEAD_TOKENS, planInputBudget } from '../../src/extract/llm/tokens.js';

describe('Budget', () => {
  it('tracks remaining time on the injected clock', () => {
    let t = 1_000;
    const b = new Budget({ deadlineMs: 6_000, now: () => t });
    expect(b.remainingMs()).toBe(5_000);
    expect(b.canSpend()).toBe(true);
    t = 6_000;
    expect(b.remainingMs()).toBe(0);
    expect(b.canSpend()).toBe(false);
    t = 9_000;
    expect(b.remainingMs()).toBe(0);
  });

  it('charges cost and stops at the cap', () => {
    const b = new Budget({ deadlineMs: Date.now() + 60_000, maxCostUsd: 0.01 });
    b.charge(0.004);
    b.charge(Number.NaN);
    b.charge(-1);
    b.charge(Number.POSITIVE_INFINITY);
    expect(b.spentUsd).toBeCloseTo(0.004, 12);
    expect(b.canSpend()).toBe(true);
    b.charge(0.006);
    expect(b.canSpend()).toBe(false);
  });

  it('allows nothing with a zero cap and everything without a cap', () => {
    expect(new Budget({ deadlineMs: Date.now() + 1_000, maxCostUsd: 0 }).canSpend()).toBe(false);
    const free = new Budget({ deadlineMs: Date.now() + 1_000 });
    free.charge(1_000);
    expect(free.canSpend()).toBe(true);
  });

  it('rejects invalid options', () => {
    expect(() => new Budget({ deadlineMs: Number.NaN })).toThrow(RangeError);
    expect(() => new Budget({ deadlineMs: 1, maxCostUsd: -1 })).toThrow(RangeError);
  });

  it('signal() is already aborted after the deadline', () => {
    const b = new Budget({ deadlineMs: 0, now: () => 10 });
    const s = b.signal(60_000);
    expect(s.aborted).toBe(true);
    expect((s.reason as DOMException).name).toBe('TimeoutError');
  });

  it('signal() fires at min(deadline, cap)', async () => {
    const capped = new Budget({ deadlineMs: Date.now() + 60_000 }).signal(30);
    const byDeadline = new Budget({ deadlineMs: Date.now() + 30 }).signal(60_000);
    expect(capped.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    expect(capped.aborted).toBe(true);
    expect(byDeadline.aborted).toBe(true);
  });

  it('signal() tolerates huge or invalid caps', () => {
    const b = new Budget({ deadlineMs: Date.now() + 1_000 });
    expect(b.signal(Number.POSITIVE_INFINITY).aborted).toBe(false);
    expect(b.signal(Number.NaN).aborted).toBe(false);
    expect(new Budget({ deadlineMs: Number.MAX_SAFE_INTEGER }).signal(Number.MAX_SAFE_INTEGER).aborted).toBe(false);
  });
});

describe('CircuitBreaker', () => {
  it('opens for the given duration on the injected clock', () => {
    let t = 0;
    const b = new CircuitBreaker({ now: () => t });
    b.trip('openrouter', 1_000, 'auth');
    expect(b.isOpen('openrouter')).toBe(true);
    expect(b.get('openrouter')).toEqual({ until: 1_000, reason: 'auth' });
    expect(b.isOpen('groq')).toBe(false);
    t = 999;
    expect(b.isOpen('openrouter')).toBe(true);
    t = 1_000;
    expect(b.isOpen('openrouter')).toBe(false);
    expect(b.size).toBe(0);
  });

  it('never shortens an existing trip', () => {
    let t = 0;
    const b = new CircuitBreaker({ now: () => t });
    b.trip('k', 10_000, 'quota');
    b.trip('k', 1_000, 'rate_limit');
    expect(b.get('k')).toEqual({ until: 10_000, reason: 'quota' });
    t = 5_000;
    b.trip('k', 20_000, 'auth');
    expect(b.get('k')).toEqual({ until: 25_000, reason: 'auth' });
  });

  it('ignores invalid durations and resets', () => {
    const b = new CircuitBreaker();
    b.trip('a', 0, 'x');
    b.trip('a', -5, 'x');
    b.trip('a', Number.NaN, 'x');
    expect(b.isOpen('a')).toBe(false);
    b.trip('a', 1_000, 'x');
    b.trip('b', 1_000, 'x');
    b.reset('a');
    expect(b.isOpen('a')).toBe(false);
    expect(b.isOpen('b')).toBe(true);
    b.reset();
    expect(b.size).toBe(0);
  });

  it('bounds remembered keys', () => {
    const b = new CircuitBreaker({ maxEntries: 3 });
    for (const k of ['a', 'b', 'c', 'd']) b.trip(k, 60_000, 'x');
    expect(b.size).toBe(3);
    expect(b.isOpen('a')).toBe(false);
    expect(b.isOpen('d')).toBe(true);
  });
});

describe('estimateTokens', () => {
  it('is conservative for ASCII (~3.2 chars per token)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(32))).toBe(10);
    expect(estimateTokens('[b12] £51.77 {class=price_color}')).toBeGreaterThanOrEqual(10);
  });

  it('counts non-Latin scripts heavier', () => {
    expect(estimateTokens('日本語のテキスト')).toBe(8);
    expect(estimateTokens('Привет мир')).toBe(Math.ceil(9 / 2 + 1 / 3.2));
    expect(estimateTokens('😀')).toBe(2);
  });

  it('is fast on large input', () => {
    const big = 'x'.repeat(5_000_000);
    const started = performance.now();
    expect(estimateTokens(big)).toBe(Math.ceil(5_000_000 / 3.2));
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('planInputBudget / effectiveMaxOutput', () => {
  const caps = { contextTokens: 100_000, maxOutputTokens: 8_000 };

  it('subtracts margin, output reservation and fixed text', () => {
    const system = 'x'.repeat(3_200); // 1 000 tokens
    const budget = planInputBudget(caps, { systemText: system, schemaText: '', reservedOutputTokens: 4_000 });
    expect(budget).toBe(90_000 - 4_000 - 1_000 - MESSAGE_OVERHEAD_TOKENS);
  });

  it('caps the output reservation at the model output limit', () => {
    const a = planInputBudget(caps, { systemText: '', schemaText: '', reservedOutputTokens: 50_000, safetyMargin: 0 });
    expect(a).toBe(100_000 - 8_000 - MESSAGE_OVERHEAD_TOKENS);
  });

  it('clamps the margin and never returns a negative budget', () => {
    expect(planInputBudget(caps, { systemText: '', schemaText: '', reservedOutputTokens: 0, safetyMargin: 5 })).toBe(
      10_000 - MESSAGE_OVERHEAD_TOKENS,
    );
    expect(planInputBudget(caps, { systemText: '', schemaText: '', reservedOutputTokens: -100, safetyMargin: -1 })).toBe(
      100_000 - MESSAGE_OVERHEAD_TOKENS,
    );
    expect(planInputBudget({ contextTokens: 1_000, maxOutputTokens: 900 }, { systemText: 'x'.repeat(10_000), schemaText: '', reservedOutputTokens: 900 })).toBe(0);
  });

  it('effectiveMaxOutput caps the ask and stays positive', () => {
    expect(effectiveMaxOutput(caps, 100_000)).toBe(8_000);
    expect(effectiveMaxOutput(caps, 1_234.9)).toBe(1_234);
    expect(effectiveMaxOutput(caps, 0)).toBe(1);
    expect(effectiveMaxOutput(caps, Number.NaN)).toBe(8_000);
  });
});
