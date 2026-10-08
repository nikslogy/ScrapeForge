// SmartRouter with the real tier functions against local servers. 127.0.0.1
// counts as public and 127.0.0.2 as internal (test outbound policy). The
// browser cases need a local Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE or the
// newest install found) and are skipped without one.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { BrowserContext } from 'patchright';
import { DnsLookupError, OutboundBlockedError, setOutboundPolicyForTests } from '@scrapeforge/shared';
import { SmartRouter } from '../../src/engine/router.js';
import { BrowserPool } from '../../src/browser/pool.js';
import { findChromium } from '../../../../tests/latency/lib/chromium-path.js';
import { smallPage } from '../../../../tests/latency/lib/fixtures.js';
import { INTERNAL_IP, PUBLIC_IP, html, redirect, routes, startServer, useFixturePolicy, type FixtureServer } from '../net/fixtures.js';

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

const SPA =
  '<!doctype html><html><head><title>SPA</title></head><body><div id="root"></div><script>' +
  "document.getElementById('root').innerHTML = '<h1>Rendered</h1><p>' + 'Rendered in the browser by a script. '.repeat(30) + '</p>';" +
  '</script></body></html>';

let site: FixtureServer;
let internal: FixtureServer;
const hits = (path: string) => site.requests.filter((r) => r.url.split('?')[0] === path).length;

beforeAll(async () => {
  internal = await startServer(INTERNAL_IP, html('<p>INTERNAL SECRET</p>'));
  site = await startServer(
    PUBLIC_IP,
    routes({
      '/classic': html(smallPage()),
      '/spa': html(SPA),
      '/to-internal': (req, res, body) => redirect(302, `${internal.origin}/secret`)(req, res, body),
    }),
  );
});

afterAll(async () => {
  await Promise.all([site?.close(), internal?.close()]);
});

beforeEach(() => {
  useFixturePolicy();
  site.requests.length = 0;
  internal.requests.length = 0;
});

afterEach(() => setOutboundPolicyForTests(null));

function noBrowserRouter() {
  const acquire = vi.fn(async (): Promise<BrowserContext> => {
    throw new Error('browser must not be used');
  });
  const router = new SmartRouter(new MemoryRedis() as unknown as Redis, acquire, vi.fn(), { logger: { warn: vi.fn() } });
  return { router, acquire };
}

describe('SmartRouter with real HTTP tiers', () => {
  it('accepts the classic example.com page at T1 with a single fetch', async () => {
    const { router, acquire } = noBrowserRouter();
    const t0 = performance.now();
    const r = await router.route(`${site.origin}/classic`, {});
    const ms = performance.now() - t0;

    expect(r).toMatchObject({ tierUsed: 1, statusCode: 200 });
    expect(r.html).toContain('Example Domain');
    expect(hits('/classic')).toBe(1);
    expect(acquire).not.toHaveBeenCalled();
    expect(ms).toBeLessThan(1_000);
  });

  it('stops at a redirect into the internal network: no further tier, no browser', async () => {
    const { router, acquire } = noBrowserRouter();
    await expect(router.route(`${site.origin}/to-internal`, {})).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(hits('/to-internal')).toBe(1);
    expect(internal.requests).toHaveLength(0);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('fails fast on a name that does not resolve', async () => {
    const { router, acquire } = noBrowserRouter();
    const t0 = performance.now();
    await expect(router.route('http://nowhere.test/page', {})).rejects.toBeInstanceOf(DnsLookupError);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(acquire).not.toHaveBeenCalled();
  });
});

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || findChromium() || undefined;

describe.skipIf(!chromiumPath)('SmartRouter with real browser tiers', () => {
  let pool: BrowserPool;

  beforeAll(async () => {
    pool = new BrowserPool(2, 100, 30 * 60 * 1000, { executablePath: chromiumPath, logger: { log() {}, warn() {} } });
    await pool.initialize();
  }, 30_000);

  afterAll(async () => {
    await pool?.shutdown();
  });

  it('learns that a client-rendered page needs T4 and then fetches it once per request', async () => {
    const router = new SmartRouter(
      new MemoryRedis() as unknown as Redis,
      () => pool.acquire(),
      (ctx) => pool.release(ctx),
      { random: () => 0.99, logger: { warn: vi.fn() } },
    );
    const url = `${site.origin}/spa`;
    const perRequest: number[] = [];
    for (let i = 0; i < 4; i++) {
      const before = hits('/spa');
      const r = await router.route(url, {});
      await router.drainStrategyWrites();
      expect(r.tierUsed).toBe(4);
      expect(r.html).toContain('Rendered in the browser');
      perRequest.push(hits('/spa') - before);
    }
    // T1 + T2 + T4 while learning, then T4 alone.
    expect(perRequest).toEqual([3, 3, 3, 1]);
  }, 60_000);
});
