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
