/* eslint-disable no-console */
/**
 * Real-world speed & quality benchmark.
 * Runs a suite of progressively harder URLs against /v1/scrape and
 * reports latency, tier used, quality, content length, extraction method.
 */

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error('Missing env API_KEY. Export the sf_live_... key and rerun.');
  process.exit(1);
}

interface Target {
  name: string;
  url: string;
  difficulty: 'easy' | 'medium' | 'hard' | 'brutal';
  expect: { minChars: number };
}

const TARGETS: Target[] = [
  { name: 'example.com',        url: 'https://example.com',                                difficulty: 'easy',   expect: { minChars: 100 } },
  { name: 'wikipedia',          url: 'https://en.wikipedia.org/wiki/Web_scraping',         difficulty: 'easy',   expect: { minChars: 3000 } },
  { name: 'news-ycombinator',   url: 'https://news.ycombinator.com',                       difficulty: 'easy',   expect: { minChars: 2000 } },
  { name: 'hacker-news-item',   url: 'https://news.ycombinator.com/item?id=1',             difficulty: 'easy',   expect: { minChars: 200 } },
  { name: 'github-readme',      url: 'https://github.com/nodejs/node',                     difficulty: 'medium', expect: { minChars: 1500 } },
  { name: 'bbc-article',        url: 'https://www.bbc.com/news',                           difficulty: 'medium', expect: { minChars: 1000 } },
  { name: 'reuters',            url: 'https://www.reuters.com/world/',                     difficulty: 'hard',   expect: { minChars: 1000 } },
  { name: 'cnn-homepage',       url: 'https://www.cnn.com',                                difficulty: 'hard',   expect: { minChars: 1500 } },
  { name: 'msn-news',           url: 'https://www.msn.com/en-in/news',                     difficulty: 'brutal', expect: { minChars: 800 } },
  { name: 'techcrunch',         url: 'https://techcrunch.com',                             difficulty: 'hard',   expect: { minChars: 1500 } },
  { name: 'medium-article',     url: 'https://medium.com',                                 difficulty: 'hard',   expect: { minChars: 500 } },
  { name: 'amazon-product',     url: 'https://www.amazon.com/dp/B08N5WRWNW',               difficulty: 'brutal', expect: { minChars: 1000 } },
];

interface Row {
  name: string;
  difficulty: string;
  status: number;
  ok: boolean;
  tier: number | null;
  latencyMs: number;
  quality: number | null;
  chars: number;
  method: string;
  passed: boolean;
  error?: string;
}

async function runOne(t: Target): Promise<Row> {
  const start = Date.now();
  try {
    const res = await fetch(`${API_BASE}/v1/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        url: t.url,
        formats: ['markdown'],
        blockResources: true,
        cacheTtl: 0,
        timeout: 60_000,
      }),
    });
    const data: any = await res.json();
    const elapsed = Date.now() - start;
    const chars = (data?.content?.markdown || data?.content?.text || '').length;
    const tier = data?.metadata?.tierUsed ?? null;
    const quality = data?.metadata?.qualityScore ?? null;
    const method = data?.metadata?.extractionMethod || '-';

    return {
      name: t.name,
      difficulty: t.difficulty,
      status: res.status,
      ok: res.ok,
      tier,
      latencyMs: elapsed,
      quality,
      chars,
      method,
      passed: res.ok && chars >= t.expect.minChars,
    };
  } catch (err) {
    return {
      name: t.name,
      difficulty: t.difficulty,
      status: 0,
      ok: false,
      tier: null,
      latencyMs: Date.now() - start,
      quality: null,
      chars: 0,
      method: '-',
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function pad(s: string | number, n: number) {
  return String(s).padEnd(n);
}
function padR(s: string | number, n: number) {
  return String(s).padStart(n);
}

async function main() {
  console.log(`Running ${TARGETS.length} scrape benchmarks against ${API_BASE}\n`);
  console.log(
    [
      pad('SITE', 22),
      pad('LEVEL', 8),
      padR('HTTP', 5),
      padR('TIER', 5),
      padR('MS', 7),
      padR('CHARS', 7),
      padR('Q', 6),
      pad('METHOD', 22),
      'PASS',
    ].join(' '),
  );
  console.log('-'.repeat(95));

  const rows: Row[] = [];
  // Sequential to get clean numbers — parallel creates noise from pooled-browser contention.
  for (const t of TARGETS) {
    const r = await runOne(t);
    rows.push(r);
    console.log(
      [
        pad(r.name, 22),
        pad(r.difficulty, 8),
        padR(r.status, 5),
        padR(r.tier ?? '-', 5),
        padR(r.latencyMs, 7),
        padR(r.chars, 7),
        padR(r.quality ?? '-', 6),
        pad(r.method, 22),
        r.passed ? 'PASS' : r.error ? `ERR ${r.error.slice(0, 40)}` : 'FAIL',
      ].join(' '),
    );
  }

  // Aggregate stats
  const ok = rows.filter((r) => r.passed);
  const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) =>
    latencies.length
      ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]
      : 0;

  console.log('\n═══════════════════════ SUMMARY ═══════════════════════');
  console.log(`Passed:  ${ok.length}/${rows.length} (${Math.round((ok.length / rows.length) * 100)}%)`);
  console.log(`Average: ${ok.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0}ms`);
  console.log(`Median:  ${pct(50)}ms`);
  console.log(`P95:     ${pct(95)}ms`);
  console.log(`Max:     ${pct(100)}ms`);

  const byTier: Record<string, number> = {};
  for (const r of ok) byTier[`tier${r.tier}`] = (byTier[`tier${r.tier}`] || 0) + 1;
  console.log('Tier dist:', byTier);

  const byDifficulty: Record<string, { total: number; passed: number; avgMs: number }> = {};
  for (const r of rows) {
    const g = (byDifficulty[r.difficulty] ||= { total: 0, passed: 0, avgMs: 0 });
    g.total++;
    if (r.passed) {
      g.passed++;
      g.avgMs = Math.round((g.avgMs * (g.passed - 1) + r.latencyMs) / g.passed);
    }
  }
  console.log('\nBy difficulty:');
  for (const [diff, s] of Object.entries(byDifficulty)) {
    console.log(`  ${pad(diff, 8)} ${s.passed}/${s.total} passed, avg ${s.avgMs}ms`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
