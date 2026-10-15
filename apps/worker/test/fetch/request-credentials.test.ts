// The request's cookies and custom headers reach the target in every tier,
// and never a third party: HTTP tiers drop them on cross-origin redirect
// hops, browser tiers add headers only to the target's origin and leave
// cookies to the browser's own domain matching. A pooled context carries
// no cookie into the next fetch.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { setOutboundPolicyForTests } from '@scrapeforge/shared';
import { BrowserPool } from '../../src/browser/pool.js';
import { SmartRouter } from '../../src/engine/router.js';
import { tier4Fetch } from '../../src/engine/tier4-browser.js';
import { browserCredentials, cookieHeader, cookiesFor, headersWithCookies } from '../../src/engine/request-credentials.js';
import { findChromium } from '../../../../tests/latency/lib/chromium-path.js';
import { smallPage } from '../../../../tests/latency/lib/fixtures.js';
import { PUBLIC_IP, html, redirect, routes, startServer, useFixturePolicy, type FixtureServer } from '../net/fixtures.js';

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

describe('cookie matching', () => {
  const url = new URL('https://shop.example.com/account/orders');

  it('sends host-only cookies to the host, domain cookies to subdomains, and path-matched ones only', () => {
    const cookies = [
      { name: 'host', value: '1' },
      { name: 'parent', value: '2', domain: '.example.com' },
      { name: 'other', value: '3', domain: 'other.com' },
      { name: 'acct', value: '4', path: '/account' },
      { name: 'cart', value: '5', path: '/cart' },
      { name: 'accounting', value: '6', path: '/acc' },
    ];
    expect(cookiesFor(url, cookies).map((c) => c.name)).toEqual(['host', 'parent', 'acct']);
    expect(cookieHeader(url, cookies)).toBe('host=1; parent=2; acct=4');
  });

  it('drops cookies that would split the header', () => {
    expect(cookiesFor(url, [{ name: 'a', value: '1\r\nX-Evil: 1' }, { name: 'b;c', value: '2' }, { name: 'ok', value: '3' }]).map((c) => c.name)).toEqual(['ok']);
  });

  it('appends to a custom Cookie header and keeps the other headers', () => {
    expect(headersWithCookies('https://shop.example.com/', { Authorization: 'Bearer t', cookie: 'pre=0' }, [{ name: 'sid', value: 'abc' }])).toEqual({
      Authorization: 'Bearer t',
      Cookie: 'pre=0; sid=abc',
    });
    expect(headersWithCookies('https://shop.example.com/', { 'X-A': '1' }, undefined)).toEqual({ 'X-A': '1' });
  });

  it('browsers get the cookies (a custom Cookie header too) and the other headers', () => {
    const c = browserCredentials(new URL('https://shop.example.com/p'), { Cookie: 'pre=0', Authorization: 'Bearer t' }, [{ name: 'sid', value: 'abc', domain: 'example.com' }]);
    expect(c.headers).toEqual({ Authorization: 'Bearer t' });
    expect(c.cookies).toEqual([
      { name: 'pre', value: '0', url: 'https://shop.example.com/' },
      { name: 'sid', value: 'abc', domain: '.example.com', path: '/' },
    ]);
  });
});

let site: FixtureServer;
// Same host, another port: another origin, but the same cookie host (cookies are not port-scoped).
let samePortless: FixtureServer;
// Another host altogether, like a real CDN: "public.test", which the test
// policy resolves to 127.0.0.1 (Chromium connects through the egress proxy,
// which resolves names itself), so its cookies are its own.
let thirdParty: FixtureServer;
let thirdPartyOrigin = '';

const cdnHandler = (_req: unknown, res: { writeHead(c: number, h: Record<string, string>): void; end(b: string): void }) => {
  res.writeHead(200, { 'content-type': 'application/javascript' });
  res.end('/* cdn */');
};

const ECHO_PAGE = (cdns: string[]) =>
  '<!doctype html><html><head><title>Account</title>' +
  cdns.map((cdn) => `<script src="${cdn}/lib.js"></script>`).join('') +
  `</head><body><main><h1>Your account</h1>` +
  `<p>${'Order history, saved addresses and payment methods for this account. '.repeat(8)}</p>` +
  cdns.map((cdn) => `<img src="${cdn}/pixel.gif">`).join('') +
  `<p id="cookies"></p><script>document.getElementById('cookies').textContent = 'cookies: ' + document.cookie;</script></main></body></html>`;


