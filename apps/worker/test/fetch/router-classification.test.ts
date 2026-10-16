// Phase 4: why a tier's response was rejected decides where the request
// goes next. Real HTTP tiers against local servers; the browser must not be
// touched unless the case needs it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { BrowserContext } from 'patchright';
import { setOutboundPolicyForTests } from '@scrapeforge/shared';
import { classifyRejection, parseStrategy, pathTemplate, retryAfterMs, SmartRouter, strategyKey, TiersExhaustedError } from '../../src/engine/router.js';
import { calculateQualityScore } from '../../src/extraction/quality-scorer.js';
import { smallPage } from '../../../../tests/latency/lib/fixtures.js';
import { PUBLIC_IP, html, routes, startServer, useFixturePolicy, type FixtureServer, type Handler } from '../net/fixtures.js';

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

const status = (code: number, body: string, headers: Record<string, string> = {}): Handler => (_req, res) => {
  res.writeHead(code, { 'content-type': 'text/html', ...headers });
  res.end(body);
};

/** Fails `times` times with `code`, then serves the page. */
function flaky(code: number, times: number, headers: Record<string, string> = {}): Handler {
  let n = 0;
  return (req, res, body) => (n++ < times ? status(code, '<h1>Error</h1>', headers)(req, res, body) : html(smallPage())(req, res, body));
}

const SHELL =
  '<!doctype html><html><head><title>App</title><script src="/main.js"></script></head><body><div id="root"></div></body></html>';
const CHALLENGE =
  '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="challenge-running">Checking your browser</div>' +
  '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></body></html>';

let site: FixtureServer;
const hits = (path: string) => site.requests.filter((r) => r.url.split('?')[0] === path).length;

beforeAll(async () => {
  site = await startServer(
    PUBLIC_IP,
    routes({
      '/boom': status(500, '<html><body><h1>500 Internal Server Error</h1><hr><center>nginx</center></body></html>'),
      '/flaky-500': flaky(500, 1),
      '/rate-limited': status(429, 'Too Many Requests', { 'retry-after': '1' }),
      '/flaky-429': flaky(429, 1, { 'retry-after': '0' }),
      '/come-back-later': status(429, 'Too Many Requests', { 'retry-after': '120' }),
      '/maintenance': status(503, '<h1>Down for maintenance</h1>', { 'retry-after': '0' }),
      '/challenge-503': status(503, CHALLENGE),
      '/shell': html(SHELL),
    }),
  );
});

afterAll(async () => {
  await site?.close();
});

beforeEach(() => {
  useFixturePolicy();
  site.requests.length = 0;
});

afterEach(() => setOutboundPolicyForTests(null));

