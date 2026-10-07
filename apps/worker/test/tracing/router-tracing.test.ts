// SmartRouter tier-attempt tracing. Every tier fetcher, the quality gate and
// the proxy manager are stubbed, so these tests never touch the network, a
// browser or Redis. Tier stubs advance a fake clock shared with the tracer,
// which makes every recorded duration exact.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { BrowserContext } from 'patchright';
import type { ScrapeOptions } from '@scrapeforge/shared';

const m = vi.hoisted(() => ({
  clock: { t: 0 },
  tier1Fetch: vi.fn(),
  tier2Fetch: vi.fn(),
  tier3Fetch: vi.fn(),
  isLightpandaConfigured: vi.fn(),
  tier4Fetch: vi.fn(),
  tier4StealthFetch: vi.fn(),
  proxySelect: vi.fn(),
  proxyEscalate: vi.fn(),
  proxyRecordResult: vi.fn(),
}));

vi.mock('../../src/engine/tier1-http.js', () => ({
  tier1Fetch: m.tier1Fetch,
  // Deterministic stand-in for the block-page heuristics.
  isValidContent: (html: string, statusCode: number) =>
    statusCode < 400 && html.length > 0 && !html.includes('BLOCKED'),
}));
vi.mock('../../src/engine/tier2-tls.js', () => ({ tier2Fetch: m.tier2Fetch }));
vi.mock('../../src/engine/tier3-light.js', () => ({
  tier3Fetch: m.tier3Fetch,
  isLightpandaConfigured: m.isLightpandaConfigured,
}));
vi.mock('../../src/engine/tier4-browser.js', () => ({ tier4Fetch: m.tier4Fetch }));
vi.mock('../../src/engine/tier4-stealth.js', () => ({ tier4StealthFetch: m.tier4StealthFetch }));
vi.mock('../../src/extraction/quality-scorer.js', () => ({
  calculateQualityScore: (html: string) =>
    html.includes('THIN') ? { score: 0.2, signals: ['thin content'] } : { score: 0.9, signals: [] },
}));
vi.mock('../../src/proxy/manager.js', () => ({
  ProxyManager: class {
    select = m.proxySelect;
    escalate = m.proxyEscalate;
    recordResult = m.proxyRecordResult;
  },
}));

const { SmartRouter } = await import('../../src/engine/router.js');
const { StageTracer } = await import('../../src/tracing.js');

// ── helpers ─────────────────────────────────────────────

function page(html: string, statusCode = 200) {
  return { html, statusCode, latencyMs: 10, headers: {} };
}

/** Stub body: spends `ms` on the fake clock, then resolves `value`. */
function takes(ms: number, value: unknown) {
  return async () => {
    m.clock.t += ms;
    return value;
  };
}

/** Stub body: spends `ms` on the fake clock, then throws `thrown` (any value). */
function fails(ms: number, thrown: unknown) {
  return async () => {
    m.clock.t += ms;
    throw thrown;
  };
}

function setup(opts: { cached?: object; acquireMs?: number } = {}) {
  const store = new Map<string, string>();
  if (opts.cached) store.set('domain:example.com', JSON.stringify(opts.cached));
  const redis = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
  };
  let next = 0;
  const acquire = vi.fn(async () => {
    m.clock.t += opts.acquireMs ?? 7;
    return { id: ++next } as unknown as BrowserContext;
  });
  const release = vi.fn();
  const router = new SmartRouter(redis as unknown as Redis, acquire, release);
  const tracer = new StageTracer(() => m.clock.t);
  return { router, tracer, redis, acquire, release };
}

const URL_ = 'https://example.com/item/1';

beforeEach(() => {
  vi.resetAllMocks();
  m.clock.t = 0;
  m.isLightpandaConfigured.mockReturnValue(false);
  m.proxySelect.mockResolvedValue(null);
  m.proxyEscalate.mockResolvedValue(null);
  m.proxyRecordResult.mockResolvedValue(undefined);
});

// ── escalation chain ────────────────────────────────────