beforeAll(async () => {
  samePortless = await startServer(PUBLIC_IP, cdnHandler as never);
  thirdParty = await startServer(PUBLIC_IP, cdnHandler as never);
  thirdPartyOrigin = `http://public.test:${thirdParty.port}`;
  site = await startServer(
    PUBLIC_IP,
    routes({
      '/account': html(ECHO_PAGE([samePortless.origin, thirdPartyOrigin])),
      '/classic': html(smallPage()),
      '/to-other': (req, res, body) => redirect(302, `${samePortless.origin}/landing`)(req, res, body),
    }),
  );
});

afterAll(async () => {
  await Promise.all([site?.close(), thirdParty?.close(), samePortless?.close()]);
});

beforeEach(() => {
  useFixturePolicy();
  site.requests.length = 0;
  thirdParty.requests.length = 0;
  samePortless.requests.length = 0;
});

afterEach(() => setOutboundPolicyForTests(null));

const OPTIONS = { headers: { Authorization: 'Bearer secret-token', 'X-Tenant': 'acme' }, cookies: [{ name: 'sid', value: 'abc123' }] };

describe('HTTP tiers', () => {
  it('send the cookies and headers to the target', async () => {
    const router = new SmartRouter(new MemoryRedis() as unknown as Redis, vi.fn(async () => { throw new Error('no browser'); }), vi.fn(), { logger: { warn: vi.fn() } });
    const r = await router.route(`${site.origin}/classic`, OPTIONS);
    expect(r.tierUsed).toBe(1);
    const req = site.requests.find((x) => x.url === '/classic')!;
    expect(req.headers.cookie).toBe('sid=abc123');
    expect(req.headers.authorization).toBe('Bearer secret-token');
    expect(req.headers['x-tenant']).toBe('acme');
  });

  it('drop them on a redirect to another origin', async () => {
    const router = new SmartRouter(new MemoryRedis() as unknown as Redis, vi.fn(async () => { throw new Error('no browser'); }), vi.fn(), { logger: { warn: vi.fn() } });
    await router.route(`${site.origin}/to-other`, OPTIONS).catch(() => undefined);
    const landing = samePortless.requests.find((x) => x.url === '/landing');
    expect(landing).toBeDefined();
    expect(landing!.headers.cookie).toBeUndefined();
    expect(landing!.headers.authorization).toBeUndefined();
  });
});

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || findChromium() || undefined;

describe.skipIf(!chromiumPath)('browser tiers', () => {
  let pool: BrowserPool;

  beforeAll(async () => {
    pool = new BrowserPool(1, 100, 30 * 60 * 1000, { executablePath: chromiumPath, logger: { log() {}, warn() {} } });
    await pool.initialize();
  }, 30_000);

  afterAll(async () => {
    await pool?.shutdown();
  });

  it('send the cookies and headers to the target only, never to the third-party scripts and images it loads', async () => {
    const ctx = await pool.acquire();
    try {
      const r = await tier4Fetch(`${site.origin}/account`, ctx, { ...OPTIONS, timeout: 15_000 });
      expect(r.html).toContain('cookies: sid=abc123');
    } finally {
      pool.release(ctx);
    }
    const doc = site.requests.find((x) => x.url === '/account')!;
    expect(doc.headers.cookie).toBe('sid=abc123');
    expect(doc.headers.authorization).toBe('Bearer secret-token');
    expect(doc.headers['x-tenant']).toBe('acme');
    // Another host: neither headers nor cookies.
    expect(thirdParty.requests.length).toBeGreaterThan(0);
    for (const req of thirdParty.requests) {
      expect(req.headers.authorization, req.url).toBeUndefined();
      expect(req.headers['x-tenant'], req.url).toBeUndefined();
      expect(req.headers.cookie, req.url).toBeUndefined();
    }
    // Same host, other port: another origin, so no custom headers (the
    // browser itself sends the host's cookies there, as it would anywhere).
    expect(samePortless.requests.length).toBeGreaterThan(0);
    for (const req of samePortless.requests) {
      expect(req.headers.authorization, req.url).toBeUndefined();
      expect(req.headers['x-tenant'], req.url).toBeUndefined();
    }
  }, 60_000);

  it('the next fetch on the same pooled context carries none of them', async () => {
    const first = await pool.acquire();
    try {
      await tier4Fetch(`${site.origin}/account`, first, { ...OPTIONS, timeout: 15_000 });
    } finally {
      pool.release(first);
    }
    site.requests.length = 0;
    const second = await pool.acquire();
    try {
      const r = await tier4Fetch(`${site.origin}/account`, second, { timeout: 15_000 });
      expect(r.html).not.toContain('sid=abc123');
    } finally {
      pool.release(second);
    }
    const doc = site.requests.find((x) => x.url === '/account')!;
    expect(doc.headers.cookie).toBeUndefined();
    expect(doc.headers.authorization).toBeUndefined();
  }, 60_000);
});
