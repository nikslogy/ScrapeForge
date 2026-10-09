// The browser tiers honour the caller's overall `timeout` even when the page
// stops responding: a page whose main thread busy-loops after
// DOMContentLoaded must not hang the fetch (and keep its pooled context) for
// ever. Real Chromium; skipped when none is installed.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setOutboundPolicyForTests } from '@scrapeforge/shared';
import { readinessFor, tier4Fetch } from '../../src/engine/tier4-browser.js';
import { tier4StealthFetch } from '../../src/engine/tier4-stealth.js';
import { BrowserPool } from '../../src/browser/pool.js';
import { findChromium } from '../../../../tests/latency/lib/chromium-path.js';
import { useFixturePolicy } from '../net/fixtures.js';
import { MARKERS, staticPage } from './pages.js';
import { startLocalServer, type LocalServer } from './server.js';

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || findChromium() || undefined;

// Parses, fires DOMContentLoaded, then never yields the main thread again.
const BUSY_FOREVER =
  '<!doctype html><html><head><title>Busy forever</title></head><body><h1>Busy</h1>' +
  '<p>The server-rendered text of a page whose script never returns to the event loop.</p>' +
  '<script>setTimeout(function () { for (;;) {} }, 50);</script></body></html>';

// Keeps changing until the readiness cap, so settling uses up its budget.
const TICKER =
  '<!doctype html><html><body><h1>Ticker</h1><p id="t">0</p><script>var n = 0;' +
  "setInterval(function () { document.getElementById('t').textContent = 'TICK-' + (++n); }, 40);</script></body></html>";

const TIMEOUT_MS = 3_000;
// Closing the page and the test's own scheduling, under a parallel suite.
const SLACK_MS = 2_000;

type Settled<T> = { kind: 'resolved'; value: T } | { kind: 'rejected'; error: unknown } | { kind: 'pending' };

/** How `promise` settled within `ms`, without leaving a rejection unhandled. */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ result: Settled<T>; ms: number }> {
  const t0 = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race<Settled<T>>([
    promise.then(
      (value) => ({ kind: 'resolved', value }),
      (error) => ({ kind: 'rejected', error }),
    ),
    new Promise<Settled<T>>((r) => (timer = setTimeout(() => r({ kind: 'pending' }), ms))),
  ]);
  clearTimeout(timer);
  return { result, ms: performance.now() - t0 };
}

describe('readinessFor leaves time to read the page', () => {
  it('ends the readiness wait early enough to read the page within the overall timeout', () => {
    // A fifth of the timeout, between 250 ms and 1 s, is kept for reading.
    const short = readinessFor({ timeout: 2_000 }, performance.now());
    expect(short.capMs).toBeLessThanOrEqual(1_600);
    expect(short.capMs).toBeGreaterThan(1_500);
    expect(short.challengeCapMs).toBeLessThanOrEqual(1_600);
    const long = readinessFor({ timeout: 6_000 }, performance.now());
    expect(long.challengeCapMs).toBeLessThanOrEqual(5_000);
    expect(readinessFor({ timeout: 1_000 }, performance.now()).capMs).toBeLessThanOrEqual(750);
  });
});

describe.skipIf(!chromiumPath)('browser fetch deadline with a real Chromium', () => {
  let pool: BrowserPool;
  let site: LocalServer;

  beforeAll(async () => {
    site = await startLocalServer({ '/busy': BUSY_FOREVER, '/static': staticPage(), '/ticker': TICKER });
    // One context: the follow-up fetch must get the very context the hung page used.
    pool = new BrowserPool(1, 100, 30 * 60 * 1000, { executablePath: chromiumPath, logger: { log() {}, warn() {} } });
    await pool.initialize();
  }, 30_000);

  afterAll(async () => {
    await pool?.shutdown();
    await site?.close();
  });

  beforeEach(() => useFixturePolicy());
  afterEach(() => setOutboundPolicyForTests(null));

  for (const [name, fetchTier] of [
    ['tier4Fetch', tier4Fetch],
    ['tier4StealthFetch', tier4StealthFetch],
  ] as const) {
    it(`${name}: a page that busy-loops after DOMContentLoaded fails within the timeout and frees its context`, async () => {
      const ctx = await pool.acquire(5_000);
      let settled: Awaited<ReturnType<typeof settleWithin>>;
      try {
        settled = await settleWithin(fetchTier(`${site.origin}/busy`, ctx, { timeout: TIMEOUT_MS }), TIMEOUT_MS + 8_000);
      } finally {
        pool.release(ctx);
      }
      expect(settled.result.kind).toBe('rejected');
      expect(settled.ms).toBeLessThan(TIMEOUT_MS + SLACK_MS);
      const error = (settled.result as { error: Error }).error;
      expect(error.message).toMatch(/timeout/i);
      expect(error.message).toContain(`${TIMEOUT_MS} ms`);

      // The same context serves the next fetch.
      expect(pool.stats().inUse).toBe(0);
      const again = await pool.acquire(3_000);
      expect(again).toBe(ctx);
      try {
        const r = await fetchTier(`${site.origin}/static`, again, { timeout: 5_000 });
        expect(r.html).toContain(MARKERS.static);
        expect(r.statusCode).toBe(200);
      } finally {
        pool.release(again);
      }
    }, 30_000);
  }

  it('a busy page with a screenshot requested also fails within the timeout', async () => {
    const ctx = await pool.acquire(5_000);
    try {
      const settled = await settleWithin(
        tier4Fetch(`${site.origin}/busy`, ctx, { timeout: TIMEOUT_MS, screenshot: true }),
        TIMEOUT_MS + 8_000,
      );
      expect(settled.result.kind).toBe('rejected');
      expect(settled.ms).toBeLessThan(TIMEOUT_MS + SLACK_MS);
    } finally {
      pool.release(ctx);
    }
  }, 30_000);

  it('a page that settles only at the cap is still read when the cap would use the whole timeout', async () => {
    const ctx = await pool.acquire(5_000);
    try {
      for (const fetchTier of [tier4Fetch, tier4StealthFetch]) {
        const t0 = performance.now();
        const r = await fetchTier(`${site.origin}/ticker`, ctx, { timeout: 1_500, readyTimeoutMs: 10_000 });
        expect(r.html).toContain('TICK-');
        expect(performance.now() - t0).toBeLessThan(1_500 + SLACK_MS);
      }
    } finally {
      pool.release(ctx);
    }
  }, 30_000);
});
