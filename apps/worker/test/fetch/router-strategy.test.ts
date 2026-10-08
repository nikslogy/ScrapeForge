// SmartRouter: per-tier domain strategy, no re-fetching, fail-fast errors,
// one proxy resolution per request, client-safe error text. Tier fetchers
// and the proxy manager are stubbed; the acceptance gate (isValidContent +
// quality scorer) is real.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { BrowserContext } from 'patchright';
import { DnsLookupError, OutboundBlockedError, TooManyRedirectsError } from '@scrapeforge/shared';
import { compactPage, smallPage } from '../../../../tests/latency/lib/fixtures.js';

const m = vi.hoisted(() => ({
  tier1Fetch: vi.fn(),
  tier2Fetch: vi.fn(),
  tier3Fetch: vi.fn(),
  isLightpandaConfigured: vi.fn(() => false),
  tier4Fetch: vi.fn(),
  tier4StealthFetch: vi.fn(),
  proxySelect: vi.fn(),
  proxyEscalate: vi.fn(),
  proxyRecordResult: vi.fn(),
}));

vi.mock('../../src/engine/tier1-http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/engine/tier1-http.js')>()),
  tier1Fetch: m.tier1Fetch,
}));
vi.mock('../../src/engine/tier2-tls.js', () => ({ tier2Fetch: m.tier2Fetch }));
vi.mock('../../src/engine/tier3-light.js', () => ({
  tier3Fetch: m.tier3Fetch,
  isLightpandaConfigured: m.isLightpandaConfigured,
}));
vi.mock('../../src/engine/tier4-browser.js', () => ({ tier4Fetch: m.tier4Fetch }));
vi.mock('../../src/engine/tier4-stealth.js', () => ({ tier4StealthFetch: m.tier4StealthFetch }));
vi.mock('../../src/proxy/manager.js', () => ({
  ProxyManager: class {
    select = m.proxySelect;
    escalate = m.proxyEscalate;
    recordResult = m.proxyRecordResult;
  },
}));

const {
  SmartRouter,
  applyOutcomes,
  parseStrategy,
  planStartTier,
  redactReason,
  STRATEGY_TTL_SECONDS,
} = await import('../../src/engine/router.js');
type StoredStrategy = import('../../src/engine/router.js').StoredStrategy;

// ── helpers ─────────────────────────────────────────────

const GOOD = smallPage(); // classic example.com: accepted at any tier
const SHELL =
  '<!doctype html><html><head><title>App</title><script src="/main.js"></script></head><body><div id="root"></div></body></html>';
const URL_ = 'https://shop.example/item/1';
const DOMAIN = 'shop.example';
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const HOUR = 3_600_000;

const page = (html: string, statusCode = 200) => ({ html, statusCode, latencyMs: 10, headers: {}, finalUrl: URL_ });
const ok = () => Promise.resolve(page(GOOD));
const shell = () => Promise.resolve(page(SHELL));

class FakeRedis {
  store = new Map<string, string>();
  get = vi.fn(async (k: string) => this.store.get(k) ?? null);
  set = vi.fn(async (k: string, v: string, ..._rest: unknown[]) => {
    this.store.set(k, v);
    return 'OK';
  });
  strategy(domain = DOMAIN): StoredStrategy | null {
    return parseStrategy(this.store.get(`domain:${domain}`) ?? null);
  }
}

function setup(opts: { random?: () => number; now?: () => number } = {}) {
  const redis = new FakeRedis();
  const clock = { t: T0 };
  const acquire = vi.fn(async () => ({}) as BrowserContext);
  const release = vi.fn();
  const logger = { warn: vi.fn() };
  const router = new SmartRouter(redis as unknown as Redis, acquire, release, {
    now: opts.now ?? (() => clock.t),
    random: opts.random ?? (() => 0.99),
    logger,
  });
  /** One request, with its bookkeeping settled; returns the tiers fetched. */
  const request = async (url = URL_, options = {}) => {
    const before = calls();
    const r = await router.route(url, options);
    await router.drainStrategyWrites();
    const after = calls();
    return { r, fetched: after.map((n, i) => n - before[i]).flatMap((n, i) => Array(n).fill([1, 2, 3, 4, 5][i])) };
  };
  return { router, redis, acquire, release, logger, clock, request };
}

