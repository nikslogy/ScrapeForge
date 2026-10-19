// Browser guard logic against fake Playwright objects (no browser needed).

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page, Response, Route } from 'patchright';
import { OutboundBlockedError, setOutboundPolicyForTests } from '@scrapeforge/shared';
import {
  assertNavigationAllowed,
  checkBrowserUrl,
  createOutboundRouteHandler,
  ensureContextOutboundGuard,
  hasPendingSecretFetches,
  installOutboundGuard,
  monitorOutbound,
} from '../../src/browser/outbound-guard.js';
import { shouldBlockResource } from '../../src/browser/resource-blocker.js';
import { INTERNAL_IP, fakeLookup, useFixturePolicy } from './fixtures.js';

beforeEach(() => useFixturePolicy());
afterEach(() => setOutboundPolicyForTests(null));

// ─── fakes ───────────────────────────────────────────────────

interface FakeRequest {
  url(): string;
  resourceType(): string;
  redirectedFrom(): FakeRequest | null;
}

function fakeRequest(url: string, resourceType = 'document', from: FakeRequest | null = null): FakeRequest {
  return { url: () => url, resourceType: () => resourceType, redirectedFrom: () => from };
}

/** Redirect chain request for urls[0] → … → urls[n-1]; returns the last hop. */
function chain(...urls: string[]): FakeRequest {
  let prev: FakeRequest | null = null;
  for (const url of urls) prev = fakeRequest(url, 'document', prev);
  return prev!;
}

function fakeRoute(url: string, resourceType = 'document', opts: { failOnHandle?: boolean } = {}) {
  const calls: string[] = [];
  const handle = (what: string) => async () => {
    calls.push(what);
    if (opts.failOnHandle) throw new Error('Target page, context or browser has been closed');
  };
  const route = {
    request: () => fakeRequest(url, resourceType),
    abort: vi.fn(handle('abort')),
    fallback: vi.fn(handle('fallback')),
    continue: vi.fn(handle('continue')),
  };
  return { route: route as unknown as Route, calls };
}

const asResponse = (request: FakeRequest) => ({ request: () => request }) as unknown as Response;

// ─── checkBrowserUrl ─────────────────────────────────────────

