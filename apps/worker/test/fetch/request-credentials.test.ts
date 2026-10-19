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
import { addBrowserCookies, browserCredentials, cookieHeader, cookiesFor, headersWithCookies, sendableHeaders } from '../../src/engine/request-credentials.js';
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

  it('browsers get the cookies (a custom Cookie header too); headers browsers send anyway apart from the others', () => {
    const c = browserCredentials(
      new URL('https://shop.example.com/p'),
      { Cookie: 'pre=0', Authorization: 'Bearer t', 'Accept-Language': 'de-DE', 'X-Tenant': 'acme' },
      [{ name: 'sid', value: 'abc', domain: 'example.com' }],
    );
    expect(c.headers).toEqual({ 'Accept-Language': 'de-DE' });
    expect(c.secretHeaders).toEqual({ Authorization: 'Bearer t', 'X-Tenant': 'acme' });
    expect(c.cookies).toEqual([
      { name: 'pre', value: '0', domain: 'shop.example.com', path: '/', secure: true },
      { name: 'sid', value: 'abc', domain: '.example.com', path: '/', secure: true },
    ]);
  });

  it('a host-only cookie keeps its own path in a browser (two cookies of one name stay apart)', () => {
    const c = browserCredentials(new URL('https://h.example/admin/panel'), undefined, [{ name: 'session', value: 'A', path: '/admin' }, { name: 'session', value: 'B' }]);
    expect(c.cookies).toEqual([
      { name: 'session', value: 'A', domain: 'h.example', path: '/admin', secure: true },
      { name: 'session', value: 'B', domain: 'h.example', path: '/', secure: true },
    ]);
    // Over plain http they cannot be Secure.
    expect(browserCredentials(new URL('http://h.example/'), undefined, [{ name: 'a', value: '1' }]).cookies[0].secure).toBeUndefined();
  });

  it('drops cookies with any control character, and headers no tier could send', () => {
    expect(cookiesFor(url, [{ name: 'tab', value: 'a\tb' }, { name: 'soh', value: 'a\u0001b' }, { name: 'del', value: 'a\u007fb' }, { name: 'ok', value: '1' }]).map((c) => c.name)).toEqual(['ok']);
    expect(sendableHeaders({ 'X Api Key': 'k', 'X-Ok': 'v', 'X-Bad': 'v\r\n', 'X-Tab': 'a\tb', 'X-City': '東京', 'X-Latin': 'Zürich' })).toEqual({ 'X-Ok': 'v', 'X-Tab': 'a\tb', 'X-Latin': 'Zürich' });
    expect(headersWithCookies('https://shop.example.com/', { 'X Api Key': 'k', 'X-Ok': 'v' }, undefined)).toEqual({ 'X-Ok': 'v' });
    expect(browserCredentials(url, { 'Bad Name': 'x', Authorization: 'Bearer t' }, undefined).secretHeaders).toEqual({ Authorization: 'Bearer t' });
  });

  it('a cookie the browser refuses does not lose the others', async () => {
    const added: string[] = [];
    const context = {
      async addCookies(list: Array<{ name: string }>) {
        if (list.some((c) => c.name === 'refused')) throw new Error('Invalid cookie fields');
        added.push(...list.map((c) => c.name));
      },
    };
    await addBrowserCookies(context, [{ name: 'a', value: '1', domain: 'h', path: '/' }, { name: 'refused', value: '2', domain: 'h', path: '/' }, { name: 'b', value: '3', domain: 'h', path: '/' }]);
    expect(added).toEqual(['a', 'b']);
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

type Res = { writeHead(c: number, h: Record<string, string>): void; end(b: string): void };
const authed = (req: { headers: Record<string, string | string[] | undefined> }) => req.headers.authorization === 'Bearer secret-token';
const sendPage = (res: Res, title: string, h1: string, code = 200) => {
  res.writeHead(code, { 'content-type': 'text/html' });
  res.end(
    `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${h1}</h1><p>${'Revenue, costs and margins for every region and quarter of the year. '.repeat(8)}</p>` +
      `<p id="at"></p><script>document.getElementById('at').textContent = 'at:' + location.pathname + location.hash;</script></main></body></html>`,
  );
};
/** A subresource behind Basic auth: without the header, a 401 challenge. */
const gated = (req: { headers: Record<string, string | string[] | undefined> }, res: Res, type: string, body: string) => {
  if (!authed(req)) {
    res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Basic realm="staging"' });
    res.end('unauthorized');
    return;
  }
  res.writeHead(200, { 'content-type': type });
  res.end(body);
};

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
      '/with-redirected-image': html(`<!doctype html><html><head><title>Gallery</title></head><body><main><h1>Gallery</h1><p>${'Photos from the account owner, sorted by date and album. '.repeat(8)}</p><img src="/img"></main></body></html>`),
      '/img': (req, res, body) => redirect(302, `${thirdPartyOrigin}/pixel.gif`)(req, res, body),
      '/reports': (req, res, body) => redirect(301, '/reports/')(req, res, body),
      '/reports/': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        const ok = req.headers.authorization === 'Bearer secret-token';
        res.end(`<!doctype html><html><head><title>Reports</title></head><body><main><h1>${ok ? 'Quarterly reports' : 'Login required'}</h1><p>${'Revenue, costs and margins for every region and quarter of the year. '.repeat(8)}</p></main></body></html>`);
      },
      '/live': html(`<!doctype html><html><head><title>Live</title></head><body><main><h1>Live feed</h1><p>${'Updates from the account appear here as they happen. '.repeat(8)}</p><p id="feed">waiting</p><script>new EventSource('/events').onmessage = (e) => { document.getElementById('feed').textContent = 'got:' + e.data; };</script></main></body></html>`),
      // Behind header auth, as on a Basic-auth staging host or an auth proxy.
      '/guide': redirect(301, '/guide/'),
      '/guide/': (req, res) => authed(req) ? sendPage(res, 'Guide', 'Guide OK') : sendPage(res, 'Unauthorized', 'Unauthorized', 401),
      '/dash': redirect(301, '/dash/'),
      '/dash/': (req, res, body) => (authed(req) ? sendPage(res, 'Dashboard', 'Dashboard') : redirect(302, '/login?next=/dash/')(req, res, body)),
      '/login': (_req, res) => sendPage(res, 'Login', 'Login form'),
      '/sso-app': redirect(301, '/sso-app/'),
      '/sso-app/': (req, res, body) => (authed(req) ? sendPage(res, 'App', 'App home') : redirect(302, `${thirdPartyOrigin}/authorize`)(req, res, body)),
      '/spa': html(
        `<!doctype html><html><head><title>Orders</title><link rel="stylesheet" href="/static/app.css"><script src="/static/app.js" defer></script></head>` +
          `<body><main><h1 id="state">Loading</h1><p>${'Orders placed by this account, newest first, with their status. '.repeat(8)}</p><p id="orders">none</p></main></body></html>`,
      ),
      '/static/app.js': (req, res) =>
        gated(req, res, 'application/javascript', "document.getElementById('state').textContent = 'Rendered'; fetch('/api/orders').then((r) => r.text()).then((t) => { document.getElementById('orders').textContent = 'orders:' + t; });"),
      '/static/app.css': (req, res) => gated(req, res, 'text/css', 'main { display: block }'),
      '/api/orders': redirect(301, '/api/orders/'),
      '/api/orders/': (req, res) => {
        res.writeHead(authed(req) ? 200 : 401, { 'content-type': 'application/json' });
        res.end(authed(req) ? '["o1"]' : '{"error":"unauthorized"}');
      },
      '/events': (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('data: hello\n\n');
        // The stream stays open, as a live feed does.
      },
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

  it('a redirect to another origin carries none of the custom headers (navigation and subresources)', async () => {
    const ctx = await pool.acquire();
    try {
      await tier4Fetch(`${site.origin}/to-other`, ctx, { ...OPTIONS, timeout: 15_000 });
    } finally {
      pool.release(ctx);
    }
    const landing = samePortless.requests.find((x) => x.url === '/landing');
    expect(landing).toBeDefined();
    expect(landing!.headers.authorization).toBeUndefined();
    expect(landing!.headers['x-tenant']).toBeUndefined();
    // The target's own request got them.
    const first = site.requests.find((x) => x.url === '/to-other')!;
    expect(first.headers.authorization).toBe('Bearer secret-token');

    // A same-origin image that redirects to a third-party host.
    site.requests.length = 0;
    thirdParty.requests.length = 0;
    const ctx2 = await pool.acquire();
    try {
      await tier4Fetch(`${site.origin}/with-redirected-image`, ctx2, { ...OPTIONS, timeout: 15_000 });
    } finally {
      pool.release(ctx2);
    }
    // The target's own image gets them; the third-party host it redirects to does not.
    expect(site.requests.find((x) => x.url === '/img')?.headers.authorization).toBe('Bearer secret-token');
    const cdn = thirdParty.requests.find((x) => x.url === '/pixel.gif');
    expect(cdn).toBeDefined();
    expect(cdn!.headers.authorization).toBeUndefined();
    expect(cdn!.headers['x-tenant']).toBeUndefined();
  }, 60_000);

  it('a request carrying custom headers is fetched through the egress guard too', async () => {
    // "public.test" resolves only through the egress proxy's (test) resolver:
    // a fetch that went around the guard would fail here.
    const ctx = await pool.acquire();
    try {
      const r = await tier4Fetch(`http://public.test:${site.port}/account`, ctx, { ...OPTIONS, timeout: 15_000 });
      expect(r.html).toContain('Your account');
    } finally {
      pool.release(ctx);
    }
    expect(site.requests.find((x) => x.url === '/account')?.headers.authorization).toBe('Bearer secret-token');
  }, 60_000);

  it('a redirect within the target origin keeps the credential (the redirect target is loaded with it)', async () => {
    const ctx = await pool.acquire();
    try {
      const r = await tier4Fetch(`${site.origin}/reports`, ctx, { ...OPTIONS, timeout: 15_000 });
      expect(r.html).toContain('Quarterly reports');
    } finally {
      pool.release(ctx);
    }
    // No hop went without it.
    expect(site.requests.filter((x) => x.url.startsWith('/reports')).every((x) => x.headers.authorization === 'Bearer secret-token')).toBe(true);
  }, 60_000);

  it.each([
    ['/guide#install', 'Guide OK', '/guide/#install'],
    ['/dash', 'Dashboard', '/dash/'],
    ['/sso-app', 'App home', '/sso-app/'],
  ])('%s: every same-origin redirect hop keeps the credential (a fragment, a hop that would go to a login page or an IdP)', async (path, h1, final) => {
    const ctx = await pool.acquire();
    try {
      const r = await tier4Fetch(`${site.origin}${path}`, ctx, { ...OPTIONS, timeout: 15_000 });
      expect(r.html).toContain(h1);
      // The page has its own address (for its relative links), fragment kept.
      expect(r.html).toContain(`at:${final}`);
    } finally {
      pool.release(ctx);
    }
    expect(site.requests.filter((x) => x.url.startsWith('/login'))).toEqual([]);
    expect(thirdParty.requests.filter((x) => x.url.startsWith('/authorize'))).toEqual([]);
  }, 60_000);

  it("the page's own scripts, styles and API calls get the credential, an API redirect within the origin too", async () => {
    const ctx = await pool.acquire();
    try {
      const r = await tier4Fetch(`${site.origin}/spa`, ctx, { ...OPTIONS, timeout: 15_000 });
      expect(r.html).toContain('Rendered');
      expect(r.html).toContain('orders:["o1"]');
    } finally {
      pool.release(ctx);
    }
    for (const path of ['/static/app.js', '/static/app.css', '/api/orders', '/api/orders/']) {
      expect(site.requests.find((x) => x.url === path)?.headers.authorization, path).toBe('Bearer secret-token');
    }
  }, 60_000);

  it('headers a browser sends anyway ride on Chromium\'s own request (its fingerprint and Sec-Fetch headers kept)', async () => {
    const ctx = await pool.acquire();
    try {
      await tier4Fetch(`${site.origin}/classic`, ctx, { headers: { 'Accept-Language': 'de-DE' }, timeout: 15_000 });
    } finally {
      pool.release(ctx);
    }
    const doc = site.requests.find((x) => x.url === '/classic')!;
    expect(doc.headers['accept-language']).toBe('de-DE');
    expect(doc.headers['sec-fetch-mode']).toBe('navigate');
  }, 60_000);

  it('a stream on the target origin still streams when the request carries a credential', async () => {
    const ctx = await pool.acquire();
    try {
      const r = await tier4Fetch(`${site.origin}/live`, ctx, { ...OPTIONS, timeout: 15_000 });
      expect(r.html).toContain('got:hello');
    } finally {
      pool.release(ctx);
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