function setup() {
  const acquire = vi.fn(async (): Promise<BrowserContext> => {
    throw Object.assign(new Error('no browser in this test'), { code: 'BROWSER_POOL_UNAVAILABLE' });
  });
  const redis = new MemoryRedis();
  const sleeps: number[] = [];
  const router = new SmartRouter(redis as unknown as Redis, acquire, vi.fn(), {
    random: () => 0.99,
    logger: { warn: vi.fn() },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { router, acquire, redis, sleeps };
}

async function failure(p: Promise<unknown>): Promise<TiersExhaustedError> {
  const e = await p.then(
    () => {
      throw new Error('expected the request to fail');
    },
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(TiersExhaustedError);
  return e as TiersExhaustedError;
}

describe('classifyRejection', () => {
  const signals = (html: string, code = 200) => calculateQualityScore(html, code, 1, 10).signals;

  it.each([
    ['plain 500', 500, '<h1>500 Internal Server Error</h1>', {}, 'server_error'],
    ['empty 502', 502, '', {}, 'server_error'],
    ['429', 429, 'Too Many Requests', {}, 'rate_limited'],
    ['408', 408, '', {}, 'rate_limited'],
    ['503 with Retry-After', 503, 'Maintenance', { 'retry-after': '30' }, 'rate_limited'],
    ['503 challenge', 503, CHALLENGE, {}, 'blocked'],
    ['403', 403, '<h1>Access denied</h1>', {}, 'blocked'],
  ] as const)('%s → %s', (_label, code, body, headers, expected) => {
    expect(classifyRejection(body, code, signals(body, code), headers)).toBe(expected);
  });

  it('an app shell needs JavaScript; a challenge is blocked', () => {
    expect(classifyRejection(SHELL, 200, signals(SHELL))).toBe('js_required');
    expect(classifyRejection(CHALLENGE, 200, [])).toBe('blocked');
  });

  it('a large error page that runs scripts may be a challenge in disguise: blocked', () => {
    const big = `<html><body><h1>Error</h1><script>${'x'.repeat(5_000)}</script></body></html>`;
    expect(classifyRejection(big, 500, [])).toBe('blocked');
  });
});

describe('retryAfterMs', () => {
  const now = Date.parse('2026-10-13T00:00:00Z');
  it('reads seconds and HTTP dates, bounded', () => {
    expect(retryAfterMs({ 'retry-after': '2' }, now, 3_000, 9)).toBe(2_000);
    expect(retryAfterMs({ 'retry-after': '120' }, now, 3_000, 9)).toBe(3_000);
    expect(retryAfterMs({ 'retry-after': new Date(now + 1_500).toUTCString() }, now, 3_000, 9)).toBeGreaterThan(500);
    expect(retryAfterMs({ 'retry-after': 'soon' }, now, 3_000, 9)).toBe(9);
    expect(retryAfterMs(undefined, now, 3_000, 9)).toBe(9);
    expect(retryAfterMs({ 'retry-after': new Date(now - 5_000).toUTCString() }, now, 3_000, 9)).toBe(0);
  });
});

describe('routing by why a tier failed', () => {
  it('a server error: one retry of the same tier, then a retryable failure, never a browser', async () => {
    const { router, acquire, sleeps } = setup();
    const e = await failure(router.route(`${site.origin}/boom`, {}));
    expect(hits('/boom')).toBe(2);
    expect(acquire).not.toHaveBeenCalled();
    expect(sleeps).toEqual([500]);
    expect(e.transient).toBe(true);
    expect(e.message).toMatch(/T1:server_error again/);
  });

  it('a server error that clears on the retry is answered by the same tier', async () => {
    const { router } = setup();
    const r = await router.route(`${site.origin}/flaky-500`, {});
    expect(r).toMatchObject({ tierUsed: 1, statusCode: 200 });
    expect(hits('/flaky-500')).toBe(2);
  });

  it('a rate limit waits Retry-After (bounded) and retries once; never a browser', async () => {
    const { router, acquire, sleeps } = setup();
    const e = await failure(router.route(`${site.origin}/rate-limited`, {}));
    expect(sleeps).toEqual([1_000]);
    expect(hits('/rate-limited')).toBe(2);
    expect(acquire).not.toHaveBeenCalled();
    expect(e.transient).toBe(true);

    const ok = await setup().router.route(`${site.origin}/flaky-429`, {});
    expect(ok).toMatchObject({ tierUsed: 1, statusCode: 200 });
  });

  it('a Retry-After longer than the request can wait fails at once (retryable), without waiting', async () => {
    const { router, sleeps } = setup();
    const e = await failure(router.route(`${site.origin}/come-back-later`, {}));
    expect(sleeps).toEqual([]);
    expect(hits('/come-back-later')).toBe(1);
    expect(e.message).toMatch(/Retry-After 120 s/);
    expect(e.transient).toBe(true);
  });

  it('503 with Retry-After is a rate limit; a 503 challenge escalates', async () => {
    const { router, acquire } = setup();
    await failure(router.route(`${site.origin}/maintenance`, {}));
    expect(acquire).not.toHaveBeenCalled();
    const second = setup();
    await expect(second.router.route(`${site.origin}/challenge-503`, {})).rejects.toBeTruthy();
    expect(second.acquire).toHaveBeenCalled();
  });

  it('an app shell skips the second HTTP client and goes to the browser', async () => {
    const { router, acquire } = setup();
    await expect(router.route(`${site.origin}/shell`, {})).rejects.toBeTruthy();
    expect(hits('/shell')).toBe(1);
    expect(acquire).toHaveBeenCalled();
  });

  it('past the job deadline no further tier is started', async () => {
    const { router, acquire } = setup();
    const deadline = new AbortController();
    deadline.abort(new Error('job deadline'));
    await expect(router.route(`${site.origin}/shell`, {}, undefined, deadline.signal)).rejects.toThrow('job deadline');
    expect(hits('/shell')).toBe(0);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('an outage is not learned against the tier: the domain still starts at T1', async () => {
    const { router, redis } = setup();
    for (let i = 0; i < 4; i++) await failure(router.route(`${site.origin}/boom`, {}));
    await router.drainStrategyWrites();
    const strategy = parseStrategy(redis.store.get(`domain:${new URL(site.origin).hostname}`) ?? null);
    expect(strategy?.tiers?.['1']?.ok ?? 0).toBe(0);
    expect(Object.keys(strategy?.tiers ?? {})).not.toContain('1');
    // The next request starts at T1 again.
    site.requests.length = 0;
    await failure(router.route(`${site.origin}/boom`, {}));
    expect(hits('/boom')).toBe(2);
  });
});

describe('per-section learning', () => {
  it.each([
    ['https://shop.example/', '/'],
    ['https://shop.example/dp/B0CKX7T2QF', '/dp'],
    ['https://shop.example/ip/1', '/ip'],
    ['https://shop.example/search?q=tent', '/search'],
    ['https://shop.example/en-us/search?q=tent', '/en-us/search'],
    ['https://shop.example/de/produkte/zelt', '/de/produkte'],
    ['https://shop.example/en', '/en'],
    ['https://blog.example/2026/10/post', '/*'],
    ['https://shop.example/3f2a9c1d7e5b/details', '/*'],
    ['https://shop.example/Product%20List/x', '/product_list'],
  ])('%s is section %s', (url, section) => {
    expect(pathTemplate(url)).toBe(section);
  });

  it("learns a section's own start tier, and falls back to the site's", async () => {
    const redis = new MemoryRedis();
    const router = new SmartRouter(redis as unknown as Redis, async () => { throw new Error('no browser'); }, vi.fn(), { random: () => 0.99, logger: { warn: vi.fn() } });
    const host = new URL(site.origin).hostname;
    // Section /a has learned T4; the site as a whole has learned T1.
    const learned = (tier: number) => JSON.stringify({ v: 2, requests: 5, tiers: { [tier]: { ok: 5, total: 5, lastAt: Date.now(), lastOkAt: Date.now(), lastOk: true } } });
    redis.store.set(strategyKey(host), learned(1));
    redis.store.set(strategyKey(host, '/a'), learned(4));
    site.requests.length = 0;
    // /a starts at the browser (which this test does not have): T1 is not fetched.
    await expect(router.route(`${site.origin}/a/page`, {})).rejects.toBeTruthy();
    expect(site.requests).toHaveLength(0);
    // /b has no evidence of its own: the site's T1.
    await router.route(`${site.origin}/b/page`, {}).catch(() => undefined);
    expect(site.requests.length).toBeGreaterThan(0);
  });
});