describe('checkBrowserUrl', () => {
  it.each([
    'data:text/html,<p>hi</p>',
    'blob:http://127.0.0.1:3000/2c5b1b0a-7d2a-4b0e-9a41-2f6a1a1b2c3d',
    'about:blank',
    'about:srcdoc',
    'http://public.test/app.js',
    'https://127.0.0.1/', // public under the fixture policy
    'ws://public.test/socket',
    'wss://public.test:8443/socket',
  ])('allows %s', async (url) => {
    expect(await checkBrowserUrl(url)).toBeNull();
  });

  it.each([
    [`http://${INTERNAL_IP}/`, 'address'],
    ['http://169.254.169.254/latest/meta-data/', 'address'],
    ['http://[::ffff:a9fe:a9fe]/', 'address'],
    ['http://internal.test/', 'address'],
    ['http://mixed.test/', 'address'],
    ['http://localhost:8080/', 'hostname'],
    [`ws://${INTERNAL_IP}:6379/`, 'address'],
    ['wss://internal.test/socket', 'address'],
    ['file:///etc/passwd', 'scheme'],
    ['ftp://public.test/x', 'scheme'],
    ['chrome://settings/', 'scheme'],
    ['chrome-extension://abcdef/page.html', 'scheme'],
    ['filesystem:http://public.test/temporary/x', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['not a url', 'invalid-url'],
    ['http://nowhere.test/', 'unverified'], // DNS failure fails closed
  ])('blocks %s (%s)', async (url, reason) => {
    const blocked = await checkBrowserUrl(url);
    expect(blocked).toBeInstanceOf(OutboundBlockedError);
    expect(blocked!.reason).toBe(reason);
  });
});

// ─── route handler ───────────────────────────────────────────

describe('createOutboundRouteHandler', () => {
  const guard = createOutboundRouteHandler({ blockResources: false });
  const guardAndBlock = createOutboundRouteHandler({ blockResources: true });

  it('continues allowed URLs explicitly', async () => {
    const { route, calls } = fakeRoute('http://public.test/');
    await guard(route);
    expect(calls).toEqual(['continue']);
  });

  it.each([
    [`http://${INTERNAL_IP}/x`, 'image'],
    ['http://internal.test/api', 'fetch'],
    ['http://169.254.169.254/', 'document'],
    ['file:///etc/passwd', 'document'],
    ['http://nowhere.test/', 'script'],
  ])('aborts %s (%s)', async (url, type) => {
    const { route, calls } = fakeRoute(url, type);
    await guard(route);
    expect(calls).toEqual(['abort']);
  });

  describe('secret headers', () => {
    const origin = 'http://public.test';
    type Reply = { status: number; location?: string; delayMs?: number };
    /**
     * A route whose fetches (the route's for the first hop, the context's
     * request API for the next ones) answer `replies` in turn (the last one
     * repeats). Like Patchright, route.fetch without postData sends the
     * routed request's own body.
     */
    function secretRoute(url: string, type: string, replies: Reply[], req: { method?: string; postData?: string; nav?: boolean; frame?: 'main' | 'child' } = {}) {
      const order: string[] = [];
      const fetched: Array<Record<string, unknown>> = [];
      const postDataBuffer = () => (req.postData ? Buffer.from(req.postData) : null);
      const answer = async (o: Record<string, unknown>) => {
        fetched.push(o);
        const r = replies[Math.min(fetched.length - 1, replies.length - 1)];
        order.push(`fetch ${String(o.url)}`);
        if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs));
        return {
          status: () => r.status,
          headers: () => (r.location ? { location: r.location } : {}),
          dispose: vi.fn(async () => void order.push('dispose')),
        };
      };
      const context = {
        request: { fetch: vi.fn(async (u: string, o: Record<string, unknown>) => answer({ ...o, url: u, via: 'context' })) },
      };
      const route = {
        request: () => ({
          ...fakeRequest(url, type),
          method: () => req.method ?? 'GET',
          postDataBuffer,
          headers: () => ({ accept: '*/*', ...(req.postData ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }),
          isNavigationRequest: () => req.nav ?? type === 'document',
          frame: () => ({ parentFrame: () => (req.frame === 'child' ? {} : null) }),
        }),
        fetch: vi.fn(async (o: Record<string, unknown>) => answer({ ...o, postData: o.postData ?? postDataBuffer() ?? undefined, via: 'route' })),
        fulfill: vi.fn(async () => void order.push('fulfill')),
        continue: vi.fn(async () => void order.push('continue')),
        abort: vi.fn(async () => void order.push('abort')),
      };
      return { route: route as unknown as Route, raw: route, order, fetched, context: context as unknown as BrowserContext };
    }
    const handler = (context: BrowserContext | undefined, extra: Partial<Parameters<typeof createOutboundRouteHandler>[0]> = {}) =>
      createOutboundRouteHandler({ blockResources: false, origin, extraHeaders: { 'Accept-Language': 'de' }, secretHeaders: { Authorization: 'Bearer t' }, ...(context ? { context } : {}), ...extra });

    it('the requests that make the page are fetched here with them, without following redirects, the body released once served', async () => {
      for (const type of ['document', 'xhr', 'fetch', 'script', 'stylesheet']) {
        const { route, order, fetched, context } = secretRoute(`${origin}/x`, type, [{ status: 200 }]);
        await handler(context)(route);
        expect(order, type).toEqual([`fetch ${origin}/x`, 'fulfill', 'dispose']);
        expect(fetched[0], type).toMatchObject({ url: `${origin}/x`, method: 'GET', headers: { accept: '*/*', 'Accept-Language': 'de', Authorization: 'Bearer t' }, maxRedirects: 0 });
      }
    });

    it('images, fonts and streams are continued by Chromium, without them (nothing buffered in the worker)', async () => {
      for (const type of ['image', 'font', 'media', 'manifest', 'other', 'eventsource', 'websocket']) {
        const { route, raw, context } = secretRoute(`${origin}/x`, type, [{ status: 200 }]);
        await handler(context)(route);
        expect(raw.fetch, type).not.toHaveBeenCalled();
        expect(raw.continue, type).toHaveBeenCalledWith({ headers: { accept: '*/*', 'Accept-Language': 'de' } });
      }
    });

    it('a redirect within the origin is followed with them by the context\'s request API; the main frame reports where it ended', async () => {
      const landed: Array<[string, string]> = [];
      const { route, order, fetched, context } = secretRoute(`${origin}/reports`, 'document', [{ status: 301, location: '/reports/' }, { status: 302, location: `${origin}/reports/q3` }, { status: 200 }]);
      await handler(context, { remainingMs: () => 5_000, onRedirected: (a, b) => landed.push([a, b]) })(route);
      expect(order).toEqual([`fetch ${origin}/reports`, 'dispose', `fetch ${origin}/reports/`, 'dispose', `fetch ${origin}/reports/q3`, 'fulfill', 'dispose']);
      expect(fetched.map((f) => f.via)).toEqual(['route', 'context', 'context']);
      expect(fetched.every((f) => (f.headers as Record<string, string>).Authorization === 'Bearer t' && f.maxRedirects === 0 && f.timeout === 5_000)).toBe(true);
      expect(landed).toEqual([[`${origin}/reports`, `${origin}/reports/q3`]]);
    });

    it('without the context, a redirect goes back to the browser', async () => {
      const { route, order } = secretRoute(`${origin}/reports`, 'document', [{ status: 301, location: '/reports/' }]);
      await handler(undefined)(route);
      expect(order).toEqual([`fetch ${origin}/reports`, 'fulfill', 'dispose']);
    });

    it('an XHR redirected within the origin keeps them, and reports nothing', async () => {
      const landed: unknown[] = [];
      const { route, fetched, context } = secretRoute(`${origin}/api/items`, 'xhr', [{ status: 301, location: '/api/items/' }, { status: 200 }]);
      await handler(context, { onRedirected: (...a) => landed.push(a) })(route);
      expect(fetched.map((f) => f.url)).toEqual([`${origin}/api/items`, `${origin}/api/items/`]);
      expect(landed).toEqual([]);
    });

    it('a script or style redirected into another directory goes back to the browser (its relative URLs need its own address); within one directory it is followed', async () => {
      for (const type of ['script', 'stylesheet']) {
        const moved = secretRoute(`${origin}/js/app.js`, type, [{ status: 302, location: '/js/v2/app.js' }, { status: 200 }]);
        await handler(moved.context)(moved.route);
        expect(moved.order, type).toEqual([`fetch ${origin}/js/app.js`, 'fulfill', 'dispose']);
        const renamed = secretRoute(`${origin}/js/app.js`, type, [{ status: 302, location: '/js/app.123.js' }, { status: 200 }]);
        await handler(renamed.context)(renamed.route);
        expect(renamed.fetched.map((f) => f.url), type).toEqual([`${origin}/js/app.js`, `${origin}/js/app.123.js`]);
      }
      const frame = secretRoute(`${origin}/embed`, 'document', [{ status: 301, location: '/embed/' }, { status: 200 }], { frame: 'child' });
      await handler(frame.context)(frame.route);
      expect(frame.order).toEqual([`fetch ${origin}/embed`, 'fulfill', 'dispose']);
    });

    it('a redirect to another origin (or to a blocked address) goes back to the browser, which follows it without them', async () => {
      for (const location of ['http://idp.public.test/authorize', `http://${INTERNAL_IP}/admin`]) {
        const landed: unknown[] = [];
        const { route, order, context } = secretRoute(`${origin}/app`, 'document', [{ status: 302, location }]);
        await handler(context, { onRedirected: (...a) => landed.push(a) })(route);
        expect(order, location).toEqual([`fetch ${origin}/app`, 'fulfill', 'dispose']);
        expect(landed).toEqual([]);
      }
      // A same-origin hop first, then another origin: the page will not show the hop's content, so nothing is reported.
      const landed: unknown[] = [];
      const mixed = secretRoute(`${origin}/out`, 'document', [{ status: 302, location: '/track' }, { status: 302, location: 'http://partner.public.test/landing' }]);
      await handler(mixed.context, { onRedirected: (...a) => landed.push(a) })(mixed.route);
      expect(mixed.order).toEqual([`fetch ${origin}/out`, 'dispose', `fetch ${origin}/track`, 'fulfill', 'dispose']);
      expect(landed).toEqual([]);
    });

    it('a 303, or a 301/302 answering a POST, is followed with a GET that carries no body; a 307 keeps the POST; a POST navigation is never reported', async () => {
      for (const [status, method] of [[303, 'GET'], [302, 'GET'], [307, 'POST']] as const) {
        const landed: unknown[] = [];
        const { route, fetched, context } = secretRoute(`${origin}/form`, 'document', [{ status, location: '/done' }, { status: 200 }], { method: 'POST', postData: 'a=1' });
        await handler(context, { onRedirected: (...a) => landed.push(a) })(route);
        expect(fetched[0], String(status)).toMatchObject({ method: 'POST', postData: Buffer.from('a=1'), via: 'route' });
        expect(fetched[1], String(status)).toMatchObject({ method, via: 'context' });
        expect(fetched[1].data, String(status)).toEqual(method === 'POST' ? Buffer.from('a=1') : undefined);
        expect((fetched[1].headers as Record<string, string>)['content-type'], String(status)).toBe(method === 'POST' ? 'application/x-www-form-urlencoded' : undefined);
        expect(landed, String(status)).toEqual([]);
      }
    });

    it('a same-origin redirect loop stops after a bounded number of hops, served as is', async () => {
      const { route, raw, fetched, context } = secretRoute(`${origin}/loop`, 'document', [{ status: 302, location: '/loop2' }, { status: 302, location: '/loop' }]);
      await handler(context)(route);
      expect(fetched.length).toBe(11);
      expect(raw.fulfill).toHaveBeenCalledTimes(1);
    });

    it('at most six run at once per page; the context counts them until they settle', async () => {
      const ctx = secretRoute(`${origin}/a`, 'script', [{ status: 200 }]).context;
      const h = handler(ctx);
      let inFlight = 0;
      let peak = 0;
      const routes = Array.from({ length: 10 }, (_, i) => {
        const r = secretRoute(`${origin}/s${i}.js`, 'script', [{ status: 200, delayMs: 30 }]);
        const original = r.raw.fetch;
        r.raw.fetch = vi.fn(async (o: Record<string, unknown>) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          try {
            return await original(o);
          } finally {
            inFlight--;
          }
        });
        return r.route;
      });
      const all = Promise.all(routes.map((r) => h(r)));
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(hasPendingSecretFetches(ctx)).toBe(true);
      await all;
      expect(peak).toBe(6);
      expect(hasPendingSecretFetches(ctx)).toBe(false);
    });

    it('a spent budget fetches nothing: the request is aborted', async () => {
      const { route, raw, context } = secretRoute(`${origin}/x`, 'document', [{ status: 200 }]);
      await handler(context, { remainingMs: () => 0 })(route);
      expect(raw.fetch).not.toHaveBeenCalled();
      expect(raw.abort).toHaveBeenCalled();
    });
  });

  it('keeps the SSRF check when resource blocking is off', async () => {
    const { route, calls } = fakeRoute(`http://${INTERNAL_IP}/font.woff2`, 'font');
    await guard(route);
    expect(calls).toEqual(['abort']);
    const allowed = fakeRoute('http://public.test/font.woff2', 'font');
    await guard(allowed.route);
    expect(allowed.calls).toEqual(['continue']);
  });

  it('applies resource blocking without a DNS lookup when enabled', async () => {
    const lookup = vi.fn(fakeLookup);
    useFixturePolicy(lookup);
    for (const [url, type] of [
      ['http://public.test/font.woff2', 'font'],
      ['http://public.test/video.mp4', 'media'],
      ['http://www.google-analytics.com/collect', 'script'],
    ]) {
      const { route, calls } = fakeRoute(url, type);
      await guardAndBlock(route);
      expect(calls).toEqual(['abort']);
    }
    expect(lookup).not.toHaveBeenCalled();
    const { route, calls } = fakeRoute('http://public.test/app.js', 'script');
    await guardAndBlock(route);
    expect(calls).toEqual(['continue']);
  });

  it('swallows errors from an already-closed page', async () => {
    const { route } = fakeRoute(`http://${INTERNAL_IP}/`, 'document', { failOnHandle: true });
    await expect(guard(route)).resolves.toBeUndefined();
  });
});

