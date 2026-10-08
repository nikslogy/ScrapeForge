// Browser readiness (tier4-browser.ts settlePage) with a real Chromium: no
// fixed sleeps, yet late content is still captured. Skipped when no local
// Chromium is found. Timing bounds are generous: the suite runs in parallel.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'patchright';
import { OutboundBlockedError, setOutboundPolicyForTests } from '@scrapeforge/shared';
import {
  DEFAULT_CHALLENGE_CAP_MS,
  DEFAULT_READY_CAP_MS,
  readinessFor,
  settlePage,
  tier4Fetch,
  trackRequests,
  type SettleOptions,
} from '../../src/engine/tier4-browser.js';
import { humanDelayMs, tier4StealthFetch } from '../../src/engine/tier4-stealth.js';
import { BrowserPool } from '../../src/browser/pool.js';
import { findChromium } from '../../../../tests/latency/lib/chromium-path.js';
import { INTERNAL_IP, html, startServer, useFixturePolicy, type FixtureServer } from '../net/fixtures.js';
import {
  FETCHED_BODY,
  MARKERS,
  challengeTargetPage,
  delayedPage,
  fetchingPage,
  jsChallengePage,
  lazyPage,
  staticPage,
} from './pages.js';
import { startLocalServer, type LocalServer } from './server.js';

// ── pure option handling (no browser) ───────────────────

describe('readinessFor', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to a 2.5 s cap, forcing a scroll only for screenshots and waitFor', () => {
    delete process.env.BROWSER_READY_TIMEOUT_MS;
    delete process.env.BROWSER_CHALLENGE_TIMEOUT_MS;
    const start = performance.now();
    expect(readinessFor({}, start)).toEqual({
      capMs: DEFAULT_READY_CAP_MS,
      challengeCapMs: DEFAULT_CHALLENGE_CAP_MS,
      forceScroll: false,
      waitForLoad: false,
    });
    expect(readinessFor({ screenshot: true }, start)).toMatchObject({ forceScroll: true, waitForLoad: true });
    expect(readinessFor({ waitFor: '#x' }, start)).toMatchObject({ forceScroll: true, waitForLoad: false });
  });

  it('takes the cap from the option, then the environment', () => {
    process.env.BROWSER_READY_TIMEOUT_MS = '900';
    expect(readinessFor({}, performance.now()).capMs).toBe(900);
    expect(readinessFor({ readyTimeoutMs: 300 }, performance.now()).capMs).toBe(300);
    process.env.BROWSER_READY_TIMEOUT_MS = 'garbage';
    expect(readinessFor({}, performance.now()).capMs).toBe(DEFAULT_READY_CAP_MS);
    process.env.BROWSER_READY_TIMEOUT_MS = '-5';
    expect(readinessFor({}, performance.now()).capMs).toBe(DEFAULT_READY_CAP_MS);
  });

  it('never waits past the caller\'s overall timeout', () => {
    delete process.env.BROWSER_READY_TIMEOUT_MS;
    const r = readinessFor({ timeout: 5_000 }, performance.now() - 4_000);
    expect(r.capMs).toBeLessThanOrEqual(1_000);
    expect(r.challengeCapMs).toBeLessThanOrEqual(1_000);
    expect(readinessFor({ timeout: 1_000 }, performance.now() - 9_000)).toMatchObject({ capMs: 0, challengeCapMs: 0 });
  });
});

describe('humanDelayMs (stealth)', () => {
  const saved = process.env.STEALTH_HUMAN_DELAY_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.STEALTH_HUMAN_DELAY_MS;
    else process.env.STEALTH_HUMAN_DELAY_MS = saved;
  });

  it('is off unless configured', () => {
    delete process.env.STEALTH_HUMAN_DELAY_MS;
    expect(humanDelayMs(() => 0.99)).toBe(0);
    process.env.STEALTH_HUMAN_DELAY_MS = '0';
    expect(humanDelayMs(() => 0.99)).toBe(0);
    process.env.STEALTH_HUMAN_DELAY_MS = 'soon';
    expect(humanDelayMs(() => 0.99)).toBe(0);
  });

  it('waits between half and all of the configured delay, capped at 10 s', () => {
    process.env.STEALTH_HUMAN_DELAY_MS = '600';
    expect(humanDelayMs(() => 0)).toBe(300);
    expect(humanDelayMs(() => 0.999)).toBeLessThanOrEqual(600);
    process.env.STEALTH_HUMAN_DELAY_MS = '999999';
    expect(humanDelayMs(() => 0.999)).toBeLessThanOrEqual(10_000);
  });
});

