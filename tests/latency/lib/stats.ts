// Latency statistics for the measurement harness.
//
// Percentiles use the nearest-rank method (no interpolation): the reported
// value is always one that was actually observed, which keeps a p99 over 100
// samples honest (it is the 99th smallest sample, not a blend with the max).

export interface Summary {
  n: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/**
 * Nearest-rank percentile of an ascending-sorted array.
 * `p` is in (0, 100]; p=0 is treated as the minimum.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (!Number.isFinite(p)) throw new RangeError(`percentile must be finite, got ${p}`);
  const clamped = Math.min(100, Math.max(0, p));
  const rank = Math.ceil((clamped / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Summary of a set of samples. Non-finite samples (NaN from a missing
 * timestamp, Infinity) are dropped rather than poisoning the mean; callers
 * that care can compare `n` with the input length.
 */
export function summarize(samples: readonly number[]): Summary {
  const finite = samples.filter((x) => Number.isFinite(x));
  const sorted = Float64Array.from(finite).sort();
  const values = Array.from(sorted);
  const n = values.length;
  let sum = 0;
  for (const v of values) sum += v;
  return {
    n,
    min: n ? values[0] : Number.NaN,
    mean: n ? sum / n : Number.NaN,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: n ? values[n - 1] : Number.NaN,
  };
}

/** Rounds every numeric field to `digits` decimals (for JSON output). */
export function roundSummary(s: Summary, digits = 3): Summary {
  const f = 10 ** digits;
  const r = (x: number) => (Number.isFinite(x) ? Math.round(x * f) / f : x);
  return {
    n: s.n,
    min: r(s.min),
    mean: r(s.mean),
    p50: r(s.p50),
    p95: r(s.p95),
    p99: r(s.p99),
    max: r(s.max),
  };
}

/**
 * Summarizes each numeric field of a list of records separately, e.g.
 * per-phase timings of queue jobs. Only keys present in `fields` are read.
 */
export function summarizeFields<K extends string>(
  records: ReadonlyArray<Readonly<Record<K, number>>>,
  fields: readonly K[],
): Record<K, Summary> {
  const out = {} as Record<K, Summary>;
  for (const field of fields) {
    out[field] = roundSummary(summarize(records.map((r) => r[field])));
  }
  return out;
}

/** "p50 1.23 / p95 4.56 / p99 7.89 / max 9.99 ms (n=100)" */
export function formatSummary(s: Summary, unit = 'ms', digits = 2): string {
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(digits) : 'n/a');
  return `p50 ${f(s.p50)} / p95 ${f(s.p95)} / p99 ${f(s.p99)} / max ${f(s.max)} ${unit} (n=${s.n})`;
}