function calls(): number[] {
  return [m.tier1Fetch, m.tier2Fetch, m.tier3Fetch, m.tier4Fetch, m.tier4StealthFetch].map((f) => f.mock.calls.length);
}

beforeEach(() => {
  vi.resetAllMocks();
  m.isLightpandaConfigured.mockReturnValue(false);
  m.proxySelect.mockResolvedValue(null);
  m.proxyEscalate.mockResolvedValue(null);
  m.proxyRecordResult.mockResolvedValue(undefined);
});

// ── pure strategy functions ─────────────────────────────

describe('parseStrategy', () => {
  it.each([
    ['null', null],
    ['not JSON', '{oops'],
    ['a number', '42'],
    ['JSON null', 'null'],
    ['old pooled format', JSON.stringify({ tier: 4, proxyTier: 'datacenter', successRate: 0.25, avgLatencyMs: 900, sampleSize: 40, lastUpdated: 'x' })],
    ['wrong version', JSON.stringify({ v: 3, tiers: {} })],
    ['tiers not an object', JSON.stringify({ v: 2, tiers: 'x' })],
  ])('ignores %s', (_name, raw) => {
    expect(parseStrategy(raw)).toBeNull();
  });

  it('keeps valid tiers and drops malformed ones', () => {
    const raw = JSON.stringify({
      v: 2,
      requests: 7,
      tiers: {
        '1': { ok: 1, total: 3, lastAt: T0, lastOkAt: T0 - 5, lastOk: false, latencyMs: 12 },
        '2': { ok: 4, total: 3, lastAt: T0 }, // ok > total
        '3': { ok: -1, total: 3, lastAt: T0 },
        '4': { ok: 1, total: 1e9, lastAt: T0 }, // impossible under decay
        '5': { ok: 'x', total: 3, lastAt: T0 },
        '6': { ok: 1, total: 1, lastAt: T0 },
        '7': { ok: 1, total: 1, lastAt: T0 }, // beyond T5
        __proto__: { ok: 1, total: 1, lastAt: T0 },
      },
    });
    const s = parseStrategy(raw)!;
    expect(s.tiers).toEqual({ '1': { ok: 1, total: 3, lastAt: T0, lastOkAt: T0 - 5, lastOk: false, latencyMs: 12 } });
    // Optional fields of the wrong type are dropped, the tier is kept.
    const loose = parseStrategy(JSON.stringify({ v: 2, tiers: { '2': { ok: 1, total: 1, lastAt: T0, lastOk: 'yes', lastOkAt: -1 } } }))!;
    expect(loose.tiers).toEqual({ '2': { ok: 1, total: 1, lastAt: T0 } });
    expect(s.requests).toBe(7);
    expect(Object.getPrototypeOf(s.tiers)).toBe(Object.prototype);
  });
});

