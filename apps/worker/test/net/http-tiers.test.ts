import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DnsLookupError,
  OutboundBlockedError,
  TooManyRedirectsError,
  setOutboundPolicyForTests,
} from '@scrapeforge/shared';
import { tier1Fetch } from '../../src/engine/tier1-http.js';
import { tier2Fetch } from '../../src/engine/tier2-tls.js';
import {
  INTERNAL_IP,
  PUBLIC_IP,
  html,
  redirect,
  routes,
  startServer,
  useFixturePolicy,
  type FixtureServer,
} from './fixtures.js';

let site: FixtureServer;
let other: FixtureServer; // second public origin (different port)
let internal: FixtureServer;

beforeAll(async () => {
  internal = await startServer(INTERNAL_IP, html('<p>INTERNAL SECRET</p>'));
  other = await startServer(PUBLIC_IP, html('<p>OTHER ORIGIN</p>'));
  const chain: Record<string, ReturnType<typeof redirect>> = {};
  for (let i = 0; i < 11; i++) chain[`/chain/${i}`] = redirect(302, `/chain/${i + 1}`);
  site = await startServer(
    PUBLIC_IP,
    routes({
      '/start': redirect(301, '/a/one'),
      '/a/one': redirect(302, 'two'), // relative to /a/
      '/a/two': redirect(303, '/final?x=1'),
      '/final': html('<p>FINAL</p>'),
      '/temp': redirect(307, '/final'),
      '/perm': redirect(308, '/final'),
      '/to-internal-ip': (_req, res) => redirect(302, `${internal.origin}/secret`)(_req, res, ''),
      '/to-internal-mapped': (_req, res) =>
        redirect(302, `http://[::ffff:${INTERNAL_IP}]:${internal.port}/secret`)(_req, res, ''),
      '/to-internal-name': redirect(302, 'http://internal.test/secret'),
      '/to-mixed-name': redirect(302, 'http://mixed.test/'),
      '/to-metadata': redirect(302, 'http://169.254.169.254/latest/meta-data/'),
      '/to-file': redirect(302, 'file:///etc/passwd'),
      '/to-unresolvable': redirect(302, 'http://nowhere.test/'),
      '/to-other-origin': (_req, res) => redirect(302, `${other.origin}/landing`)(_req, res, ''),
      '/same-origin-hop': redirect(302, '/final'),
      '/endless-redirect-body': (_req, res) => {
        res.writeHead(302, { location: '/final' });
        res.write('x'.repeat(64 * 1024)); // never ended
      },
      ...chain,
      '/chain/11': html('<p>END OF CHAIN</p>'),
      '/not-modified': redirect(304, '/final'),
    }),
  );
});

afterAll(async () => {
  await Promise.all([site?.close(), other?.close(), internal?.close()]);
});

beforeEach(() => {
  useFixturePolicy();
  site.requests.length = 0;
  other.requests.length = 0;
  internal.requests.length = 0;
});

afterEach(() => setOutboundPolicyForTests(null));