describe('SmartRouter tracing: escalation', () => {
  it('records a single accepted T1 attempt and no browser stage', async () => {
    const { router, tracer } = setup();
    m.tier1Fetch.mockImplementation(takes(100, page('<p>GOOD</p>')));

    const r = await router.route(URL_, {}, tracer);

    expect(r.tierUsed).toBe(1);
    expect(tracer.snapshot()).toEqual({
      stages: {},
      attempts: [{ tier: 1, ms: 100, outcome: 'accepted' }],
      totalMs: 100,
    });
    expect(m.tier2Fetch).not.toHaveBeenCalled();
  });

  it('records each escalation step with its reason and times browser acquisition', async () => {
    const { router, tracer, release } = setup({ acquireMs: 7 });
    m.tier1Fetch.mockImplementation(takes(120, page('<p>THIN</p>')));
    m.tier2Fetch.mockImplementation(fails(50, new Error('connect ECONNRESET')));
    m.tier4Fetch.mockImplementation(takes(900, page('<p>GOOD</p>')));

    const r = await router.route(URL_, {}, tracer);

    expect(r.tierUsed).toBe(4);
    const snap = tracer.snapshot();
    expect(snap.attempts).toEqual([
      { tier: 1, ms: 120, outcome: 'rejected', reason: 'low quality 0.20 (thin content)' },
      { tier: 2, ms: 50, outcome: 'error', reason: 'connect ECONNRESET' },
      // Attempt time includes waiting for the browser context.
      { tier: 4, ms: 907, outcome: 'accepted' },
    ]);
    expect(snap.stages).toEqual({ browser_acquire: 7 });
    expect(snap.totalMs).toBe(1077);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('traces T3 when Lightpanda is configured, including a null result', async () => {
    const { router, tracer } = setup();
    m.isLightpandaConfigured.mockReturnValue(true);
    m.tier1Fetch.mockImplementation(takes(10, page('BLOCKED')));
    m.tier2Fetch.mockImplementation(takes(20, page('nope', 403)));
    m.tier3Fetch.mockImplementation(takes(30, null));
    m.tier4Fetch.mockImplementation(takes(40, page('<p>GOOD</p>')));

    await router.route(URL_, {}, tracer);

    expect(tracer.snapshot().attempts).toEqual([
      { tier: 1, ms: 10, outcome: 'rejected', reason: 'invalid content (status=200 htmlLen=7)' },
      { tier: 2, ms: 20, outcome: 'rejected', reason: 'invalid content (status=403 htmlLen=4)' },
      { tier: 3, ms: 30, outcome: 'error', reason: 'no result' },
      { tier: 4, ms: 47, outcome: 'accepted' },
    ]);
  });

  it('accumulates browser_acquire across T4 and T5 and keeps the T4 fallback', async () => {
    const { router, tracer, release } = setup({ acquireMs: 5 });
    m.tier1Fetch.mockImplementation(takes(1, page('BLOCKED')));
    m.tier2Fetch.mockImplementation(takes(1, page('BLOCKED')));
    m.tier4Fetch.mockImplementation(takes(100, page('<p>THIN t4</p>')));
    m.tier4StealthFetch.mockImplementation(fails(200, new Error('stealth crashed')));

    const r = await router.route(URL_, {}, tracer);

    expect(r).toMatchObject({ tierUsed: 4, html: '<p>THIN t4</p>' });
    const snap = tracer.snapshot();
    expect(snap.attempts.map((a) => [a.tier, a.outcome, a.ms])).toEqual([
      [1, 'rejected', 1],
      [2, 'rejected', 1],
      [4, 'rejected', 105],
      [5, 'error', 205],
    ]);
    expect(snap.attempts[3].reason).toBe('stealth crashed');
    expect(snap.stages.browser_acquire).toBe(10);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('keeps the "All tiers exhausted" message unchanged and traces every failure', async () => {
    const { router, tracer } = setup();
    m.tier1Fetch.mockImplementation(fails(1, new Error('t1 down')));
    m.tier2Fetch.mockImplementation(fails(2, new Error('t2 down')));
    m.tier4Fetch.mockImplementation(fails(3, new Error('t4 down')));
    m.tier4StealthFetch.mockImplementation(fails(4, new Error('t5 down')));

    await expect(router.route(URL_, {}, tracer)).rejects.toThrow(
      'All tiers exhausted for example.com — T1:threw t1 down | T2:threw t2 down | T4:threw t4 down | T5:threw t5 down',
    );
    expect(tracer.snapshot().attempts).toEqual([
      { tier: 1, ms: 1, outcome: 'error', reason: 't1 down' },
      { tier: 2, ms: 2, outcome: 'error', reason: 't2 down' },
      { tier: 4, ms: 10, outcome: 'error', reason: 't4 down' },
      { tier: 5, ms: 11, outcome: 'error', reason: 't5 down' },
    ]);
  });

  it('keeps escalating when a tier throws a non-Error value', async () => {
    const { router, tracer } = setup();
    m.tier1Fetch.mockImplementation(fails(1, 'plain string'));
    m.tier2Fetch.mockImplementation(fails(1, undefined));
    m.tier4Fetch.mockImplementation(fails(1, Object.create(null)));
    m.tier4StealthFetch.mockImplementation(fails(1, null));

    await expect(router.route(URL_, {}, tracer)).rejects.toThrow(
      'T1:threw plain string | T2:threw undefined | T4:threw unprintable error | T5:threw null',
    );
    expect(tracer.snapshot().attempts.map((a) => a.reason)).toEqual([
      'plain string',
      'undefined',
      'unprintable error',
      'null',
    ]);
  });

  it('caps error reasons at 120 chars like the escalation notes', async () => {
    const { router, tracer } = setup();
    m.tier1Fetch.mockImplementation(fails(1, new Error('e'.repeat(500))));
    m.tier2Fetch.mockImplementation(takes(1, page('<p>GOOD</p>')));

    await router.route(URL_, {}, tracer);

    expect(tracer.snapshot().attempts[0].reason).toBe('e'.repeat(120));
  });

  it('redacts proxy credentials from traced reasons', async () => {
    const { router, tracer } = setup();
    m.tier1Fetch.mockImplementation(
      fails(1, new Error('tunnel via http://acct:hunter2@gw.proxy.example:8000 failed')),
    );
    m.tier2Fetch.mockImplementation(takes(1, page('<p>GOOD</p>')));

    await router.route(URL_, {}, tracer);

    expect(tracer.snapshot().attempts[0].reason).toBe(
      'tunnel via http://***@gw.proxy.example:8000 failed',
    );
  });

  it('traces browser acquisition failures as tier errors', async () => {
    const { router, tracer, acquire, release } = setup();
    acquire.mockImplementation(fails(3, new Error('pool closed')));
    m.tier1Fetch.mockImplementation(takes(1, page('BLOCKED')));
    m.tier2Fetch.mockImplementation(takes(1, page('BLOCKED')));

    await expect(router.route(URL_, {}, tracer)).rejects.toThrow(/All tiers exhausted/);

    const snap = tracer.snapshot();
    expect(snap.attempts.slice(2)).toEqual([
      { tier: 4, ms: 3, outcome: 'error', reason: 'pool closed' },
      { tier: 5, ms: 3, outcome: 'error', reason: 'pool closed' },
    ]);
    // Failed waits are still waits.
    expect(snap.stages.browser_acquire).toBe(6);
    expect(release).not.toHaveBeenCalled();
    expect(m.tier4Fetch).not.toHaveBeenCalled();
  });

  it('records the bookkeeping error when Redis fails after an accepted tier (escalation unchanged)', async () => {
    const { router, tracer, redis } = setup();
    redis.set.mockRejectedValueOnce(new Error('redis down'));
    m.tier1Fetch.mockImplementation(takes(10, page('<p>GOOD t1</p>')));
    m.tier2Fetch.mockImplementation(takes(20, page('<p>GOOD t2</p>')));

    const r = await router.route(URL_, {}, tracer);

    // Pre-existing behavior: a failed strategy write makes the router move on.
    expect(r).toMatchObject({ tierUsed: 2, html: '<p>GOOD t2</p>' });
    expect(tracer.snapshot().attempts).toEqual([
      { tier: 1, ms: 10, outcome: 'accepted' },
      { tier: 1, ms: 10, outcome: 'error', reason: 'redis down' },
      { tier: 2, ms: 20, outcome: 'accepted' },
    ]);
  });

  it('skips T1/T2 for JS-heavy domains on cold start', async () => {
    const { router, tracer } = setup();
    m.tier4Fetch.mockImplementation(takes(10, page('<p>GOOD</p>')));

    const r = await router.route('https://medium.com/@someone/post', {}, tracer);

    expect(r.tierUsed).toBe(4);
    expect(tracer.snapshot().attempts.map((a) => a.tier)).toEqual([4]);
    expect(m.tier1Fetch).not.toHaveBeenCalled();
  });

  it('passes the selected proxy through unchanged', async () => {
    const proxy = { url: 'http://proxy.local:1', tier: 'datacenter', cost: 0.001, provider: {} };
    m.proxySelect.mockResolvedValue(proxy);
    const { router, tracer } = setup();
    m.tier1Fetch.mockImplementation(takes(1, page('<p>THIN</p>')));
    m.tier2Fetch.mockImplementation(takes(1, page('<p>GOOD</p>')));

    const r = await router.route(URL_, { proxy: 'datacenter' }, tracer);

    expect(r).toMatchObject({ tierUsed: 2, proxyTier: 'datacenter', proxyCost: 0.001 });
    expect(m.tier2Fetch).toHaveBeenCalledWith(URL_, expect.objectContaining({ proxy: proxy.url }));
    expect(m.proxyRecordResult).toHaveBeenCalledWith(proxy, 'example.com', true, 10);
  });
});

// ── direct browser path ─────────────────────────────────

describe('SmartRouter tracing: browser path', () => {
  it.each<[string, ScrapeOptions]>([
    ['screenshot', { screenshot: true }],
    ['waitFor', { waitFor: '#main' }],
    ['mobile', { mobile: true }],
  ])('goes straight to T4 when %s is requested', async (_name, options) => {
    const { router, tracer } = setup({ acquireMs: 4 });
    m.tier4Fetch.mockImplementation(takes(300, page('<p>GOOD</p>')));

    const r = await router.route(URL_, options, tracer);

    expect(r.tierUsed).toBe(4);
    expect(tracer.snapshot()).toMatchObject({
      stages: { browser_acquire: 4 },
      attempts: [{ tier: 4, ms: 304, outcome: 'accepted' }],
    });
    expect(m.tier1Fetch).not.toHaveBeenCalled();
  });

  it('goes straight to the browser for hard domains', async () => {
    const { router, tracer } = setup();
    m.tier4Fetch.mockImplementation(takes(10, page('<p>GOOD</p>')));

    await router.route('https://www.walmart.com/ip/123', {}, tracer);

    expect(tracer.snapshot().attempts).toEqual([{ tier: 4, ms: 17, outcome: 'accepted' }]);
  });

  it('returns a rejected terminal T5 response and traces it as rejected', async () => {
    const { router, tracer, redis } = setup({ acquireMs: 1 });
    m.tier4Fetch.mockImplementation(takes(10, page('<p>THIN</p>')));
    m.tier4StealthFetch.mockImplementation(takes(20, page('BLOCKED')));

    const r = await router.route(URL_, { screenshot: true }, tracer);

    expect(r).toMatchObject({ tierUsed: 5, html: 'BLOCKED' });
    expect(tracer.snapshot()).toMatchObject({
      stages: { browser_acquire: 2 },
      attempts: [
        { tier: 4, ms: 11, outcome: 'rejected', reason: 'low quality 0.20 (thin content)' },
        { tier: 5, ms: 21, outcome: 'rejected', reason: 'invalid content (status=200 htmlLen=7)' },
      ],
    });
    // Domain strategy still records the failure, as before.
    const saved = JSON.parse(redis.set.mock.calls.at(-1)![1] as string);
    expect(saved.successRate).toBe(0);
  });

  it('propagates the original T5 error and traces it', async () => {
    const { router, tracer, release } = setup();
    const boom = new Error('stealth exploded');
    m.tier4Fetch.mockImplementation(fails(5, new Error('t4 failed')));
    m.tier4StealthFetch.mockImplementation(fails(6, boom));

    await expect(router.route(URL_, { waitFor: '#x' }, tracer)).rejects.toBe(boom);

    expect(tracer.snapshot().attempts).toEqual([
      { tier: 4, ms: 12, outcome: 'error', reason: 't4 failed' },
      { tier: 5, ms: 13, outcome: 'error', reason: 'stealth exploded' },
    ]);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('propagates a context acquisition failure without trying stealth', async () => {
    const { router, tracer, acquire } = setup();
    const noCtx = new Error('no contexts');
    acquire.mockImplementation(fails(2, noCtx));

    await expect(router.route(URL_, { screenshot: true }, tracer)).rejects.toBe(noCtx);

    expect(tracer.snapshot()).toEqual({
      stages: { browser_acquire: 2 },
      attempts: [{ tier: 4, ms: 2, outcome: 'error', reason: 'no contexts' }],
      totalMs: 2,
    });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(m.tier4StealthFetch).not.toHaveBeenCalled();
  });
});

// ── cached-tier fast path ───────────────────────────────

describe('SmartRouter tracing: cached tier', () => {
  const strategy = (tier: number) => ({
    tier,
    proxyTier: 'datacenter',
    successRate: 1,
    avgLatencyMs: 100,
    sampleSize: 5,
    lastUpdated: '2026-01-01T00:00:00.000Z',
  });

  it('records the single cached-tier attempt on a hit', async () => {
    const { router, tracer } = setup({ cached: strategy(2) });
    m.tier2Fetch.mockImplementation(takes(40, page('<p>GOOD</p>')));

    const r = await router.route(URL_, {}, tracer);

    expect(r.tierUsed).toBe(2);
    expect(tracer.snapshot().attempts).toEqual([{ tier: 2, ms: 40, outcome: 'accepted' }]);
    expect(m.tier1Fetch).not.toHaveBeenCalled();
  });

  it('traces the cached-tier miss followed by the full escalation', async () => {
    const { router, tracer } = setup({ cached: strategy(1) });
    m.tier1Fetch.mockImplementation(takes(30, page('<p>THIN</p>')));
    m.tier2Fetch.mockImplementation(takes(40, page('<p>GOOD</p>')));

    const r = await router.route(URL_, {}, tracer);

    expect(r.tierUsed).toBe(2);
    // The escalation re-runs T1 after the cached T1 attempt failed.
    expect(tracer.snapshot().attempts).toEqual([
      { tier: 1, ms: 30, outcome: 'rejected', reason: 'low quality 0.20 (thin content)' },
      { tier: 1, ms: 30, outcome: 'rejected', reason: 'low quality 0.20 (thin content)' },
      { tier: 2, ms: 40, outcome: 'accepted' },
    ]);
    expect(m.tier1Fetch).toHaveBeenCalledTimes(2);
  });

  it('traces a thrown cached-tier attempt as an error', async () => {
    const { router, tracer } = setup({ cached: strategy(2) });
    m.tier2Fetch
      .mockImplementationOnce(fails(15, new Error('tls handshake')))
      .mockImplementation(takes(5, page('<p>GOOD</p>')));
    m.tier1Fetch.mockImplementation(takes(5, page('BLOCKED')));

    await router.route(URL_, {}, tracer);

    expect(tracer.snapshot().attempts.map((a) => [a.tier, a.outcome, a.reason])).toEqual([
      [2, 'error', 'tls handshake'],
      [1, 'rejected', 'invalid content (status=200 htmlLen=7)'],
      [2, 'accepted', undefined],
    ]);
  });

  it('uses the browser path for cached browser tiers', async () => {
    const { router, tracer } = setup({ cached: strategy(4) });
    m.tier4Fetch.mockImplementation(takes(10, page('<p>GOOD</p>')));

    await router.route(URL_, {}, tracer);

    expect(tracer.snapshot().attempts).toEqual([{ tier: 4, ms: 17, outcome: 'accepted' }]);
  });
});

// ── tracer is optional ──────────────────────────────────

describe('SmartRouter without a tracer', () => {
  function arrangeEscalation() {
    m.tier1Fetch.mockImplementation(takes(1, page('<p>THIN</p>')));
    m.tier2Fetch.mockImplementation(fails(1, new Error('reset')));
    m.tier4Fetch.mockImplementation(takes(1, page('<p>THIN t4</p>')));
    m.tier4StealthFetch.mockImplementation(takes(1, page('<p>GOOD t5</p>')));
  }

  it('routes identically with and without a tracer', async () => {
    arrangeEscalation();
    const traced = setup();
    const withTracer = await traced.router.route(URL_, {}, traced.tracer);

    arrangeEscalation();
    const plain = setup();
    const withoutTracer = await plain.router.route(URL_, {});

    expect(withoutTracer).toEqual(withTracer);
    expect(plain.acquire).toHaveBeenCalledTimes(traced.acquire.mock.calls.length);
    expect(plain.release).toHaveBeenCalledTimes(traced.release.mock.calls.length);
    // Same strategy writes; lastUpdated is wall-clock time, so it is ignored.
    const writes = (calls: unknown[][]) =>
      calls.map(([key, json, ...rest]) => {
        const { lastUpdated: _ignored, ...strategy } = JSON.parse(String(json));
        return [key, strategy, ...rest];
      });
    expect(writes(plain.redis.set.mock.calls)).toEqual(writes(traced.redis.set.mock.calls));
    // T1 rejected, T4 rejected, T5 accepted (T2 threw before any write).
    expect(writes(plain.redis.set.mock.calls)).toHaveLength(3);
  });

  it('still surfaces failures unchanged', async () => {
    const { router } = setup();
    m.tier1Fetch.mockImplementation(fails(1, new Error('a')));
    m.tier2Fetch.mockImplementation(fails(1, new Error('b')));
    m.tier4Fetch.mockImplementation(fails(1, new Error('c')));
    m.tier4StealthFetch.mockImplementation(fails(1, new Error('d')));

    await expect(router.route(URL_, {})).rejects.toThrow(
      'All tiers exhausted for example.com — T1:threw a | T2:threw b | T4:threw c | T5:threw d',
    );
  });
});