describe('applyOutcomes', () => {
  it('decays per outcome and per idle time', () => {
    let s = applyOutcomes(null, [{ tier: 1, ok: true, latencyMs: 100 }], T0);
    expect(s.tiers['1']).toEqual({ ok: 1, total: 1, lastAt: T0, lastOkAt: T0, lastOk: true, latencyMs: 100 });
    s = applyOutcomes(s, [{ tier: 1, ok: false }], T0);
    expect(s.tiers['1']).toMatchObject({ ok: 0.9, total: 1.9, lastOkAt: T0, lastOk: false });
    // Six idle hours halve the counts before the new outcome is added.
    s = applyOutcomes(s, [{ tier: 1, ok: true, latencyMs: 200 }], T0 + 6 * HOUR);
    expect(s.tiers['1']).toEqual({
      ok: Math.round((0.9 * 0.5 * 0.9 + 1) * 1000) / 1000,
      total: Math.round((1.9 * 0.5 * 0.9 + 1) * 1000) / 1000,
      lastAt: T0 + 6 * HOUR,
      lastOkAt: T0 + 6 * HOUR,
      lastOk: true,
      latencyMs: 130, // EWMA 0.3
    });
    expect(s.requests).toBe(3);
  });

  it('bounds the decayed total (roughly the last 10 outcomes)', () => {
    let s: StoredStrategy | null = null;
    for (let i = 0; i < 200; i++) s = applyOutcomes(s, [{ tier: 2, ok: true }], T0);
    expect(s!.tiers['2']!.total).toBeLessThanOrEqual(10);
    expect(s!.tiers['2']!.total).toBeGreaterThan(9.9);
    expect(parseStrategy(JSON.stringify(s))).toEqual(s);
  });

  it('ignores impossible tiers and writes the legacy summary', () => {
    let s: StoredStrategy | null = null;
    for (let i = 0; i < 3; i++) {
      s = applyOutcomes(
        s,
        [
          { tier: 0, ok: true },
          { tier: 2.5, ok: true },
          { tier: 6, ok: true },
          { tier: 1, ok: false },
          { tier: 5, ok: true, latencyMs: 700 },
        ],
        T0,
      );
    }
    expect(Object.keys(s!.tiers)).toEqual(['1', '5']);
    expect(s).toMatchObject({ tier: 5, successRate: 1, sampleSize: 3, avgLatencyMs: 700, proxyTier: 'datacenter' });
    expect(s!.lastUpdated).toBe(new Date(T0).toISOString());
  });
});

describe('planStartTier', () => {
  const tiers = [1, 2, 4, 5];
  const plan = (s: StoredStrategy | null, over: Partial<Parameters<typeof planStartTier>[1]> = {}) =>
    planStartTier(s, { tiers, jsHeavy: false, now: T0, random: () => 0.99, reprobeRate: 0.05, ...over });
  const record = (outcomes: Array<[number, boolean]>, times = 1, at = T0) => {
    let s: StoredStrategy | null = null;
    for (let i = 0; i < times; i++) s = applyOutcomes(s, outcomes.map(([tier, ok]) => ({ tier, ok })), at);
    return s;
  };

  it('starts cold at T1, or T4 for JS-heavy domains', () => {
    expect(plan(null)).toEqual({ tier: 1, reason: 'cold' });
    expect(plan(null, { jsHeavy: true })).toEqual({ tier: 4, reason: 'js-heavy' });
  });

  it('needs three recent samples before trusting a tier', () => {
    const chain: Array<[number, boolean]> = [[1, false], [2, false], [4, false], [5, true]];
    expect(plan(record(chain, 2)).tier).toBe(1);
    expect(plan(record(chain, 3))).toEqual({ tier: 5, reason: 'learned' });
  });

  it('picks the cheapest tier with a success rate of at least 0.6', () => {
    // T2: 2 of 3 recent successes is enough; T1: 1 of 3 is not.
    const s = record([[1, false], [2, true], [4, true]], 1);
    const s2 = applyOutcomes(applyOutcomes(s, [{ tier: 1, ok: true }, { tier: 2, ok: true }], T0), [{ tier: 1, ok: false }, { tier: 2, ok: false }], T0);
    expect(plan(s2)).toEqual({ tier: 2, reason: 'learned' });
  });

  it('skips tiers that keep failing when none is reliable yet', () => {
    const s = record([[1, false], [2, false]], 3);
    expect(plan(s)).toEqual({ tier: 4, reason: 'skip-failing' });
  });

  it('starts where failure is least likely when every tier fails', () => {
    let s = record([[1, false], [2, false], [4, false], [5, false]], 3);
    s = applyOutcomes(s, [{ tier: 4, ok: true }], T0);
    expect(plan(s)).toEqual({ tier: 4, reason: 'best-effort' });
  });

  it('forgets stale statistics', () => {
    const s = record([[1, false], [2, false], [4, false], [5, true]], 4);
    expect(plan(s).tier).toBe(5);
    expect(plan(s, { now: T0 + 13 * HOUR }).tier).toBe(1);
  });

  it('re-probes one available tier cheaper when random() < rate, never on a cold start', () => {
    const s = record([[1, false], [2, false], [4, false], [5, true]], 3);
    expect(plan(s, { random: () => 0.01 })).toEqual({ tier: 4, reason: 'reprobe' });
    expect(plan(s, { random: () => 0.05 }).tier).toBe(5);
    expect(plan(s, { random: () => 0.01, tiers: [1, 2, 3, 4, 5] }).tier).toBe(4);
    const s4 = record([[1, false], [2, false], [4, true]], 3);
    expect(plan(s4, { random: () => 0.01, tiers: [1, 2, 3, 4, 5] }).tier).toBe(3);
    expect(plan(s4, { random: () => 0.01 }).tier).toBe(2);
    expect(plan(null, { random: () => 0 })).toEqual({ tier: 1, reason: 'cold' });
    expect(plan(record([[1, true]], 3), { random: () => 0 })).toEqual({ tier: 1, reason: 'learned' });
  });
});

