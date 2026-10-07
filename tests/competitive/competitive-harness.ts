/* eslint-disable no-console */
/**
 * Part 4.H — Competitive benchmark harness.
 *
 * Pits ScrapeForge against major paid competitors on the same URLs and
 * reports success rate, median latency, and cost-per-success.
 *
 * NOTE: This is a SCAFFOLD. The four competitors below each require a paid
 * API key. Export them as env vars before running:
 *
 *   SCRAPINGBEE_KEY="..."
 *   SCRAPERAPI_KEY="..."
 *   BRIGHTDATA_TOKEN="..."
 *   FIRECRAWL_KEY="..."
 *   API_KEY="sf_live_..."        # our own
 *
 * Any provider whose key is missing is skipped with a "[SKIP]" note — that
 * way you can run it with just your own key and ScrapingBee, etc.
 *
 * Run:
 *   npx tsx tests/competitive/competitive-harness.ts
 */

import { performance } from 'node:perf_hooks';

interface Provider {
  name: string;
  /** URL → HTTP request spec. */
  build: (url: string) => { endpoint: string; init: RequestInit } | null;
  /** Map provider response → success flag + snippet of extracted content. */
  parse: (res: Response, body: string) => Promise<{ ok: boolean; snippet: string }>;
  /** Approx USD per successful request — for cost-per-success column. */
  pricePerRequest: number;
}

const TARGETS = [
  'https://example.com',
  'https://en.wikipedia.org/wiki/Web_scraping',
  'https://quotes.toscrape.com',
  'https://news.ycombinator.com',
  'https://www.bbc.com/news',
  'https://www.reddit.com/r/programming',
];

const SF_KEY = process.env.API_KEY;
const SF_BASE = process.env.API_BASE || 'http://localhost:3000';

const providers: Provider[] = [
  {
    name: 'ScrapeForge (us)',
    pricePerRequest: 0.0002,
    build: (url) => {
      if (!SF_KEY) return null;
      return {
        endpoint: `${SF_BASE}/v1/scrape`,
        init: {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SF_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ url, formats: ['markdown'], cacheTtl: 0 }),
        },
      };
    },
    parse: async (res, body) => {
      const j = safeJson(body);
      const md = j?.content?.markdown;
      return { ok: res.ok && typeof md === 'string' && md.length > 100, snippet: (md || '').slice(0, 80) };
    },
  },
  {
    name: 'ScrapingBee',
    pricePerRequest: 0.0010,
    build: (url) => {
      const key = process.env.SCRAPINGBEE_KEY;
      if (!key) return null;
      const qs = new URLSearchParams({ api_key: key, url, render_js: 'false' });
      return {
        endpoint: `https://app.scrapingbee.com/api/v1/?${qs}`,
        init: { method: 'GET' },
      };
    },
    parse: async (res, body) => ({ ok: res.ok && body.length > 100, snippet: body.slice(0, 80) }),
  },
  {
    name: 'ScraperAPI',
    pricePerRequest: 0.0015,
    build: (url) => {
      const key = process.env.SCRAPERAPI_KEY;
      if (!key) return null;
      return {
        endpoint: `https://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(url)}`,
        init: { method: 'GET' },
      };
    },
    parse: async (res, body) => ({ ok: res.ok && body.length > 100, snippet: body.slice(0, 80) }),
  },
  {
    name: 'Firecrawl',
    pricePerRequest: 0.0020,
    build: (url) => {
      const key = process.env.FIRECRAWL_KEY;
      if (!key) return null;
      return {
        endpoint: 'https://api.firecrawl.dev/v1/scrape',
        init: {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, formats: ['markdown'] }),
        },
      };
    },
    parse: async (res, body) => {
      const j = safeJson(body);
      const md = j?.data?.markdown;
      return { ok: res.ok && typeof md === 'string' && md.length > 100, snippet: (md || '').slice(0, 80) };
    },
  },
  {
    name: 'Bright Data',
    pricePerRequest: 0.0020,
    build: (url) => {
      const token = process.env.BRIGHTDATA_TOKEN;
      if (!token) return null;
      return {
        endpoint: 'https://api.brightdata.com/dca/trigger_immediate?collector=scrape',
        init: {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        },
      };
    },
    parse: async (res, body) => ({ ok: res.ok && body.length > 100, snippet: body.slice(0, 80) }),
  },
];

function safeJson(body: string): any {
  try { return JSON.parse(body); } catch { return null; }
}

interface Row {
  provider: string;
  attempted: number;
  succeeded: number;
  medianLatencyMs: number;
  p95LatencyMs: number;
  costPerSuccess: string;
  skipped: boolean;
}

async function runOne(p: Provider): Promise<Row> {
  const timings: number[] = [];
  let succeeded = 0;
  let attempted = 0;

  for (const url of TARGETS) {
    const spec = p.build(url);
    if (!spec) {
      return {
        provider: p.name,
        attempted: 0,
        succeeded: 0,
        medianLatencyMs: 0,
        p95LatencyMs: 0,
        costPerSuccess: '—',
        skipped: true,
      };
    }
    attempted++;
    const t0 = performance.now();
    try {
      const res = await fetch(spec.endpoint, spec.init);
      const body = await res.text();
      const t1 = performance.now();
      timings.push(t1 - t0);
      const parsed = await p.parse(res, body);
      if (parsed.ok) succeeded++;
    } catch {
      timings.push(30_000);
    }
  }

  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)] || 0;
  const p95 = timings[Math.floor(timings.length * 0.95)] || 0;
  const costPerSuccess =
    succeeded > 0 ? `$${((p.pricePerRequest * attempted) / succeeded).toFixed(4)}` : 'n/a';

  return {
    provider: p.name,
    attempted,
    succeeded,
    medianLatencyMs: Math.round(median),
    p95LatencyMs: Math.round(p95),
    costPerSuccess,
    skipped: false,
  };
}

async function main() {
  console.log(`Competitive benchmark across ${TARGETS.length} URLs.\n`);
  const rows: Row[] = [];
  for (const p of providers) {
    const r = await runOne(p);
    rows.push(r);
    if (r.skipped) {
      console.log(`  [SKIP] ${p.name}  (missing API key)`);
    } else {
      console.log(
        `  ${p.name.padEnd(20)}  ${r.succeeded}/${r.attempted}  median=${r.medianLatencyMs}ms  p95=${r.p95LatencyMs}ms  cost/success=${r.costPerSuccess}`,
      );
    }
  }

  console.log('\n═══════════════ Summary ═══════════════');
  console.log('provider              success   median   p95   cost/success');
  console.log('────────────────────────────────────────────────────────────');
  for (const r of rows) {
    if (r.skipped) continue;
    const rate = r.attempted ? `${r.succeeded}/${r.attempted}` : '-';
    console.log(
      `${r.provider.padEnd(20)} ${rate.padStart(7)}  ${String(r.medianLatencyMs).padStart(5)}ms  ${String(r.p95LatencyMs).padStart(5)}ms  ${r.costPerSuccess}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
