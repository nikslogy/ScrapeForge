// The status a browser tier reports is the one of the response the returned
// DOM came from (the last main-frame navigation), not the first goto()
// response: JS challenges answer 403/503, then reload or navigate to the real
// page. Real Chromium; skipped when none is installed.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserContext } from 'patchright';
import { setOutboundPolicyForTests } from '@scrapeforge/shared';
import { tier4Fetch } from '../../src/engine/tier4-browser.js';
import { tier4StealthFetch } from '../../src/engine/tier4-stealth.js';
import { BrowserPool } from '../../src/browser/pool.js';
import { findChromium } from '../../../../tests/latency/lib/chromium-path.js';
import { PUBLIC_IP, html, redirect, routes, startServer, useFixturePolicy, type FixtureServer } from '../net/fixtures.js';
import { MARKERS, challengeTargetPage, jsChallengePage } from './pages.js';

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || findChromium() || undefined;

const REAL = '<!doctype html><html><head><title>Real</title></head><body><h1>Real content</h1>' +
  '<p>The page behind the challenge, served once the clearance cookie is set. REAL-PAGE-OK</p></body></html>';

// Cloudflare-style: 403 + interstitial without the clearance cookie; the
// interstitial sets it and reloads the same URL.
const COOKIE_CHALLENGE =
  '<!doctype html><html><head><title>Just a moment...</title></head><body><div id="challenge-running">' +
  '<h1>Checking your browser before accessing the site.</h1></div><script>setTimeout(function () {' +
  "document.cookie = 'clearance=1; path=/'; location.reload(); }, 400);</script></body></html>";

const STUCK_CHALLENGE =
  '<!doctype html><html><head><title>Just a moment...</title></head><body><div id="challenge-running">' +
  '<h1>Checking your browser before accessing the site.</h1></div><script>var n = 0;</script></body></html>';

// Starts a navigation that never commits (204 No Content): the document stays.
const STAYS = '<!doctype html><html><head><title>Stays</title></head><body><h1>Stays</h1>' +
  "<p>This document stays. STAYS-OK</p><script>setTimeout(function () { location.href = '/no-content'; }, 50);</script></body></html>";

const NOT_FOUND = '<!doctype html><html><head><title>Not found</title></head><body><h1>Not found</h1>' +
  '<p>There is no page at this address, and the server says so with a 404 status.</p></body></html>';

// A 404 document whose script rewrites the URL without navigating.
const NOT_FOUND_PUSHSTATE = '<!doctype html><html><head><title>Not found</title></head><body><h1>Not found</h1>' +
  "<p>Missing page.</p><script>history.replaceState(null, '', '/somewhere-else');</script></body></html>";

describe.skipIf(!chromiumPath)('browser tier status with a real Chromium', () => {
  let pool: BrowserPool;
  let site: FixtureServer;
  let context: BrowserContext;

  beforeAll(async () => {
    site = await startServer(
      PUBLIC_IP,
      routes({
        '/guarded': (req, res) => {
          if (/(?:^|;\s*)clearance=1/.test(req.headers.cookie ?? '')) return html(REAL)(req, res, '');
          return html(COOKIE_CHALLENGE, 403)(req, res, '');
        },
        '/challenge-503': html(jsChallengePage('/real', 300), 503),
        '/real': html(challengeTargetPage()),
        '/missing': html(NOT_FOUND, 404),
        '/missing-pushstate': html(NOT_FOUND_PUSHSTATE, 404),
        '/moved': redirect(302, '/real'),
        '/stuck': html(STUCK_CHALLENGE, 403),
        '/stays': html(STAYS),
        '/no-content': (_req, res) => {
          res.writeHead(204);
          res.end();
        },
      }),
    );
    pool = new BrowserPool(1, 100, 30 * 60 * 1000, { executablePath: chromiumPath, logger: { log() {}, warn() {} } });
    await pool.initialize();
  }, 30_000);

  afterAll(async () => {
    await pool?.shutdown();
    await site?.close();
  });

  beforeEach(async () => {
    useFixturePolicy();
    context = await pool.acquire(5_000);
  });

  afterEach(() => {
    pool.release(context);
    setOutboundPolicyForTests(null);
  });

  for (const [name, fetchTier] of [
    ['tier4Fetch', tier4Fetch],
    ['tier4StealthFetch', tier4StealthFetch],
  ] as const) {
    it(`${name}: a challenge that reloads the page reports the real page's status`, async () => {
      const r = await fetchTier(`${site.origin}/guarded`, context, { timeout: 10_000 });
      expect(r.html).toContain('REAL-PAGE-OK');
      expect(r.statusCode).toBe(200);
    }, 20_000);

    it(`${name}: a challenge that navigates elsewhere reports the target's status`, async () => {
      const r = await fetchTier(`${site.origin}/challenge-503`, context, { timeout: 10_000 });
      expect(r.html).toContain(MARKERS.challenge);
      expect(r.statusCode).toBe(200);
    }, 20_000);

    it(`${name}: an error page stays an error, also after a script rewrites the URL`, async () => {
      expect((await fetchTier(`${site.origin}/missing`, context, { timeout: 10_000 })).statusCode).toBe(404);
      const rewritten = await fetchTier(`${site.origin}/missing-pushstate`, context, { timeout: 10_000 });
      expect(rewritten.html).toContain('Missing page.');
      expect(rewritten.statusCode).toBe(404);
    }, 20_000);

    it(`${name}: a navigation that never commits does not change the status`, async () => {
      const before = site.requests.filter((r) => r.url === '/no-content').length;
      const r = await fetchTier(`${site.origin}/stays`, context, { timeout: 10_000 });
      expect(site.requests.filter((q) => q.url === '/no-content').length).toBe(before + 1);
      expect(r.html).toContain('STAYS-OK');
      expect(r.statusCode).toBe(200);
    }, 20_000);

    it(`${name}: a redirect reports the final response's status`, async () => {
      const r = await fetchTier(`${site.origin}/moved`, context, { timeout: 10_000 });
      expect(r.html).toContain(MARKERS.challenge);
      expect(r.statusCode).toBe(200);
    }, 20_000);
  }

  it('a challenge that never clears keeps its own status', async () => {
    const r = await tier4Fetch(`${site.origin}/stuck`, context, { timeout: 3_000 });
    expect(r.html).toContain('challenge-running');
    expect(r.statusCode).toBe(403);
  }, 20_000);
});