// ── SmartRouter with the strategy ───────────────────────

describe('SmartRouter domain strategy', () => {
  it('a domain that always ends at T5 starts at T5 from the 4th request', async () => {
    const { request, redis } = setup();
    m.tier1Fetch.mockImplementation(shell);
    m.tier2Fetch.mockImplementation(shell);
    m.tier4Fetch.mockImplementation(shell);
    m.tier4StealthFetch.mockImplementation(ok);

    for (let i = 0; i < 3; i++) expect((await request()).fetched).toEqual([1, 2, 4, 5]);
    const fourth = await request();
    expect(fourth.fetched).toEqual([5]);
    expect(fourth.r.tierUsed).toBe(5);
    expect(redis.strategy()).toMatchObject({ tier: 5, successRate: 1, sampleSize: 4 });
    expect(redis.set).toHaveBeenLastCalledWith(`domain:${DOMAIN}`, expect.any(String), 'EX', STRATEGY_TTL_SECONDS);
  });

  it('a page accepted at T1 keeps one fetch per request', async () => {
    const { request } = setup();
    m.tier1Fetch.mockImplementation(ok);
    for (let i = 0; i < 5; i++) expect((await request()).fetched).toEqual([1]);
  });

  it('never fetches a tier twice after a miss at the learned tier', async () => {
    const { request } = setup();
    m.tier1Fetch.mockImplementation(shell);
    m.tier2Fetch.mockImplementation(ok);
    for (let i = 0; i < 3; i++) await request();
    // Learned T2; now T2 fails once.
    m.tier2Fetch.mockImplementationOnce(shell);
    m.tier4Fetch.mockImplementation(ok);
    const r = await request();
    expect(r.fetched).toEqual([2, 4]);
    expect(r.r.tierUsed).toBe(4);
  });

  it('moves off a tier that starts failing within a few requests', async () => {
    const { request } = setup();
    m.tier1Fetch.mockImplementation(ok);
    for (let i = 0; i < 10; i++) await request();
    m.tier1Fetch.mockImplementation(shell);
    m.tier2Fetch.mockImplementation(ok);
    const starts: number[] = [];
    for (let i = 0; i < 8; i++) starts.push((await request()).fetched[0]);
    // A long good history buys a few failures, not many.
    const switchAt = starts.indexOf(2);
    expect(switchAt).toBeGreaterThanOrEqual(3);
    expect(switchAt).toBeLessThanOrEqual(5);
    expect(starts.slice(0, switchAt).every((t) => t === 1)).toBe(true);
    expect(starts.slice(switchAt).every((t) => t === 2)).toBe(true);
  });

  it('re-probing lets a domain return to a cheaper tier', async () => {
    let probe = false;
    const { request } = setup({ random: () => (probe ? 0 : 0.99) });
    m.tier1Fetch.mockImplementation(shell);
    m.tier2Fetch.mockImplementation(shell);
    m.tier4Fetch.mockImplementation(shell);
    m.tier4StealthFetch.mockImplementation(ok);
    for (let i = 0; i < 3; i++) await request();
    expect((await request()).fetched).toEqual([5]);

    // The site relaxes: T4 works again. Probes find out and the start tier moves down.
    m.tier4Fetch.mockImplementation(ok);
    probe = true;
    const probes: number[][] = [];
    for (let i = 0; i < 6; i++) probes.push((await request()).fetched);
    expect(probes[0]).toEqual([4]);
    probe = false;
    expect((await request()).fetched).toEqual([4]);
  });

  it('one successful re-probe is followed up until the cheaper tier is trusted', async () => {
    let draws = 0;
    // Only the first draw after learning is a "hit".
    const { request } = setup({ random: () => (draws++ === 0 ? 0 : 0.99) });
    m.tier1Fetch.mockImplementation(shell);
    m.tier2Fetch.mockImplementation(shell);
    m.tier4Fetch.mockImplementation(shell);
    m.tier4StealthFetch.mockImplementation(ok);
    const neverDraw = () => {
      draws = 1;
    };
    for (let i = 0; i < 3; i++) await request();
    draws = 0; // the next request draws the hit

    m.tier4Fetch.mockImplementation(ok); // the site relaxes
    const starts: number[] = [];
    for (let i = 0; i < 6; i++) starts.push((await request()).fetched[0]);
    // Probe hit, then follow-ups (no more lucky draws), then T4 is learned.
    expect(starts).toEqual([4, 4, 4, 4, 4, 4]);
    neverDraw();
    expect((await request()).fetched).toEqual([4]);
  });

  it('a failed follow-up ends the re-probing', async () => {
    let hit = true;
    const { request, redis } = setup({ random: () => (hit ? ((hit = false), 0) : 0.99) });
    m.tier1Fetch.mockImplementation(shell);
    m.tier2Fetch.mockImplementation(ok);
    for (let i = 0; i < 3; i++) await request();
    hit = false;
    expect((await request()).fetched).toEqual([2]);
    hit = true;
    m.tier1Fetch.mockImplementationOnce(ok); // the probe succeeds once ...
    expect((await request()).fetched).toEqual([1]);
    expect(redis.strategy()?.tiers['1']).toMatchObject({ lastOkAt: expect.any(Number) });
    // ... the follow-up fails, so the request falls through to T2 ...
    expect((await request()).fetched).toEqual([1, 2]);
    // ... and later requests start at T2 again.
    for (let i = 0; i < 3; i++) expect((await request()).fetched).toEqual([2]);
  });

  it('re-probes about 1 request in 20 with Math.random-like input', async () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const { request } = setup({ random });
    m.tier1Fetch.mockImplementation(shell);
    m.tier2Fetch.mockImplementation(ok);
    for (let i = 0; i < 3; i++) await request();
    let probes = 0;
    for (let i = 0; i < 400; i++) if ((await request()).fetched[0] === 1) probes++;
    expect(probes).toBeGreaterThan(8);
    expect(probes).toBeLessThan(40);
  });

  it('learns nothing from forced browser requests, but does from hard domains', async () => {
    const { request, redis } = setup();
    m.tier4Fetch.mockImplementation(ok);
    for (let i = 0; i < 4; i++) await request(URL_, { screenshot: true });
    expect(redis.set).not.toHaveBeenCalled();
    await request('https://www.walmart.com/ip/1');
    expect(redis.strategy('www.walmart.com')?.tiers['4']).toMatchObject({ ok: 1, total: 1 });
  });

  it('replaces an old-format value on the next write', async () => {
    const { request, redis } = setup();
    redis.store.set(`domain:${DOMAIN}`, JSON.stringify({ tier: 4, successRate: 0.25, sampleSize: 99 }));
    m.tier1Fetch.mockImplementation(ok);
    expect((await request()).fetched).toEqual([1]);
    expect(JSON.parse(redis.store.get(`domain:${DOMAIN}`)!)).toMatchObject({ v: 2, requests: 1, tier: 1 });
  });
});