// ── with a browser ──────────────────────────────────────

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || findChromium() || undefined;

const NEVER_SETTLES =
  '<!doctype html><html><body><h1>Ticker</h1><p id="t">0</p><script>var n = 0;' +
  "setInterval(function () { document.getElementById('t').textContent = String(++n); }, 50);</script></body></html>";

const LONG_POLL =
  '<!doctype html><html><body><h1>Live</h1><p>Static text of the page that is long enough to count as content for readiness.</p>' +
  "<script>fetch('/poll').catch(function () {});</script></body></html>";

// Tall and dense (about 1,000 chars of text per 400 px): nothing suggests
// that scrolling would load more.
const TALL_NOT_LAZY =
  '<!doctype html><html><body>' +
  Array.from(
    { length: 20 },
    (_, i) => `<section style="height:400px;overflow:hidden"><h2>Part ${i}</h2><p>${`Plain server-rendered text for part ${i} of the page; nothing loads later. `.repeat(13)}</p></section>`,
  ).join('') +
  "<script>window.addEventListener('scroll', function () { document.body.dataset.scrolled = '1'; });</script></body></html>";

const SELECTOR_LATE =
  '<!doctype html><html><body><h1>Later</h1><script>setTimeout(function () {' +
  "var d = document.createElement('div'); d.id = 'late'; d.textContent = 'late element arrived'; document.body.appendChild(d); }, 500);" +
  '</script></body></html>';

const BUSY_MAIN_THREAD =
  '<!doctype html><html><body><h1>Busy</h1><p>Some text here so the page is not empty at all.</p><script>' +
  'setTimeout(function () { var end = Date.now() + 2500; while (Date.now() < end) {} }, 30);</script></body></html>';

// example.com plus an analytics snippet: scripts, but nothing left to render.
const SMALL_WITH_SCRIPT =
  '<!doctype html><html><head><title>Example Domain</title><script>window.dataLayer = [];' +
  "dataLayer.push({ event: 'view' });</script></head><body><div><h1>Example Domain</h1>" +
  '<p>This domain is for use in illustrative examples in documents.</p></div></body></html>';

// Nothing visible until a timer renders the page; no network activity, no
// loading text.
const BLANK_THEN_RENDER =
  '<!doctype html><html><body><div id="main"></div><script>setTimeout(function () {' +
  "document.getElementById('main').innerHTML = '<h1>Rendered late</h1><p>' + 'BLANK-' + 'RENDERED-OK' + '</p>'; }, 700);" +
  '</script></body></html>';

const SERVICE_WORKER =
  '<!doctype html><html><body><h1>SW</h1><p id="sw">pending</p><script>' +
  "navigator.serviceWorker.register('/sw.js').then(function () { document.getElementById('sw').textContent = 'registered'; }," +
  " function (e) { document.getElementById('sw').textContent = 'refused'; });</script></body></html>";

