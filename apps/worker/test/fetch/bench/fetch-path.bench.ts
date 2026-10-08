// Fetch-path latency bench: SmartRouter with the real tier functions, and the
// two browser tiers, against pages served on 127.0.0.1. No Redis (an
// in-memory stand-in holds the domain strategy) and no internet.
//
//   SCRAPEFORGE_ALLOW_PRIVATE_NETWORK=1 NODE_ENV=development \
//     npx tsx apps/worker/test/fetch/bench/fetch-path.bench.ts [--router-n 20] [--browser-n 10]
//       [--skip-router] [--skip-browser] [--spa-only] [--out file.json]
//
// Chromium: PLAYWRIGHT_CHROMIUM_EXECUTABLE, else the newest local install
// (tests/latency/lib/chromium-path.ts). Browser scenarios are skipped when
// none is found.

import { writeFileSync } from 'node:fs';
import type { BrowserContext } from 'patchright';
import { findChromium } from '../../../../../tests/latency/lib/chromium-path.js';
import { openBrowserPool } from '../../../../../tests/latency/lib/browser.js';
import { compactPage, smallPage } from '../../../../../tests/latency/lib/fixtures.js';
import { summarize, roundSummary } from '../../../../../tests/latency/lib/stats.js';
import { SmartRouter } from '../../../src/engine/router.js';
import { tier4Fetch } from '../../../src/engine/tier4-browser.js';
import { tier4StealthFetch } from '../../../src/engine/tier4-stealth.js';
import {
  FETCHED_BODY,
  MARKERS,
  challengeTargetPage,
  delayedPage,
  fetchingPage,
  jsChallengePage,
  lazyPage,
  staticPage,
} from '../pages.js';
import { startLocalServer } from '../server.js';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}
const ROUTER_N = arg('--router-n', 20);
const BROWSER_N = arg('--browser-n', 10);
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;
const SKIP_ROUTER = process.argv.includes('--skip-router');
const SKIP_BROWSER = process.argv.includes('--skip-browser');

if (process.env.SCRAPEFORGE_ALLOW_PRIVATE_NETWORK !== '1' || process.env.NODE_ENV === 'production') {
  console.error('Set SCRAPEFORGE_ALLOW_PRIVATE_NETWORK=1 and a non-production NODE_ENV (the pages are on 127.0.0.1).');
  process.exit(2);
}

class MemoryRedis {
  store = new Map<string, string>();
  async get(k: string) {
    return this.store.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.store.set(k, v);
    return 'OK';
  }
}

const results: Record<string, unknown> = {};

function report(name: string, ms: number[], extra: Record<string, unknown> = {}) {
  const s = roundSummary(summarize(ms), 1);
  results[name] = { ...s, ...extra };
  console.log(
    `${name.padEnd(46)} n=${String(s.n).padStart(3)} p50=${String(s.p50).padStart(7)} p95=${String(s.p95).padStart(7)} max=${String(s.max).padStart(7)} ${JSON.stringify(extra)}`,
  );
}

// Client-rendered: only a browser tier can accept it.
const SPA =
  '<!doctype html><html><head><title>SPA</title></head><body><div id="root"></div><script>' +
  "document.getElementById('root').innerHTML = '<h1>Rendered</h1><p>' + 'Rendered in the browser by a script. '.repeat(30) + '</p>';" +
  '</script></body></html>';

const site = await startLocalServer({
  '/spa': SPA,
  '/classic': smallPage(),
  '/compact': compactPage(),
  '/static': staticPage(),
  '/delayed': delayedPage(800),
  '/lazy': lazyPage(),
  '/challenge': jsChallengePage('/challenge-done', 1200),
  '/challenge-done': challengeTargetPage(),
  '/fetching': fetchingPage('/api/data'),
  '/api/data': { body: FETCHED_BODY, contentType: 'text/plain', delayMs: 600 },
});

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || findChromium();
const pool = chromiumPath ? await openBrowserPool(chromiumPath, 3) : null;
const acquire = async (): Promise<BrowserContext> => {
  if (!pool) throw new Error('no browser');
  return pool.acquire();
};
const release = (ctx: BrowserContext) => pool?.release(ctx);

try {
  // ── Router, example.com-shaped pages ──
  const routerPages = process.argv.includes('--spa-only') ? ['spa'] : ['classic', 'compact', 'spa'];
  for (const page of SKIP_ROUTER ? [] : routerPages) {
    if (page === 'spa' && !pool) continue;
    for (const mode of ['cold', 'warm'] as const) {
      const redis = new MemoryRedis();
      const router = new SmartRouter(redis as never, acquire, release);
      const url = `${site.origin}/${page}`;
      await router.route(url, {}).catch(() => {}); // warm-up (Impit client, browser page)
      if (mode === 'cold') redis.store.clear();
      const ms: number[] = [];
      const tiers: Record<string, number> = {};
      for (let i = 0; i < ROUTER_N; i++) {
        if (mode === 'cold') redis.store.clear();
        const t0 = performance.now();
        const r = await router.route(url, {});
        ms.push(performance.now() - t0);
        tiers[`T${r.tierUsed}`] = (tiers[`T${r.tierUsed}`] ?? 0) + 1;
        // Let fire-and-forget bookkeeping land before the next request.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      report(`router ${page} (${mode} strategy)`, ms, { tiers });
    }
  }

  // ── Browser tiers ──
  if (pool && !SKIP_BROWSER) {
    const scenarios: Array<[string, string, string]> = [
      ['static', '/static', MARKERS.static],
      ['delayed 800ms', '/delayed', MARKERS.delayed],
      ['lazy', '/lazy', MARKERS.lazy],
      ['fetch 600ms', '/fetching', MARKERS.fetched],
      ['js challenge 1200ms', '/challenge', MARKERS.challenge],
    ];
    for (const [tierName, fn] of [
      ['tier4Fetch', tier4Fetch],
      ['tier4StealthFetch', tier4StealthFetch],
    ] as const) {
      for (const [name, path, marker] of scenarios) {
        const ms: number[] = [];
        let captured = 0;
        let errors = 0;
        for (let i = 0; i < BROWSER_N + 1; i++) {
          const ctx = await pool.acquire();
          const t0 = performance.now();
          try {
            const r = await fn(`${site.origin}${path}`, ctx, {});
            if (i > 0) {
              ms.push(performance.now() - t0);
              if (r.html.includes(marker)) captured++;
            }
          } catch {
            if (i > 0) errors++;
          } finally {
            pool.release(ctx);
          }
        }
        report(`${tierName} ${name}`, ms, { captured: `${captured}/${BROWSER_N}`, errors });
      }
    }
  } else if (!pool) {
    console.log('browser scenarios skipped: no Chromium found');
  }
} finally {
  await pool?.shutdown();
  await site.close();
}

if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2));