describe('installation', () => {
  it('installOutboundGuard registers a catch-all page route', async () => {
    const page = { route: vi.fn(async () => ({})) };
    await installOutboundGuard(page as unknown as Page, { blockResources: true });
    expect(page.route).toHaveBeenCalledTimes(1);
    const [matcher] = page.route.mock.calls[0] as unknown as [(url: URL) => boolean];
    expect(matcher(new URL('file:///x'))).toBe(true);
  });

  it('ensureContextOutboundGuard installs once per context, even concurrently', async () => {
    const context = { route: vi.fn(async () => ({})) } as unknown as BrowserContext & {
      route: ReturnType<typeof vi.fn>;
    };
    await Promise.all([ensureContextOutboundGuard(context), ensureContextOutboundGuard(context)]);
    await ensureContextOutboundGuard(context);
    expect(context.route).toHaveBeenCalledTimes(1);
  });

  it('ensureContextOutboundGuard retries after a failed installation', async () => {
    let fail = true;
    const route = vi.fn(async () => {
      if (fail) throw new Error('context closed');
      return {};
    });
    const context = { route } as unknown as BrowserContext;
    await expect(ensureContextOutboundGuard(context)).rejects.toThrow('context closed');
    fail = false;
    await new Promise((r) => setImmediate(r));
    await ensureContextOutboundGuard(context);
    expect(route).toHaveBeenCalledTimes(2);
  });
});