describe.skipIf(!chromiumPath)('browser readiness with a real Chromium', () => {
  let pool: BrowserPool;
  let site: LocalServer;
  let internal: FixtureServer;
  let context: BrowserContext;

  beforeAll(async () => {
    internal = await startServer(INTERNAL_IP, html('<p>INTERNAL SECRET</p>'));
    const reachInside = (path: string) => `fetch('${internal.origin}${path}', { mode: 'no-cors' }).catch(function () {})`;
    site = await startLocalServer({
      '/static': staticPage(),
      '/delayed': delayedPage(800),
      '/lazy': lazyPage(),
      '/challenge': jsChallengePage('/challenge-done', 1200),
      '/challenge-done': challengeTargetPage(),
      '/fetching': fetchingPage('/api/data'),
      '/api/data': { body: FETCHED_BODY, contentType: 'text/plain', delayMs: 600 },
      '/ticker': NEVER_SETTLES,
      '/long-poll': LONG_POLL,
      '/poll': { body: 'never', delayMs: 60_000 },
      '/tall': TALL_NOT_LAZY,
      '/late-selector': SELECTOR_LATE,
      '/busy': BUSY_MAIN_THREAD,
      '/small-js': SMALL_WITH_SCRIPT,
      '/blank-then-render': BLANK_THEN_RENDER,
      '/slow-image': '<!doctype html><html><body><h1>Slow image</h1><p>A page whose only image is slow.</p><img src="/slow.png"></body></html>',
      '/slow.png': { body: 'png', contentType: 'image/png', delayMs: 600 },
      '/slow-bounce-page': '<!doctype html><html><body><h1>Bounce</h1><p>An image that redirects inside, slowly.</p><img src="/slow-bounce"></body></html>',
      '/slow-bounce': { body: '', status: 302, delayMs: 500, headers: { Location: `${internal.origin}/pixel.png` } },
      '/sw-internal': SERVICE_WORKER,
      '/sw.js': {
        body:
          `self.addEventListener('install', function (e) { e.waitUntil(${reachInside('/from-sw-install')}); });` +
          `self.addEventListener('activate', function () { ${reachInside('/from-sw-activate')}; });`,
        contentType: 'text/javascript',
      },
    });
    pool = new BrowserPool(2, 100, 30 * 60 * 1000, { executablePath: chromiumPath, logger: { log() {}, warn() {} } });
    await pool.initialize();
  }, 30_000);

  afterAll(async () => {
    await pool?.shutdown();
    await Promise.all([site?.close(), internal?.close()]);
  });

  beforeEach(async () => {
    useFixturePolicy();
    internal.requests.length = 0;
    context = await pool.acquire();
  });

  afterEach(() => {
    pool.release(context);
    setOutboundPolicyForTests(null);
  });

  async function settleOn(path: string, opts: Partial<SettleOptions> = {}) {
    const page: Page = await context.newPage();
    const tracker = trackRequests(page);
    try {
      await page.goto(`${site.origin}${path}`, { waitUntil: 'domcontentloaded' });
      const report = await settlePage(page, tracker, { capMs: DEFAULT_READY_CAP_MS, challengeCapMs: DEFAULT_CHALLENGE_CAP_MS, ...opts });
      return { report, html: await page.content(), page };
    } finally {
      tracker.dispose();
      await page.close();
    }
  }

  async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
    const t0 = performance.now();
    const value = await fn();
    return { value, ms: performance.now() - t0 };
  }

  it('a page without scripts is ready at once', async () => {
    const { report } = await settleOn('/static');
    expect(report.reason).toBe('static');
    expect(report.ms).toBeLessThan(200);

    const { value, ms } = await timed(() => tier4Fetch(`${site.origin}/static`, context));
    expect(value.html).toContain(MARKERS.static);
    // Was ~1,065 ms with the fixed networkidle + 400 ms + scroll waits.
    expect(ms).toBeLessThan(800);
  });

  it('a small page with an inline script is ready after a short quiet window, not at the cap', async () => {
    const { report } = await settleOn('/small-js');
    expect(report.reason).toBe('stable');
    expect(report.ms).toBeLessThan(900);
    const { value, ms } = await timed(() => tier4Fetch(`${site.origin}/small-js`, context));
    expect(value.html).toContain('Example Domain');
    expect(ms).toBeLessThan(1_200);
  });

  it('waits for sub-resources still loading, so the outbound monitor sees their redirects', async () => {
    const before = site.count('/slow.png');
    const { report } = await settleOn('/slow-image');
    expect(report.reason).toBe('static');
    expect(report.ms).toBeGreaterThanOrEqual(450);
    expect(site.count('/slow.png')).toBe(before + 1);

    // A slow image redirect to an internal address fails the fetch, as a fast one does.
    await expect(tier4Fetch(`${site.origin}/slow-bounce-page`, context)).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(tier4StealthFetch(`${site.origin}/slow-bounce-page`, context)).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it('captures a page that stays blank until a timer renders it', async () => {
    const r = await tier4Fetch(`${site.origin}/blank-then-render`, context);
    expect(r.html).toContain('BLANK-RENDERED-OK');
  });

  it('captures content a timer renders 800 ms after load', async () => {
    const { value, ms } = await timed(() => tier4Fetch(`${site.origin}/delayed`, context));
    expect(value.html).toContain(MARKERS.delayed);
    expect(ms).toBeGreaterThanOrEqual(800);
    expect(ms).toBeLessThan(DEFAULT_READY_CAP_MS + 1_000);
  });

  it('captures content filled in from a slow API call', async () => {
    const { value } = await timed(() => tier4Fetch(`${site.origin}/fetching`, context));
    expect(value.html).toContain(MARKERS.fetched);
  });

  it('scrolls a lazy-loading page and captures what scrolling loads', async () => {
    const { report, html } = await settleOn('/lazy');
    expect(report.scrolled).toBe(true);
    expect(html).toContain(MARKERS.lazy);
    expect(html).toContain(MARKERS.lazyImage);

    const r = await tier4Fetch(`${site.origin}/lazy`, context);
    expect(r.html).toContain(MARKERS.lazy);
  });

  it('does not scroll a tall page without lazy-loading signals, unless a screenshot is wanted', async () => {
    const plain = await settleOn('/tall');
    expect(plain.report.scrolled).toBe(false);
    expect(plain.html).not.toContain('data-scrolled');

    const forced = await settleOn('/tall', { forceScroll: true });
    expect(forced.report.scrolled).toBe(true);
    expect(forced.html).toContain('data-scrolled="1"');

    const shot = await tier4Fetch(`${site.origin}/tall`, context, { screenshot: true });
    expect(shot.screenshot).toMatch(/^iVBOR/); // PNG
  });

  it('waits out a JS challenge interstitial and returns the page it navigates to', async () => {
    const { report, html } = await settleOn('/challenge');
    // The landing page has no scripts, so it is ready as soon as it is there.
    expect(['static', 'stable']).toContain(report.reason);
    expect(report.ms).toBeGreaterThanOrEqual(1_100);
    expect(html).toContain(MARKERS.challenge);

    const stealth = await tier4StealthFetch(`${site.origin}/challenge`, context);
    expect(stealth.html).toContain(MARKERS.challenge);
  });

  it('stops at the cap on a page that never stops changing', async () => {
    const { report } = await settleOn('/ticker', { capMs: 600 });
    expect(report.reason).toBe('cap');
    expect(report.ms).toBeGreaterThanOrEqual(550);
    expect(report.ms).toBeLessThan(1_500);

    const { ms } = await timed(() => tier4Fetch(`${site.origin}/ticker`, context, { readyTimeoutMs: 600 }));
    expect(ms).toBeLessThan(2_000);
  });

  it('does not let a request that never completes hold the page hostage', async () => {
    const { report, html } = await settleOn('/long-poll');
    expect(html).toContain('Static text');
    expect(report.ms).toBeLessThan(DEFAULT_READY_CAP_MS + 300);
  });

  it('keeps the cap even when the page\'s main thread is blocked', async () => {
    const page = await context.newPage();
    const tracker = trackRequests(page);
    try {
      await page.goto(`${site.origin}/busy`, { waitUntil: 'domcontentloaded' });
      const report = await settlePage(page, tracker, { capMs: 700, challengeCapMs: 700 });
      expect(report.ms).toBeLessThan(1_600);
    } finally {
      tracker.dispose();
      await page.close();
    }
  });

  it('keeps waitFor semantics: waits for the selector, and fails when it never appears', async () => {
    const r = await tier4Fetch(`${site.origin}/late-selector`, context, { waitFor: '#late' });
    expect(r.html).toContain('late element arrived');
    await expect(tier4Fetch(`${site.origin}/static`, context, { waitFor: '#missing', timeout: 600 })).rejects.toThrow(/Timeout|exceeded/i);
    await expect(tier4StealthFetch(`${site.origin}/static`, context, { waitFor: '#missing', timeout: 600 })).rejects.toThrow(/Timeout|exceeded/i);
  });

  it('stealth: no fixed delay by default', async () => {
    delete process.env.STEALTH_HUMAN_DELAY_MS;
    const { value, ms } = await timed(() => tier4StealthFetch(`${site.origin}/static`, context));
    expect(value.html).toContain(MARKERS.static);
    // Was 300–1,000 ms random sleep + networkidle (≥ 500 ms).
    expect(ms).toBeLessThan(800);
  });

  it('a service worker a page registers cannot reach the internal network', async () => {
    // Patchright keeps worker requests on the context route (the SSRF guard)
    // only while serviceWorkers is not 'block'; see browser/fingerprint.ts.
    for (const fetchTier of [tier4Fetch, tier4StealthFetch]) {
      const ctx = await pool.acquire();
      try {
        const r = await fetchTier(`${site.origin}/sw-internal`, ctx, { readyTimeoutMs: 1_000 });
        expect(r.html).toContain('<h1>SW</h1>');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(internal.requests).toEqual([]);
      } finally {
        pool.release(ctx);
      }
    }
  });
});
