// "All tiers exhausted" carries whether any tier got a definitive answer from
// the site (a block/challenge page or an unusable page) or every tier only
// failed transiently (network errors, timeouts, 429/5xx without a block page,
// no browser context). worker.ts retries only the transient case. Tier
// fetchers and the proxy manager are stubbed; the acceptance gate is real.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { BrowserContext } from 'patchright';

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

const { SmartRouter, TiersExhaustedError } = await import('../../src/engine/router.js');

const URL_ = 'https://shop.example/item/1';
const SHELL =
  '<!doctype html><html><head><title>App</title><script src="/main.js"></script></head><body><div id="root"></div></body></html>';
const CF_CHALLENGE =
  '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="challenge-running">Checking your browser</div>' +
  '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></body></html>';
const DATADOME_CAPTCHA =
  '<html><head><title>shop.example</title></head><body><iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=abc&cid=def" ' +
  'title="DataDome CAPTCHA" width="100%" height="100%"></iframe></body></html>';
const NGINX_503 =
  '<html><head><title>503 Service Temporarily Unavailable</title></head><body><center><h1>503 Service Temporarily Unavailable</h1></center><hr><center>nginx</center></body></html>';

const page = (html: string, statusCode = 200) => ({ html, statusCode, latencyMs: 10, headers: {}, finalUrl: URL_ });
const respond = (html: string, statusCode = 200) => () => Promise.resolve(page(html, statusCode));
const fail = (message: string) => () => Promise.reject(new Error(message));

function setup() {
  const store = new Map<string, string>();
  const redis = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
  };
  const acquire = vi.fn(async () => ({}) as BrowserContext);
  const router = new SmartRouter(redis as unknown as Redis, acquire, vi.fn(), {
    random: () => 0.99,
    logger: { warn: vi.fn() },
  });
  return { router, acquire };
}

async function exhausted(router: InstanceType<typeof SmartRouter>) {
  const err = await router.route(URL_, {}).then(
    () => {
      throw new Error('expected the route to fail');
    },
    (e: unknown) => e,
  );
  await router.drainStrategyWrites();
  expect(err).toBeInstanceOf(TiersExhaustedError);
  const e = err as InstanceType<typeof TiersExhaustedError>;
  expect(e.code).toBe('TIERS_EXHAUSTED');
  expect(e.message).toMatch(/^All tiers exhausted for shop\.example — /);
  return e;
}

beforeEach(() => {
  vi.resetAllMocks();
  m.isLightpandaConfigured.mockReturnValue(false);
  m.proxySelect.mockResolvedValue(null);
  m.proxyEscalate.mockResolvedValue(null);
  m.proxyRecordResult.mockResolvedValue(undefined);
});

describe('exhausted-tiers classification', () => {
  it('only network errors and timeouts: transient', async () => {
    const { router } = setup();
    m.tier1Fetch.mockImplementation(fail('connect ECONNREFUSED 203.0.113.7:443'));
    m.tier2Fetch.mockImplementation(fail('The operation was aborted due to timeout'));
    m.tier4Fetch.mockImplementation(fail('page.goto: net::ERR_CONNECTION_REFUSED at https://shop.example/item/1'));
    m.tier4StealthFetch.mockImplementation(fail('Timeout: browser fetch exceeded its 30000 ms budget (navigation)'));
    const e = await exhausted(router);
    expect(e.transient).toBe(true);
    expect(e.contentRejected).toBe(false);
  });

  it('plain 503/502/429 responses (target briefly down or rate limiting): transient', async () => {
    const { router } = setup();
    m.tier1Fetch.mockImplementation(respond(NGINX_503, 503));
    m.tier2Fetch.mockImplementation(respond('', 429));
    m.tier4Fetch.mockImplementation(fail('page.goto: net::ERR_EMPTY_RESPONSE'));
    m.tier4StealthFetch.mockImplementation(fail('page.goto: net::ERR_EMPTY_RESPONSE'));
    expect((await exhausted(router)).transient).toBe(true);
  });

  it('no browser context for T5 after transient failures: transient', async () => {
    const { router, acquire } = setup();
    m.tier1Fetch.mockImplementation(fail('socket hang up'));
    m.tier2Fetch.mockImplementation(fail('socket hang up'));
    m.tier4Fetch.mockImplementation(fail('Timeout: browser fetch exceeded its 30000 ms budget (navigation)'));
    acquire.mockResolvedValueOnce({} as BrowserContext).mockRejectedValue(new Error('browser has crashed'));
    const e = await exhausted(router);
    expect(e.message).toMatch(/T5:threw browser has crashed$/);
    expect(e.transient).toBe(true);
  });

  it('Chromium failing to start for T4 after transient failures: transient', async () => {
    const { router, acquire } = setup();
    m.tier1Fetch.mockImplementation(fail('socket hang up'));
    m.tier2Fetch.mockImplementation(respond(NGINX_503, 502));
    acquire.mockRejectedValue(new Error('browserType.launch: Target page, context or browser has been closed'));
    const e = await exhausted(router);
    expect(e.message).toMatch(/T5:skipped \(no browser context\)$/);
    expect(e.transient).toBe(true);
  });

  it.each([
    ['a Cloudflare challenge (403)', respond(CF_CHALLENGE, 403)],
    ['a Cloudflare challenge served with 503', respond(CF_CHALLENGE, 503)],
    ['a DataDome captcha (429)', respond(DATADOME_CAPTCHA, 429)],
    ['a client-rendered shell the gate rejects (200)', respond(SHELL, 200)],
  ])('a tier got %s: definitive, not transient', async (_label, t1) => {
    const { router } = setup();
    m.tier1Fetch.mockImplementation(t1);
    m.tier2Fetch.mockImplementation(fail('socket hang up'));
    m.tier4Fetch.mockImplementation(fail('page.goto: net::ERR_TIMED_OUT'));
    m.tier4StealthFetch.mockImplementation(fail('page.goto: net::ERR_TIMED_OUT'));
    const e = await exhausted(router);
    expect(e.contentRejected).toBe(true);
    expect(e.transient).toBe(false);
  });
});
