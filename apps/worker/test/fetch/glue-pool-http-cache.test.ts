// A pooled browser context serves fetches of different tenants one after the
// other, so its HTTP cache must not outlive a fetch: a response cached while
// serving one request (personalized by that request's headers or cookies)
// would otherwise be served to the next. The pool clears it with the rest of
// the context's state on release. Real Chromium; skipped when none is found.
//
// Pages here are opened without the outbound guard's routes on purpose: route
// interception makes Playwright bypass the cache, which hides it in the
// browser tiers today but is not a guarantee the pool can rely on.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext } from 'patchright';
import { setOutboundPolicyForTests } from '@scrapeforge/shared';
import { BrowserPool } from '../../src/browser/pool.js';
import { findChromium } from '../../../../tests/latency/lib/chromium-path.js';
import { PUBLIC_IP, routes, startServer, useFixturePolicy, type FixtureServer } from '../net/fixtures.js';

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || findChromium() || undefined;

describe.skipIf(!chromiumPath)('BrowserPool: HTTP cache between fetches', () => {
  let site: FixtureServer;
  let pool: BrowserPool;
  let served = 0;

  beforeAll(async () => {
    site = await startServer(
      PUBLIC_IP,
      routes({
        '/page': (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html><body><p id="who">page</p><script src="/account.js"></script></body></html>');
        },
        // Cacheable for 10 minutes, and personal: it names whoever asked first.
        '/account.js': (req, res) => {
          served++;
          res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=600' });
          res.end(`document.getElementById('who').textContent = ${JSON.stringify(`account of ${req.headers['x-tenant'] ?? '?'}`)};`);
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

  afterEach(() => setOutboundPolicyForTests(null));

  async function visitAs(tenant: string): Promise<{ context: BrowserContext; text: string }> {
    useFixturePolicy();
    const context = await pool.acquire();
    try {
      const page = await context.newPage();
      await page.setExtraHTTPHeaders({ 'x-tenant': tenant });
      await page.goto(`${site.origin}/page`, { waitUntil: 'load' });
      const text = await page.locator('#who').innerText();
      await page.close();
      return { context, text };
    } finally {
      pool.release(context);
    }
  }

  async function idle(): Promise<void> {
    // release() cleans in the background; the context is handed out again once clean.
    for (let i = 0; i < 100 && pool.stats().idle === 0; i++) await new Promise((r) => setTimeout(r, 20));
  }

  it('a reused context does not serve the previous fetch’s cached responses', async () => {
    const a = await visitAs('tenant-a');
    expect(a.text).toBe('account of tenant-a');
    await idle();
    const b = await visitAs('tenant-b');
    // Same pooled context (otherwise the test would prove nothing)...
    expect(b.context).toBe(a.context);
    // ...yet the script was fetched again, for tenant-b.
    expect(b.text).toBe('account of tenant-b');
    expect(served).toBe(2);
  });

  it('within one fetch the cache still works', async () => {
    useFixturePolicy();
    const before = served;
    const context = await pool.acquire();
    try {
      const page = await context.newPage();
      await page.goto(`${site.origin}/page`, { waitUntil: 'load' });
      await page.goto(`${site.origin}/page?again`, { waitUntil: 'load' });
      await page.close();
    } finally {
      pool.release(context);
    }
    expect(served - before).toBe(1);
  });
});