describe('shouldBlockResource', () => {
  it.each([
    ['font', 'https://cdn.test/a.woff2', true],
    ['media', 'https://cdn.test/a.mp4', true],
    ['manifest', 'https://cdn.test/m.json', true],
    ['prefetch', 'https://cdn.test/next', true],
    ['script', 'https://www.googletagmanager.com/gtm.js', true],
    ['image', 'https://ads.example.com/banner.png', true],
    ['document', 'https://shop.test/', false],
    ['script', 'https://shop.test/app.js', false],
    ['xhr', 'https://shop.test/api', false],
    ['stylesheet', 'https://shop.test/s.css', false],
    ['image', 'https://shop.test/p.png', false],
  ])('%s %s → %s', (type, url, expected) => {
    expect(shouldBlockResource(type, url)).toBe(expected);
  });
});

// ─── monitor ─────────────────────────────────────────────────

function fakePage() {
  const context = new EventEmitter();
  const page = Object.assign(new EventEmitter(), { context: () => context });
  return { page: page as unknown as Page, context, emitter: page };
}

describe('monitorOutbound', () => {
  it('is clean when redirect hops and sockets stay public', async () => {
    const { page, context, emitter } = fakePage();
    const monitor = monitorOutbound(page);
    context.emit('request', chain('http://public.test/a', 'http://public.test/b'));
    emitter.emit('websocket', { url: () => 'wss://public.test/live' });
    await expect(monitor.assertClean()).resolves.toBeUndefined();
    monitor.dispose();
  });

  it('flags a redirect hop to a blocked destination', async () => {
    const { page, context } = fakePage();
    const monitor = monitorOutbound(page);
    context.emit('request', chain('http://public.test/img', `http://${INTERNAL_IP}/secret.png`));
    await expect(monitor.assertClean()).rejects.toBeInstanceOf(OutboundBlockedError);
    monitor.dispose();
  });

  it('flags a WebSocket to a blocked destination', async () => {
    const { page, emitter } = fakePage();
    const monitor = monitorOutbound(page);
    emitter.emit('websocket', { url: () => 'ws://internal.test:6379/' });
    await expect(monitor.assertClean()).rejects.toThrow(/private or reserved/);
    monitor.dispose();
  });

  it('leaves first-hop requests to the route guard', async () => {
    const lookup = vi.fn(fakeLookup);
    useFixturePolicy(lookup);
    const { page, context } = fakePage();
    const monitor = monitorOutbound(page);
    context.emit('request', fakeRequest(`http://internal.test/`));
    await expect(monitor.assertClean()).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it('waits for checks still in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    useFixturePolicy(async (host) => {
      await gate;
      return host === 'slow.test' ? ['10.1.1.1'] : fakeLookup(host);
    });
    const { page, context } = fakePage();
    const monitor = monitorOutbound(page);
    context.emit('request', chain('http://public.test/', 'http://slow.test/'));
    const verdict = monitor.assertClean().then(
      () => 'clean',
      () => 'blocked',
    );
    release();
    expect(await verdict).toBe('blocked');
    monitor.dispose();
  });

  it('dispose removes its listeners', () => {
    const { page, context, emitter } = fakePage();
    const monitor = monitorOutbound(page);
    expect(context.listenerCount('request')).toBe(1);
    expect(emitter.listenerCount('websocket')).toBe(1);
    monitor.dispose();
    expect(context.listenerCount('request')).toBe(0);
    expect(emitter.listenerCount('websocket')).toBe(0);
  });
});

