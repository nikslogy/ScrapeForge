/* eslint-disable no-console */
/**
 * Part 4.C — Performance percentile harness.
 *
 * Runs N requests per scenario (sequential + bounded-concurrent) and reports
 * P50 / P95 / P99 / max latency per tier class. Honest latency numbers — we
 * measure wall-clock time of the HTTP round-trip as observed by the client.
 *
 * Run:
 *   $env:API_KEY="sf_live_..."; npx tsx tests/perf/percentiles.ts
 *   # optional: control run count
 *   $env:RUNS="100"; npx tsx tests/perf/percentiles.ts
 */

const API = process.env.API_BASE || 'http://localhost:3000';
const KEY = process.env.API_KEY || process.env.TEST_API_KEY;
const RUNS = Number(process.env.RUNS || 50);
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);

if (!KEY) {
  console.error('Missing env API_KEY. Export sf_live_... and rerun.');
  process.exit(1);
}

interface Scenario {
  name: string;
  body: Record<string, unknown>;
  /** Used to group percentile output. */
  category: 'cached' | 'tier1' | 'tier4-simple' | 'tier4-spa';
  /** Skip cache-warmup for cache scenario. */
  warmCache?: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'tier1-example',
    category: 'tier1',
    body: { url: 'https://example.com', formats: ['markdown'], cacheTtl: 0 },
  },
  {
    name: 'tier1-wikipedia',
    category: 'tier1',
    body: {
      url: 'https://en.wikipedia.org/wiki/Web_scraping',
      formats: ['markdown'],
      cacheTtl: 0,
    },
  },
  {
    name: 'cached-example',
    category: 'cached',
    warmCache: true,
    body: { url: 'https://example.com', formats: ['markdown'], cacheTtl: 600 },
  },
  {
    name: 'tier4-news-ycombinator',
    category: 'tier4-simple',
    body: {
      url: 'https://news.ycombinator.com',
      formats: ['markdown'],
      waitFor: '#hnmain',
      cacheTtl: 0,
    },
  },
  {
    name: 'tier4-cnn-spa',
    category: 'tier4-spa',
    body: { url: 'https://www.cnn.com', formats: ['markdown'], cacheTtl: 0 },
  },
];

interface Sample {
  scenario: string;
  category: Scenario['category'];
  ms: number;
  ok: boolean;
  status: number;
  tier: number | null;
  qualityScore: number | null;
  cached: boolean | null;
}

async function hit(body: Record<string, unknown>): Promise<Omit<Sample, 'scenario' | 'category'>> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API}/v1/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => null);
    return {
      ms: Date.now() - t0,
      ok: res.ok,
      status: res.status,
      tier: data?.metadata?.tierUsed ?? null,
      qualityScore: data?.metadata?.qualityScore ?? null,
      cached: data?.metadata?.cached ?? null,
    };
  } catch {
    return {
      ms: Date.now() - t0,
      ok: false,
      status: 0,
      tier: null,
      qualityScore: null,
      cached: null,
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function runWithConcurrency<T>(
  count: number,
  concurrency: number,
  task: () => Promise<T>,
): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  async function worker() {
    while (next < count) {
      next++;
      out.push(await task());
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

async function main() {
  console.log(
    `Perf harness: ${RUNS} runs/scenario @ concurrency ${CONCURRENCY} against ${API}\n`,
  );

  const allSamples: Sample[] = [];

  for (const s of SCENARIOS) {
    if (s.warmCache) {
      console.log(`  warming cache for ${s.name}...`);
      await hit(s.body);
    }
    process.stdout.write(`  ${s.name.padEnd(28)} `);
    const samples = await runWithConcurrency(RUNS, CONCURRENCY, async () => {
      const r = await hit(s.body);
      return { scenario: s.name, category: s.category, ...r } as Sample;
    });
    allSamples.push(...samples);

    const oks = samples.filter((x) => x.ok);
    const latencies = oks.map((x) => x.ms).sort((a, b) => a - b);
    const failRate = 1 - oks.length / samples.length;
    console.log(
      `p50=${percentile(latencies, 50).toString().padStart(5)}ms  ` +
        `p95=${percentile(latencies, 95).toString().padStart(5)}ms  ` +
        `p99=${percentile(latencies, 99).toString().padStart(5)}ms  ` +
        `max=${percentile(latencies, 100).toString().padStart(5)}ms  ` +
        `fail=${(failRate * 100).toFixed(1)}%`,
    );
  }

  // Per-category rollup (matches the plan's industry-grade target table)
  console.log('\n═════════════ Industry-grade targets vs measured ═════════════\n');
  const targets: Record<Scenario['category'], { p50: number; p95: number; p99: number }> = {
    cached: { p50: 20, p95: 50, p99: 100 },
    tier1: { p50: 500, p95: 2000, p99: 5000 },
    'tier4-simple': { p50: 3000, p95: 8000, p99: 15000 },
    'tier4-spa': { p50: 5000, p95: 12000, p99: 20000 },
  };

  for (const cat of Object.keys(targets) as Array<Scenario['category']>) {
    const samples = allSamples.filter((s) => s.category === cat && s.ok);
    if (!samples.length) {
      console.log(`${cat.padEnd(14)}  (no successful samples)`);
      continue;
    }
    const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);
    const t = targets[cat];
    const verdict =
      p50 <= t.p50 && p95 <= t.p95 && p99 <= t.p99 ? 'PASS' : 'MISS';
    console.log(
      `${cat.padEnd(14)}  p50=${p50}ms (target <=${t.p50})  ` +
        `p95=${p95}ms (target <=${t.p95})  ` +
        `p99=${p99}ms (target <=${t.p99})  ${verdict}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
