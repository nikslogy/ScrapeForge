import { beforeEach, describe, expect, it } from 'vitest';
import {
  observeStages,
  observeTierAttempts,
  registry,
  stageDuration,
  tierAttemptDuration,
} from '../../src/metrics.js';
import { StageTracer } from '../../src/tracing.js';

type Labels = Record<string, string | number>;

async function series(
  metric: typeof stageDuration | typeof tierAttemptDuration,
  suffix: '_sum' | '_count',
): Promise<Array<{ labels: Labels; value: number }>> {
  const { values } = await metric.get();
  return values
    .filter((v) => v.metricName?.endsWith(suffix))
    .map((v) => ({ labels: v.labels as Labels, value: v.value }));
}

async function sumFor(
  metric: typeof stageDuration | typeof tierAttemptDuration,
  labels: Labels,
): Promise<number | undefined> {
  const rows = await series(metric, '_sum');
  return rows.find((r) => Object.entries(labels).every(([k, v]) => r.labels[k] === v))?.value;
}

describe('scrapeforge_stage_duration_seconds', () => {
  beforeEach(() => {
    stageDuration.reset();
    tierAttemptDuration.reset();
  });

  it('is registered on the worker registry with 1ms..60s buckets', async () => {
    const text = await registry.getSingleMetricAsString('scrapeforge_stage_duration_seconds');
    expect(text).toContain('# TYPE scrapeforge_stage_duration_seconds histogram');
    observeStages({ stages: { probe: 1 } });
    const { values } = await stageDuration.get();
    const buckets = values
      .filter((v) => v.metricName === 'scrapeforge_stage_duration_seconds_bucket')
      .map((v) => (v.labels as Labels).le);
    expect(buckets[0]).toBe(0.001);
    expect(buckets).toContain(60);
    expect(buckets.at(-1)).toBe('+Inf');
  });

  it('observes every stage in seconds', async () => {
    observeStages({ stages: { fetch: 1500, document: 12.5, llm: 2400 } });
    expect(await sumFor(stageDuration, { stage: 'fetch' })).toBeCloseTo(1.5);
    expect(await sumFor(stageDuration, { stage: 'document' })).toBeCloseTo(0.0125);
    expect(await sumFor(stageDuration, { stage: 'llm' })).toBeCloseTo(2.4);
    const counts = await series(stageDuration, '_count');
    expect(counts.every((c) => c.value === 1)).toBe(true);
  });

  it('records a StageTracer snapshot directly', async () => {
    let t = 0;
    const tracer = new StageTracer(() => t);
    const end = tracer.start('browser_acquire');
    t += 30;
    end();
    tracer.add('browser_acquire', 20);
    observeStages(tracer.snapshot());
    expect(await sumFor(stageDuration, { stage: 'browser_acquire' })).toBeCloseTo(0.05);
  });

  it('observes zero-duration stages and skips invalid ones', async () => {
    observeStages({
      stages: { zero: 0, nan: Number.NaN, neg: -5, inf: Number.POSITIVE_INFINITY },
    });
    const counts = await series(stageDuration, '_count');
    expect(counts.map((c) => c.labels.stage)).toEqual(['zero']);
  });

  it('does nothing for an empty snapshot', async () => {
    observeStages({ stages: {} });
    expect(await series(stageDuration, '_count')).toEqual([]);
  });
});

describe('scrapeforge_tier_attempt_duration_seconds', () => {
  beforeEach(() => tierAttemptDuration.reset());

  it('observes each attempt by tier and outcome', async () => {
    observeTierAttempts({
      attempts: [
        { tier: 1, ms: 120, outcome: 'rejected', reason: 'thin' },
        { tier: 2, ms: 80, outcome: 'error', reason: 'timeout' },
        { tier: 4, ms: 3000, outcome: 'accepted' },
      ],
    });
    expect(await sumFor(tierAttemptDuration, { tier: '1', outcome: 'rejected' })).toBeCloseTo(0.12);
    expect(await sumFor(tierAttemptDuration, { tier: '2', outcome: 'error' })).toBeCloseTo(0.08);
    expect(await sumFor(tierAttemptDuration, { tier: '4', outcome: 'accepted' })).toBeCloseTo(3);
  });

  it('skips attempts that would create unbounded or bogus series', async () => {
    observeTierAttempts({
      attempts: [
        { tier: 1.5, ms: 1, outcome: 'accepted' },
        { tier: -1, ms: 1, outcome: 'accepted' },
        { tier: 1e9, ms: 1, outcome: 'accepted' },
        { tier: 1, ms: 1, outcome: 'whatever' as 'accepted' },
        { tier: 1, ms: Number.NaN, outcome: 'accepted' },
      ],
    });
    expect(await series(tierAttemptDuration, '_count')).toEqual([]);
  });
});

// Kept last: the label cap is process-wide state.
describe('stage label cardinality', () => {
  it('folds stages beyond the label cap into "other"', async () => {
    stageDuration.reset();
    const stages: Record<string, number> = {};
    for (let i = 0; i < 200; i++) stages[`dynamic_${i}`] = 1;
    observeStages({ stages });
    const labels = new Set((await series(stageDuration, '_count')).map((c) => String(c.labels.stage)));
    expect(labels.size).toBeLessThanOrEqual(65);
    expect(labels.has('other')).toBe(true);

    // Stages that already have a label keep it once the cap is reached.
    stageDuration.reset();
    observeStages({ stages: { dynamic_0: 1, brand_new_stage: 1 } });
    const after = (await series(stageDuration, '_count')).map((c) => c.labels.stage).sort();
    expect(after).toEqual(['dynamic_0', 'other']);
  });
});