// ─── navigation chain ───────────────────────────────────────

describe('assertNavigationAllowed', () => {
  it('passes a public chain and final URL', async () => {
    const response = asResponse(chain('http://public.test/', 'https://public.test/home'));
    await expect(assertNavigationAllowed(response, 'https://public.test/home')).resolves.toBeUndefined();
  });

  it('throws when any hop in the chain was blocked', async () => {
    const response = asResponse(
      chain('http://public.test/', 'http://169.254.169.254/latest/', 'http://public.test/back'),
    );
    await expect(assertNavigationAllowed(response, 'http://public.test/back')).rejects.toBeInstanceOf(
      OutboundBlockedError,
    );
  });

  it('throws when the final URL is blocked', async () => {
    await expect(assertNavigationAllowed(null, `http://${INTERNAL_IP}/admin`)).rejects.toBeInstanceOf(
      OutboundBlockedError,
    );
    await expect(assertNavigationAllowed(null, 'file:///etc/passwd')).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it('ignores Chromium error pages and in-browser URLs', async () => {
    await expect(assertNavigationAllowed(null, 'chrome-error://chromewebdata/')).resolves.toBeUndefined();
    await expect(assertNavigationAllowed(null, 'about:blank')).resolves.toBeUndefined();
  });

  it('stops walking pathological chains', async () => {
    const urls = Array.from({ length: 500 }, (_, i) => `http://public.test/${i}`);
    const response = asResponse(chain(...urls));
    await expect(assertNavigationAllowed(response, urls.at(-1)!)).resolves.toBeUndefined();
  });
});
