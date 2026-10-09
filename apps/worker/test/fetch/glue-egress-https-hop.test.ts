// An HTTPS navigation hop the egress guard refuses at CONNECT reaches
// Chromium only as net::ERR_TUNNEL_CONNECTION_FAILED. Both browser tiers must
// report it as the OutboundBlockedError it is (a security block no other tier
// can fix, never retried), not as a generic navigation failure that makes the
// router escalate and the job end as "All tiers exhausted". A tunnel failure
// the guard did not cause stays a plain navigation error. Real Chromium;
// skipped when none is installed. Test policy: 127.0.0.1 "public",
// 127.0.0.2 "internal".

import { createServer } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserContext } from 'patchright';
import { OutboundBlockedError, setOutboundPolicyForTests } from '@scrapeforge/shared';
import { BrowserPool } from '../../src/browser/pool.js';
import { tier4Fetch } from '../../src/engine/tier4-browser.js';
import { tier4StealthFetch } from '../../src/engine/tier4-stealth.js';
import { egressGuard } from '../../src/net/egress.js';
import { findChromium } from '../../../../tests/latency/lib/chromium-path.js';
import { INTERNAL_IP, PUBLIC_IP, html, redirect, routes, startServer, useFixturePolicy, type FixtureServer } from '../net/fixtures.js';

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || findChromium() || undefined;

/** A port on PUBLIC_IP with nothing listening. */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, PUBLIC_IP, () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

describe.skipIf(!chromiumPath)('browser tiers: HTTPS hop refused by the egress guard', () => {
  let site: FixtureServer;
  let internal: FixtureServer;
  let pool: BrowserPool;

  beforeAll(async () => {
    internal = await startServer(INTERNAL_IP, html('<p>INTERNAL SECRET</p>'));
    const dead = await closedPort();
    site = await startServer(
      PUBLIC_IP,
      routes({
        // https on the internal host's port: the guard refuses the CONNECT
        // before anything is sent, so no TLS server is needed there.
        '/https-bounce': redirect(302, `https://${INTERNAL_IP}:${internal.port}/landing`),
        '/script-nav': html(`<html><body><p>SCRIPT NAV PAGE with enough words to be a page.</p>
          <script>setTimeout(function () { location.href = 'https://${INTERNAL_IP}:${internal.port}/later'; }, 50);</script></body></html>`),
        // A public destination whose tunnel fails for another reason (nothing listens).
        '/https-dead': redirect(302, `https://${PUBLIC_IP}:${dead}/landing`),
      }),
    );
    pool = new BrowserPool(1, 100, 30 * 60 * 1000, { executablePath: chromiumPath, logger: { log() {}, warn() {} } });
    await pool.initialize();
  }, 30_000);

  afterAll(async () => {
    await pool?.shutdown();
    await Promise.all([site?.close(), internal?.close()]);
  });

  beforeEach(() => {
    useFixturePolicy();
    internal.requests.length = 0;
  });

  afterEach(() => setOutboundPolicyForTests(null));

  async function withContext<T>(fn: (ctx: BrowserContext) => Promise<T>): Promise<T> {
    const ctx = await pool.acquire();
    try {
      return await fn(ctx);
    } finally {
      pool.release(ctx);
    }
  }

  const tiers = [
    ['tier 4', tier4Fetch],
    ['tier 5 (stealth)', tier4StealthFetch],
  ] as const;

  for (const [name, fetch] of tiers) {
    it(`${name}: a redirect to a refused https destination is an OutboundBlockedError`, async () => {
      const guard = await egressGuard();
      const refused = guard.stats().refused;
      const err = await withContext((ctx) => fetch(`${site.origin}/https-bounce`, ctx, { timeout: 15_000 })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OutboundBlockedError);
      expect((err as Error).message).toContain(INTERNAL_IP);
      expect(guard.stats().refused).toBeGreaterThan(refused);
      expect(internal.requests).toEqual([]);
    });

    it(`${name}: a page script navigating to a refused https destination is an OutboundBlockedError`, async () => {
      const err = await withContext((ctx) => fetch(`${site.origin}/script-nav`, ctx, { timeout: 15_000 })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OutboundBlockedError);
      expect(internal.requests).toEqual([]);
    });

    it(`${name}: a tunnel failure the guard did not cause stays a navigation error`, async () => {
      const err = await withContext((ctx) => fetch(`${site.origin}/https-dead`, ctx, { timeout: 15_000 })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(OutboundBlockedError);
      expect((err as Error).message).toMatch(/net::ERR_/);
    });
  }
});