describe.each([
  ['tier1', tier1Fetch],
  ['tier2', tier2Fetch],
] as const)('%s redirect handling', (_name, fetchTier) => {
  it('follows a mixed chain of redirects and reports the final URL', async () => {
    const r = await fetchTier(`${site.origin}/start`);
    expect(r.statusCode).toBe(200);
    expect(r.html).toContain('FINAL');
    expect(r.finalUrl).toBe(`${site.origin}/final?x=1`);
    expect(r.headers['content-type']).toContain('text/html');
    expect(site.requests.map((q) => q.url)).toEqual(['/start', '/a/one', '/a/two', '/final?x=1']);
    expect(site.requests.every((q) => q.method === 'GET')).toBe(true);
  });

  it.each(['/temp', '/perm'])('follows %s', async (path) => {
    const r = await fetchTier(`${site.origin}${path}`);
    expect(r.html).toContain('FINAL');
  });

  it('does not follow a non-redirect 3xx', async () => {
    const r = await fetchTier(`${site.origin}/not-modified`);
    expect(r.statusCode).toBe(304);
    expect(r.finalUrl).toBe(`${site.origin}/not-modified`);
  });

  it('refuses a blocked first URL without connecting', async () => {
    await expect(fetchTier(`${internal.origin}/secret`)).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(fetchTier('http://localhost/')).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(internal.requests).toHaveLength(0);
  });

  it.each([
    '/to-internal-ip',
    '/to-internal-mapped',
    '/to-internal-name',
    '/to-mixed-name',
    '/to-metadata',
    '/to-file',
  ])('refuses the hop from %s before connecting to it', async (path) => {
    const err = await fetchTier(`${site.origin}${path}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutboundBlockedError);
    expect(internal.requests).toHaveLength(0);
  });

  it('reports an unresolvable redirect target as a DNS failure', async () => {
    await expect(fetchTier(`${site.origin}/to-unresolvable`)).rejects.toBeInstanceOf(DnsLookupError);
  });

  it('allows 10 redirects and fails on the 11th', async () => {
    const ok = await fetchTier(`${site.origin}/chain/1`);
    expect(ok.html).toContain('END OF CHAIN');
    await expect(fetchTier(`${site.origin}/chain/0`)).rejects.toBeInstanceOf(TooManyRedirectsError);
  });

  it('does not wait for the body of a redirect response', async () => {
    const t0 = performance.now();
    const r = await fetchTier(`${site.origin}/endless-redirect-body`, { timeout: 5_000 });
    expect(r.html).toContain('FINAL');
    expect(performance.now() - t0).toBeLessThan(3_000);
  });

  it('drops credentials on cross-origin hops but keeps them on same-origin hops', async () => {
    const headers = { Authorization: 'Bearer secret', Cookie: 'sid=1', 'X-Custom': 'kept' };
    await fetchTier(`${site.origin}/same-origin-hop`, { headers });
    const sameOriginFinal = site.requests.at(-1)!;
    expect(sameOriginFinal.headers.authorization).toBe('Bearer secret');
    expect(sameOriginFinal.headers.cookie).toBe('sid=1');

    await fetchTier(`${site.origin}/to-other-origin`, { headers });
    const landing = other.requests.at(-1)!;
    expect(landing.url).toBe('/landing');
    expect(landing.headers.authorization).toBeUndefined();
    expect(landing.headers.cookie).toBeUndefined();
    expect(landing.headers['x-custom']).toBe('kept');
  });
});

describe('proxy option', () => {
  let proxy: FixtureServer;

  beforeAll(async () => {
    // A forward proxy receives absolute-form request targets.
    proxy = await startServer(PUBLIC_IP, html('<p>VIA PROXY</p>'));
  });
  afterAll(() => proxy.close());

  it.each([
    ['tier1', tier1Fetch],
    ['tier2', tier2Fetch],
  ] as const)('%s sends the request through options.proxy', async (_name, fetchTier) => {
    proxy.requests.length = 0;
    const r = await fetchTier(`${site.origin}/final`, { proxy: proxy.origin });
    expect(r.html).toContain('VIA PROXY');
    expect(proxy.requests.map((q) => q.url)).toEqual([`${site.origin}/final`]);
    expect(site.requests).toHaveLength(0);
  });

  it('still checks the target when a proxy is configured', async () => {
    proxy.requests.length = 0;
    await expect(tier2Fetch(`${internal.origin}/`, { proxy: proxy.origin })).rejects.toBeInstanceOf(
      OutboundBlockedError,
    );
    expect(proxy.requests).toHaveLength(0);
  });

  it('keeps working across many distinct proxy URLs (bounded client cache)', async () => {
    for (let i = 0; i < 70; i++) {
      const r = await tier2Fetch(`${site.origin}/final`, { proxy: `http://user${i}:pw@${PUBLIC_IP}:${proxy.port}` });
      expect(r.html).toContain('VIA PROXY');
    }
  });
});
