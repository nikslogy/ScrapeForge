// Browser tiers against a real local Chromium (skipped when none is installed).
// Fixture pages on 127.0.0.1 ("public" under the test policy) try to reach a
// server on 127.0.0.2 ("internal") in every way a page can.

import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'patchright';
import { OutboundBlockedError, setOutboundPolicyForTests } from '@scrapeforge/shared';
import { tier4Fetch } from '../../src/engine/tier4-browser.js';
import { tier4StealthFetch } from '../../src/engine/tier4-stealth.js';
import {
  INTERNAL_IP,
  PUBLIC_IP,
  html,
  redirect,
  routes,
  startServer,
  useFixturePolicy,
  type FixtureServer,
} from './fixtures.js';

function findChromium(): string | undefined {
  const candidates = [
    process.env.CHROMIUM_EXECUTABLE,
    chromium.executablePath(),
    process.env.PLAYWRIGHT_BROWSERS_PATH && `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium`,
  ];
  return candidates.find((p): p is string => !!p && existsSync(p));
}

const executablePath = findChromium();

describe.skipIf(!executablePath)('browser tiers with a real Chromium', () => {
  let browser: Browser;
  let context: BrowserContext;
  let site: FixtureServer;
  let cdn: FixtureServer; // second public origin
  let internal: FixtureServer;

  beforeAll(async () => {
    internal = await startServer(INTERNAL_IP, html('<p>INTERNAL SECRET</p>'));
    cdn = await startServer(PUBLIC_IP, html('pixel'));
    const inside = (path: string) => `${internal.origin}${path}`;
    site = await startServer(
      PUBLIC_IP,
      routes({
        '/plain': html(`<html><body><p>PLAIN</p>
          <script>document.body.dataset.chrome = typeof window.chrome;</script></body></html>`),
        '/subresources': html(`<html><head>
            <link rel="stylesheet" href="${inside('/s.css')}">
            <script src="${inside('/s.js')}"></script>
          </head><body>
            <p>VISIBLE</p>
            <img src="${inside('/img.png')}">
            <iframe src="${inside('/frame')}"></iframe>
            <script>
              fetch('${inside('/api')}').catch(() => {});
              new Image().src = '${inside('/beacon')}';
              navigator.sendBeacon && navigator.sendBeacon('${inside('/send-beacon')}', 'x');
            </script>
          </body></html>`),
        '/redirect-to-internal': redirect(302, inside('/secret')),
        '/bounce': redirect(302, inside('/pixel.png')),
        '/bounce-cdn': (req, res, body) => redirect(302, `${cdn.origin}/pixel.png`)(req, res, body),
        '/cdn-redirect': html('<html><body><p>CDN IMAGE</p><img src="/bounce-cdn"></body></html>'),
        '/subresource-redirect': html('<html><body><p>HAS BOUNCING IMAGE</p><img src="/bounce"></body></html>'),
        '/websocket': html(`<html><body><p>SOCKET</p>
          <script>try { new WebSocket('ws://${INTERNAL_IP}:${internal.port}/'); } catch (e) {}</script>
          </body></html>`),
      }),
    );

    browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await Promise.all([site?.close(), cdn?.close(), internal?.close()]);
  });

  beforeEach(async () => {
    useFixturePolicy();
    site.requests.length = 0;
    internal.requests.length = 0;
    context = await browser.newContext();
  });

  afterEach(async () => {
    await context.close();
    setOutboundPolicyForTests(null);
  });

  it('loads a public page with init scripts intact', async () => {
    const r = await tier4Fetch(`${site.origin}/plain`, context);
    expect(r.statusCode).toBe(200);
    expect(r.html).toContain('PLAIN');
    // FINGERPRINT_INIT_SCRIPT still runs with the route guards installed.
    expect(r.html).toContain('data-chrome="object"');
  });

  it.each([true, false])(
    'never lets sub-resources reach an internal address (blockResources=%s)',
    async (blockResources) => {
      const r = await tier4Fetch(`${site.origin}/subresources`, context, { blockResources });
      expect(r.html).toContain('VISIBLE');
      expect(r.html).not.toContain('INTERNAL SECRET');
      expect(internal.requests).toEqual([]);
    },
  );

  // Regression: leaving allowed requests to Patchright's default continuation
  // stalled networkidle for cross-origin redirects until its 4 s timeout.
  it('does not stall on a cross-origin redirected sub-resource', async () => {
    const r = await tier4Fetch(`${site.origin}/cdn-redirect`, context);
    expect(r.html).toContain('CDN IMAGE');
    expect(cdn.requests.map((q) => q.url)).toEqual(['/pixel.png']);
    expect(r.latencyMs).toBeLessThan(3_000);
  });

  it('refuses an internal first URL before opening a page', async () => {
    await expect(tier4Fetch(`${internal.origin}/`, context)).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(context.pages()).toHaveLength(0);
    expect(internal.requests).toEqual([]);
  });

  it('fails a navigation that redirects to an internal address and returns nothing', async () => {
    await expect(tier4Fetch(`${site.origin}/redirect-to-internal`, context)).rejects.toBeInstanceOf(
      OutboundBlockedError,
    );
  });

  // Route handlers never see redirect hops, so the hop itself is sent (blind
  // SSRF, see outbound-guard.ts); what matters is that nothing is returned.
  it('fails when a sub-resource redirect reaches an internal address', async () => {
    await expect(tier4Fetch(`${site.origin}/subresource-redirect`, context)).rejects.toBeInstanceOf(
      OutboundBlockedError,
    );
  });

  it('fails when the page opens a WebSocket to an internal address', async () => {
    await expect(tier4Fetch(`${site.origin}/websocket`, context)).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it('guards pages without their own guard (popups) through the context-level route', async () => {
    await tier4Fetch(`${site.origin}/plain`, context); // installs the context guard
    const popup = await context.newPage(); // no page-level route, like a window.open popup
    await expect(popup.goto(`${internal.origin}/popup`)).rejects.toThrow(/ERR_FAILED/);
    const other = await context.newPage();
    const allowed = await other.goto(`${site.origin}/plain`);
    expect(allowed?.status()).toBe(200);
    expect(internal.requests).toEqual([]);
  });

  it('stealth tier: guards sub-resources and redirects too', async () => {
    const r = await tier4StealthFetch(`${site.origin}/subresources`, context, { blockResources: false });
    expect(r.html).toContain('VISIBLE');
    expect(internal.requests).toEqual([]);
    await expect(tier4StealthFetch(`${site.origin}/redirect-to-internal`, context)).rejects.toBeInstanceOf(
      OutboundBlockedError,
    );
  });
});