describe('SmartRouter bookkeeping is off the critical path', () => {
  it('returns before the strategy write completes', async () => {
    const { router, redis } = setup();
    let finishSet!: () => void;
    redis.set.mockImplementation(() => new Promise((resolve) => (finishSet = () => resolve('OK'))));
    m.tier1Fetch.mockImplementation(ok);

    const r = await router.route(URL_, {});
    expect(r.tierUsed).toBe(1);
    await vi.waitFor(() => expect(redis.set).toHaveBeenCalledTimes(1));
    let drained = false;
    const drain = router.drainStrategyWrites().then(() => (drained = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drained).toBe(false);
    finishSet();
    await drain;
  });

  it('a failing strategy read only costs the learned start', async () => {
    const { router, redis, logger } = setup();
    redis.get.mockRejectedValue(new Error('READONLY You cannot write against a read only replica.'));
    m.tier1Fetch.mockImplementation(ok);

    await expect(router.route(URL_, {})).resolves.toMatchObject({ tierUsed: 1 });
    await router.drainStrategyWrites();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('read failed'));
  });

  it('a failing proxy stats write is logged, not thrown', async () => {
    const proxy = { url: 'http://u:pw123456@proxy.example:8080', tier: 'datacenter', cost: 0.001, provider: { name: 'p' } };
    m.proxySelect.mockResolvedValue(proxy);
    m.proxyRecordResult.mockRejectedValue(new Error('scorer down'));
    const { router, logger } = setup();
    m.tier1Fetch.mockImplementation(shell);
    m.tier2Fetch.mockImplementation(ok);

    await expect(router.route(URL_, {})).resolves.toMatchObject({ tierUsed: 2, proxyTier: 'datacenter' });
    await router.drainStrategyWrites();
    expect(m.proxyRecordResult).toHaveBeenCalledWith(proxy, DOMAIN, true, 10);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('scorer down'));
  });

  it('serializes this process\'s writes per domain (no lost updates)', async () => {
    const { router, redis } = setup();
    const slow = <T>(v: T) => new Promise<T>((resolve) => setTimeout(() => resolve(v), 5));
    redis.get.mockImplementation((k: string) => slow(redis.store.get(k) ?? null));
    redis.set.mockImplementation(async (k: string, v: string) => {
      await slow(null);
      redis.store.set(k, v);
      return 'OK';
    });
    m.tier1Fetch.mockImplementation(ok);

    await Promise.all(Array.from({ length: 8 }, () => router.route(URL_, {})));
    await router.drainStrategyWrites();
    expect(redis.strategy()?.requests).toBe(8);
  });

  it('drops bookkeeping beyond 1,000 pending writes instead of growing without bound', async () => {
    const { router, redis, logger } = setup();
    redis.set.mockImplementation(() => new Promise(() => {})); // writes hang
    m.tier1Fetch.mockImplementation(ok);

    for (let i = 0; i < 1_050; i++) await router.route(`https://d${i}.example/`, {});
    await vi.waitFor(() => expect(redis.set).toHaveBeenCalledTimes(1_000));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('dropping'));
  });

  it('does not wait long for a hanging strategy read', async () => {
    const redis = new FakeRedis();
    redis.get.mockImplementation(() => new Promise(() => {}));
    const logger = { warn: vi.fn() };
    const router = new SmartRouter(redis as unknown as Redis, vi.fn(), vi.fn(), {
      strategyReadTimeoutMs: 30,
      logger,
    });
    m.tier1Fetch.mockImplementation(ok);

    const t0 = performance.now();
    await expect(router.route(URL_, {})).resolves.toMatchObject({ tierUsed: 1 });
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('timed out after 30 ms'));
  });
});

