import { describe, expect, it } from 'vitest';
import { formatSummary, percentile, roundSummary, summarize, summarizeFields } from '../lib/stats.js';

describe('percentile (nearest rank)', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it('returns observed values with nearest-rank semantics', () => {
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile(hundred, 100)).toBe(100);
    // 1-in-100 tail must not be blended with the max.
    expect(percentile(hundred, 99.5)).toBe(100);
  });

  it('handles tiny inputs', () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([1, 2], 50)).toBe(1);
    expect(percentile([1, 2], 51)).toBe(2);
  });

  it('treats p<=0 as the minimum and clamps p>100', () => {
    expect(percentile(hundred, 0)).toBe(1);
    expect(percentile(hundred, -5)).toBe(1);
    expect(percentile(hundred, 250)).toBe(100);
  });

  it('returns NaN for no samples and rejects a non-finite p', () => {
    expect(percentile([], 50)).toBeNaN();
    expect(() => percentile(hundred, Number.NaN)).toThrow(RangeError);
    expect(() => percentile(hundred, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('summarize', () => {
  it('sorts numerically, not lexically', () => {
    const s = summarize([10, 9, 100, 1, 2]);
    expect(s.min).toBe(1);
    expect(s.max).toBe(100);
    expect(s.p50).toBe(9);
    expect(s.mean).toBeCloseTo(24.4);
  });

  it('drops NaN and infinities instead of poisoning the result', () => {
    const s = summarize([1, Number.NaN, 3, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
    expect(s.n).toBe(2);
    expect(s.mean).toBe(2);
    expect(s.max).toBe(3);
  });

  it('keeps negative values (clock-offset noise in phase splits)', () => {
    const s = summarize([-0.2, 0.1, 0.3]);
    expect(s.min).toBe(-0.2);
    expect(s.p50).toBe(0.1);
  });

  it('reports NaN fields for an empty or all-invalid input', () => {
    for (const input of [[], [Number.NaN, Number.NaN]]) {
      const s = summarize(input);
      expect(s.n).toBe(0);
      expect(s.mean).toBeNaN();
      expect(s.p50).toBeNaN();
      expect(s.max).toBeNaN();
    }
  });

  it('does not mutate the input', () => {
    const input = [3, 1, 2];
    summarize(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('roundSummary / summarizeFields / formatSummary', () => {
  it('rounds every field and leaves NaN alone', () => {
    const r = roundSummary({ n: 3, min: 1.23456, mean: Number.NaN, p50: 2.0004, p95: 2.9996, p99: 3, max: 3.00049 });
    expect(r).toEqual({ n: 3, min: 1.235, mean: Number.NaN, p50: 2, p95: 3, p99: 3, max: 3 });
  });

  it('summarizes each requested field independently', () => {
    const out = summarizeFields(
      [
        { a: 1, b: 10 },
        { a: 3, b: Number.NaN },
      ],
      ['a', 'b'],
    );
    expect(out.a.n).toBe(2);
    expect(out.a.mean).toBe(2);
    expect(out.b.n).toBe(1);
    expect(out.b.p50).toBe(10);
  });

  it('formats with n and n/a for missing values', () => {
    expect(formatSummary(summarize([1, 2, 3]), 'ms', 1)).toBe('p50 2.0 / p95 3.0 / p99 3.0 / max 3.0 ms (n=3)');
    expect(formatSummary(summarize([]))).toContain('p50 n/a');
  });
});