// ── fail-fast errors ────────────────────────────────────

describe('SmartRouter does not escalate refused or unresolvable URLs', () => {
  const blocked = () => new OutboundBlockedError('address', 'shop.example', 'shop.example resolves to a private or reserved address', '10.0.0.1');

  it.each([
    ['OutboundBlockedError', blocked],
    ['DnsLookupError', () => new DnsLookupError('shop.example', 'ENOTFOUND')],
    ['an OUTBOUND_BLOCKED error from another module copy', () => Object.assign(new Error('Blocked by SSRF guard: x'), { code: 'OUTBOUND_BLOCKED' })],
    ['a DNS_LOOKUP_FAILED error from another module copy', () => Object.assign(new Error('DNS lookup failed for x'), { code: 'DNS_LOOKUP_FAILED' })],
  ])('rethrows %s from T1 at once', async (_name, make) => {
    const { router, acquire, redis } = setup();
    const err = make();
    m.tier1Fetch.mockRejectedValue(err);

    await expect(router.route(URL_, {})).rejects.toBe(err);
    await router.drainStrategyWrites();
    expect(m.tier2Fetch).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(m.tier4Fetch).not.toHaveBeenCalled();
    expect(m.tier4StealthFetch).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled(); // not the tier's fault
  });

  it('a browser tier that hits an internal redirect does not hand the URL to stealth or fall back', async () => {
    const { router, release } = setup();
    m.tier1Fetch.mockImplementation(shell);
    m.tier2Fetch.mockImplementation(shell);
    const err = blocked();
    m.tier4Fetch.mockRejectedValue(err);

    await expect(router.route(URL_, {})).rejects.toBe(err);
    expect(m.tier4StealthFetch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('the browser-only path stops after T4 too', async () => {
    const { router } = setup();
    const err = blocked();
    m.tier4Fetch.mockRejectedValue(err);

    await expect(router.route(URL_, { screenshot: true })).rejects.toBe(err);
    expect(m.tier4StealthFetch).not.toHaveBeenCalled();
  });

  it('still escalates on other errors (redirect loops, timeouts)', async () => {
    const { router } = setup();
    m.tier1Fetch.mockRejectedValue(new TooManyRedirectsError(10));
    m.tier2Fetch.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    m.tier4Fetch.mockImplementation(ok);

    await expect(router.route(URL_, {})).resolves.toMatchObject({ tierUsed: 4 });
  });
});

// ── proxy resolution ────────────────────────────────────

describe('SmartRouter resolves the proxy once per request', () => {
  const proxy = { url: 'http://proxy.local:1', tier: 'datacenter', cost: 0.001, provider: { name: 'p' } };

  it.each([
    ['full escalation', URL_, {}],
    ['browser-only request', URL_, { screenshot: true }],
    ['hard domain', 'https://www.walmart.com/ip/1', {}],
  ] as const)('%s', async (_name, url, options) => {
    m.proxySelect.mockResolvedValue(proxy);
    const { router } = setup();
    m.tier1Fetch.mockImplementation(shell);
    m.tier2Fetch.mockImplementation(shell);
    m.tier4Fetch.mockImplementation(shell);
    m.tier4StealthFetch.mockImplementation(ok);

    await router.route(url, options);
    expect(m.proxySelect).toHaveBeenCalledTimes(1);
  });

  it('after a miss at the learned tier', async () => {
    m.proxySelect.mockResolvedValue(proxy);
    const { request } = setup();
    m.tier1Fetch.mockImplementation(shell);
    m.tier2Fetch.mockImplementation(ok);
    for (let i = 0; i < 3; i++) await request();
    m.proxySelect.mockClear();
    m.tier2Fetch.mockImplementationOnce(shell);
    m.tier4Fetch.mockImplementation(ok);

    await request();
    expect(m.proxySelect).toHaveBeenCalledTimes(1);
    expect(m.tier2Fetch).toHaveBeenLastCalledWith(URL_, expect.objectContaining({ proxy: proxy.url }));
  });
});

// ── client-visible error text ───────────────────────────

describe('"All tiers exhausted" error text', () => {
  const proxyUrl = 'http://acct-77:s3cr3t%40pass@gw.proxy.example:8000';

  it('carries no proxy URL, host or credentials', async () => {
    m.proxySelect.mockResolvedValue({ url: proxyUrl, tier: 'residential', cost: 0.01, provider: { name: 'p' } });
    const { router } = setup();
    m.tier1Fetch.mockRejectedValue(new Error(`tunnel via ${proxyUrl} failed`));
    m.tier2Fetch.mockRejectedValue(new Error('407 from gw.proxy.example:8000 for user acct-77 (password s3cr3t@pass)'));
    m.tier4Fetch.mockRejectedValue(new Error('net::ERR_PROXY_CONNECTION_FAILED at http://other:hunter22@10.1.2.3:3128/'));
    m.tier4StealthFetch.mockRejectedValue(new Error('x'));

    const err = await router.route(URL_, {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/^All tiers exhausted for shop\.example — T1:threw tunnel via \[proxy\] failed \| /);
    for (const secret of ['s3cr3t', 'acct-77', 'gw.proxy.example', 'hunter22', 'other:']) expect(msg).not.toContain(secret);
    expect(msg).toContain('http://***@10.1.2.3:3128/');
  });

  it('stays short and single-line whatever the tiers throw', async () => {
    const { router } = setup();
    const huge = `line1\nline2\r\n\t${'z'.repeat(20_000)}`;
    m.tier1Fetch.mockRejectedValue(new Error(huge));
    m.tier2Fetch.mockRejectedValue(new Error(huge));
    m.tier4Fetch.mockRejectedValue(new Error(huge));
    m.tier4StealthFetch.mockRejectedValue(new Error(huge));

    const msg = ((await router.route(URL_, {}).catch((e: Error) => e)) as Error).message;
    expect(msg.length).toBeLessThanOrEqual(700);
    expect(msg).not.toMatch(/[\r\n\t]/);
    // The over-long token is cut off rather than shown in part.
    expect(msg).toContain('T1:threw line1 line2 … |');
  });

  it('redactReason redacts credentials cut off at the length limit', () => {
    const long = `${'a'.repeat(100)} http://user:pa55word@host.example/`;
    expect(redactReason(long)).not.toContain('pa55word');
    expect(redactReason(long).length).toBeLessThanOrEqual(120);
    // Cut by the 2,000-char input bound before its "@", then pulled into
    // range by whitespace collapsing.
    const cut = `${' '.repeat(1_985)}see http://user:secret@host.example/`;
    expect(redactReason(cut)).toBe('see …');
    const proxyCut = `${'\n'.repeat(1_990)}via http://acct:longpassword@gw:1`;
    expect(redactReason(proxyCut, 'http://acct:longpassword@gw:1')).not.toMatch(/acct|longpa/);
  });
});

describe('compact example.com through the router', () => {
  it('both example.com shapes are accepted at T1', async () => {
    for (const html of [smallPage(), compactPage()]) {
      const { router } = setup();
      m.tier1Fetch.mockResolvedValue(page(html));
      await expect(router.route('https://example.com/', {})).resolves.toMatchObject({ tierUsed: 1 });
    }
  });
});
