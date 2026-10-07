import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LookupAddress } from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DnsLookupError,
  OutboundBlockedError,
  TooManyRedirectsError,
  allowPrivateNetwork,
  assertPublicUrl,
  checkPublicUrl,
  clearOutboundCache,
  fetchWithSafeRedirects,
  guardedLookup,
  headersForHop,
  isBlockedAddress,
  isBlockedHostname,
  isDnsLookupError,
  isOutboundBlockedError,
  setOutboundPolicyForTests,
  type RedirectHop,
} from '../src/net.js';
import { isUrlSafe } from '../src/utils.js';

// Fake DNS used throughout: tests never touch the real resolver.
const ZONE: Record<string, string[]> = {
  'public.test': ['93.184.216.34'],
  'public6.test': ['2606:4700::1111'],
  'dual.test': ['93.184.216.34', '2606:4700::1111'],
  'loopback.test': ['127.0.0.1'],
  'metadata.test': ['169.254.169.254'],
  'mixed.test': ['93.184.216.34', '10.0.0.5'],
  'mixed6.test': ['2606:4700::1111', '::ffff:7f00:1'],
  'garbage.test': ['not-an-address'],
};

function fakeLookup(hostname: string): Promise<string[]> {
  const answers = ZONE[hostname.replace(/\.$/, '')];
  if (!answers) {
    const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return Promise.reject(err);
  }
  return Promise.resolve([...answers]);
}

const savedEnv = { ...process.env };

beforeEach(() => {
  delete process.env.SCRAPEFORGE_ALLOW_PRIVATE_NETWORK;
  setOutboundPolicyForTests({ lookup: fakeLookup });
});

afterEach(() => {
  process.env = { ...savedEnv };
  setOutboundPolicyForTests(null);
  vi.useRealTimers();
});

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected promise to reject');
}

// ─────────────────────────────────────────────────────────────
// isBlockedAddress
// ─────────────────────────────────────────────────────────────

describe('isBlockedAddress', () => {
  const blocked = [
    // IPv4 special ranges, edges included
    '0.0.0.0', '0.255.255.255', '10.0.0.0', '10.255.255.255',
    '100.64.0.0', '100.127.255.255', '127.0.0.1', '127.255.255.254',
    '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255',
    '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.0.1', '192.168.255.255',
    '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9',
    '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
    // Legacy IPv4 spellings (inet_aton / WHATWG URL forms)
    '0x7f.1', '0x7f.0x0.0x0.0x1', '2130706433', '017700000001', '0177.0.0.1',
    '127.1', '127.0.1', '0', '0x0', '0xA9FEA9FE', '2852039166', '127.0.0.1.',
    // IPv6
    '::', '::1', '[::1]', '0:0:0:0:0:0:0:1', 'fc00::1', 'fd12:3456::1',
    'fe80::1', 'fe80::1%lo0', 'FE80::ABCD%eth0', '[fe80::1%25en0]', 'febf::1',
    'fec0::1', 'ff02::1', 'ff05::1:3', '2001:db8::1', '2001:0db8:85a3::8a2e:370:7334',
    '100::1', '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '3fff::1',
    '64:ff9b:1::1',
    // IPv6 forms embedding a blocked IPv4
    '::ffff:127.0.0.1', '[::ffff:127.0.0.1]', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1',
    '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:10.0.0.1', '::ffff:0:7f00:1',
    '::127.0.0.1', '::7f00:1', '::a9fe:a9fe', '64:ff9b::a9fe:a9fe', '64:ff9b::127.0.0.1',
    '64:ff9b::10.1.2.3', '2002:a9fe:a9fe::', '2002:7f00:1::1', '2002:c0a8:0101:1::1',
    // Not an address at all: fail closed
    'not-an-ip', '', ' ', 'localhost', '1.2.3.4.5', '256.1.1.1', '1.2.3.256',
    '09.1.1.1', '0x', '::ffff:1.2.3', '1:2:3:4:5:6:7:8:9', ':::', '[::1', 'fe80::1%',
    '1'.repeat(400), `0x${'f'.repeat(300)}`,
  ];
  const allowed = [
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '100.63.255.255', '100.128.0.0',
    '172.15.255.255', '172.32.0.0', '192.0.1.1', '192.169.0.1', '198.17.255.255',
    '198.20.0.0', '223.255.255.255', '134744072', '0x8.0x8.0x8.0x8', '010.010.010.010',
    '2606:4700::1111', '2001:4860:4860::8888', '[2606:4700:4700::1001]',
    '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::8.8.8.8',
    '64:ff9b::808:808', '2002:808:808::1', '2001:db9::1', 'fbff::1', '2001:1::1',
  ];

  it.each(blocked)('blocks %j', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(allowed)('allows %j', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it('classifies 100k addresses quickly', () => {
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) isBlockedAddress(i % 2 ? '93.184.216.34' : '2606:4700::1111');
    expect(performance.now() - t0).toBeLessThan(1_500);
  });
});

// ─────────────────────────────────────────────────────────────
// isBlockedHostname / isUrlSafe (no DNS)
// ─────────────────────────────────────────────────────────────

describe('isBlockedHostname', () => {
  it.each([
    'localhost', 'LOCALHOST', 'localhost.', 'foo.localhost', 'a.b.localhost..',
    'printer.local', 'metadata.google.internal', 'box.localdomain', 'nas.home.arpa',
    'redis', 'metadata', '', '.',
  ])('blocks %j', (name) => {
    expect(isBlockedHostname(name)).toBe(true);
  });

  it.each(['example.com', 'localhost.example.com', 'notlocal.com', 'internal.example.org', 'home.arpa.example'])(
    'allows %j',
    (name) => {
      expect(isBlockedHostname(name)).toBe(false);
    },
  );
});

describe('isUrlSafe (cheap pre-check)', () => {
  it.each([
    'http://[::1]/', 'http://[::1]:8080/x', 'http://[::ffff:127.0.0.1]/', 'http://[fe80::1]/',
    'http://0x7f.1/', 'http://2130706433/', 'http://017700000001/', 'http://0/',
    'http://169.254.169.254/latest/meta-data/', 'http://100.64.1.1/', 'http://224.0.0.1/',
    'http://localhost:3000/', 'http://foo.localhost/', 'http://intranet/', 'file:///etc/passwd',
    'ftp://example.com/', 'gopher://example.com/', 'not a url',
  ])('rejects %j', (url) => {
    expect(isUrlSafe(url)).toBe(false);
  });

  it.each(['https://example.com/', 'http://8.8.8.8/', 'http://[2606:4700::1111]/', 'https://user:pw@example.com/'])(
    'accepts %j',
    (url) => {
      expect(isUrlSafe(url)).toBe(true);
    },
  );
});

// ─────────────────────────────────────────────────────────────
// assertPublicUrl
// ─────────────────────────────────────────────────────────────

describe('assertPublicUrl', () => {
  it('returns the parsed URL for a public host and keeps credentials', async () => {
    const url = await assertPublicUrl('https://user:secret@public.test:8443/a?b=1#c');
    expect(url).toBeInstanceOf(URL);
    expect(url.href).toBe('https://user:secret@public.test:8443/a?b=1#c');
  });

  it('accepts URL objects and returns a copy', async () => {
    const input = new URL('http://public.test/');
    const out = await assertPublicUrl(input);
    expect(out).not.toBe(input);
    expect(out.href).toBe(input.href);
  });

  it.each(['public6.test', 'dual.test'])('allows %s (all answers public)', async (host) => {
    await expect(assertPublicUrl(`http://${host}/`)).resolves.toBeInstanceOf(URL);
  });

  it.each([
    'file:///etc/passwd', 'ftp://public.test/', 'gopher://public.test:70/', 'javascript:alert(1)',
    'data:text/html,hi', 'ws://public.test/', 'chrome://settings', 'dict://public.test:11211/',
  ])('refuses the scheme of %s', async (url) => {
    const err = await rejection(assertPublicUrl(url));
    expect(err).toBeInstanceOf(OutboundBlockedError);
    expect((err as OutboundBlockedError).reason).toBe('scheme');
  });

  it('refuses unparseable input as invalid-url', async () => {
    const err = (await rejection(assertPublicUrl('http://[::1'))) as OutboundBlockedError;
    expect(err.code).toBe('OUTBOUND_BLOCKED');
    expect(err.reason).toBe('invalid-url');
  });

  it.each([
    ['http://127.0.0.1/', '127.0.0.1'],
    ['http://0x7f.1/', '127.0.0.1'],
    ['http://2130706433/', '127.0.0.1'],
    ['http://017700000001/', '127.0.0.1'],
    ['http://0177.0.0.1:6379/', '127.0.0.1'],
    ['http://127.1/', '127.0.0.1'],
    ['http://127.0.0.1./', '127.0.0.1'],
    ['http://0/', '0.0.0.0'],
    ['http://%31%32%37.0.0.1/', '127.0.0.1'],
    ['http://0xA9FEA9FE/latest/meta-data/', '169.254.169.254'],
    ['http://[::1]/', '::1'],
    ['http://[::]/', '::'],
    ['http://[::ffff:127.0.0.1]/', '::ffff:7f00:1'],
    ['http://[0:0:0:0:0:ffff:169.254.169.254]/', '::ffff:a9fe:a9fe'],
    ['http://[64:ff9b::a9fe:a9fe]/', '64:ff9b::a9fe:a9fe'],
    ['http://[2002:a9fe:a9fe::]/', '2002:a9fe:a9fe::'],
    ['http://[fd00::1]:8080/', 'fd00::1'],
  ])('blocks IP literal %s without a DNS lookup', async (url, host) => {
    const lookup = vi.fn(fakeLookup);
    const err = (await rejection(assertPublicUrl(url, { lookup }))) as OutboundBlockedError;
    expect(err).toBeInstanceOf(OutboundBlockedError);
    expect(err.reason).toBe('address');
    expect(err.hostname).toBe(host);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('allows public IP literals without a DNS lookup', async () => {
    const lookup = vi.fn(fakeLookup);
    await assertPublicUrl('http://8.8.8.8/', { lookup });
    await assertPublicUrl('http://[2606:4700::1111]:443/', { lookup });
    await assertPublicUrl('http://134744072/', { lookup });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    'http://localhost/', 'http://LOCALHOST:6379/', 'http://localhost./', 'http://app.localhost/',
    'http://metadata.google.internal/computeMetadata/v1/', 'http://printer.local/', 'http://redis:6379/',
  ])('blocks internal hostname %s without a DNS lookup', async (url) => {
    const lookup = vi.fn(fakeLookup);
    const err = (await rejection(assertPublicUrl(url, { lookup }))) as OutboundBlockedError;
    expect(err.reason).toBe('hostname');
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(['loopback.test', 'metadata.test', 'mixed.test', 'mixed6.test', 'garbage.test'])(
    'blocks %s because an answer is private (or unparseable)',
    async (host) => {
      const err = (await rejection(assertPublicUrl(`http://${host}/`))) as OutboundBlockedError;
      expect(err).toBeInstanceOf(OutboundBlockedError);
      expect(err.reason).toBe('address');
      expect(err.message).toMatch(/resolves to a private or reserved address/);
      // Matches the worker's permanent-failure classifier (no BullMQ retries).
      expect(err.message).toMatch(/SSRF|private.*address/);
    },
  );

  it('never puts the resolved address or URL credentials in the message', async () => {
    const err = (await rejection(
      assertPublicUrl('http://admin:hunter2@metadata.test/latest'),
    )) as OutboundBlockedError;
    expect(err.message).not.toContain('169.254');
    expect(err.message).not.toContain('hunter2');
    expect(err.address).toBe('169.254.169.254');
  });

  it('reports DNS failure as a distinct, non-security error', async () => {
    const err = await rejection(assertPublicUrl('http://nowhere.test/'));
    expect(err).toBeInstanceOf(DnsLookupError);
    expect(err).not.toBeInstanceOf(OutboundBlockedError);
    expect(isOutboundBlockedError(err)).toBe(false);
    expect(isDnsLookupError(err)).toBe(true);
    expect((err as DnsLookupError).message).toBe('DNS lookup failed for nowhere.test (ENOTFOUND)');
    expect((err as DnsLookupError).lookupCode).toBe('ENOTFOUND');
  });

  it('treats an empty answer as a DNS failure', async () => {
    const err = await rejection(assertPublicUrl('http://x.test/', { lookup: async () => [] }));
    expect(err).toBeInstanceOf(DnsLookupError);
  });

  it('treats a synchronously throwing resolver as a DNS failure', async () => {
    const lookup = (): Promise<string[]> => {
      throw new Error('boom');
    };
    expect(await rejection(assertPublicUrl('http://x.test/', { lookup }))).toBeInstanceOf(DnsLookupError);
  });

  it('times out a hung resolver after 5 s', async () => {
    vi.useFakeTimers();
    const pending = rejection(assertPublicUrl('http://slow.test/', { lookup: () => new Promise(() => {}) }));
    await vi.advanceTimersByTimeAsync(5_000);
    const err = (await pending) as DnsLookupError;
    expect(err).toBeInstanceOf(DnsLookupError);
    expect(err.lookupCode).toBe('ETIMEOUT');
  });

  it('stops waiting for DNS when the signal aborts', async () => {
    const controller = new AbortController();
    const pending = rejection(
      assertPublicUrl('http://slow.test/', { lookup: () => new Promise(() => {}), signal: controller.signal }),
    );
    controller.abort(new Error('deadline'));
    expect(((await pending) as Error).message).toBe('deadline');
    await expect(
      assertPublicUrl('http://public.test/', { signal: AbortSignal.abort(new Error('already')) }),
    ).rejects.toThrow('already');
  });

  it('allowPrivate skips address checks but still enforces the scheme', async () => {
    await expect(assertPublicUrl('http://127.0.0.1:8080/', { allowPrivate: true })).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://localhost/', { allowPrivate: true })).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('file:///etc/passwd', { allowPrivate: true })).rejects.toBeInstanceOf(
      OutboundBlockedError,
    );
  });

  it('defaults allowPrivate from the environment (never in production)', async () => {
    process.env.SCRAPEFORGE_ALLOW_PRIVATE_NETWORK = '1';
    process.env.NODE_ENV = 'test';
    expect(allowPrivateNetwork()).toBe(true);
    await expect(assertPublicUrl('http://127.0.0.1/')).resolves.toBeInstanceOf(URL);

    process.env.NODE_ENV = 'production';
    expect(allowPrivateNetwork()).toBe(false);
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toBeInstanceOf(OutboundBlockedError);

    process.env.NODE_ENV = 'test';
    process.env.SCRAPEFORGE_ALLOW_PRIVATE_NETWORK = 'true';
    expect(allowPrivateNetwork()).toBe(false);
  });

  it('honours an injected address predicate for IP literals and lookups', async () => {
    setOutboundPolicyForTests({ lookup: fakeLookup, isBlocked: (ip) => ip === '93.184.216.34' });
    await expect(assertPublicUrl('http://127.0.0.1/')).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://public.test/')).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it('refuses to swap the policy in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => setOutboundPolicyForTests({ isBlocked: () => false })).toThrow(/production/);
  });
});

describe('assertPublicUrl caching', () => {
  it('caches allowed hosts for 30 s', async () => {
    const lookup = vi.fn(fakeLookup);
    setOutboundPolicyForTests({ lookup });
    vi.useFakeTimers();
    await assertPublicUrl('http://public.test/a');
    await assertPublicUrl('http://public.test/b');
    expect(lookup).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    await assertPublicUrl('http://public.test/c');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent lookups of one host', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const lookup = vi.fn(async (host: string) => {
      await gate;
      return fakeLookup(host);
    });
    setOutboundPolicyForTests({ lookup });
    const all = Promise.all(Array.from({ length: 25 }, () => assertPublicUrl('http://public.test/')));
    release();
    await all;
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('never serves a blocked host as allowed, even after its DNS turns public', async () => {
    let answer = ['10.0.0.1'];
    const lookup = vi.fn(async () => answer);
    setOutboundPolicyForTests({ lookup });
    await expect(assertPublicUrl('http://flip.test/')).rejects.toBeInstanceOf(OutboundBlockedError);
    answer = ['93.184.216.34'];
    await expect(assertPublicUrl('http://flip.test/')).rejects.toBeInstanceOf(OutboundBlockedError);
    clearOutboundCache();
    await expect(assertPublicUrl('http://flip.test/')).resolves.toBeInstanceOf(URL);
  });

  it('does not cache DNS failures', async () => {
    let fail = true;
    const lookup = vi.fn(async () => {
      if (fail) throw Object.assign(new Error('try again'), { code: 'EAI_AGAIN' });
      return ['93.184.216.34'];
    });
    setOutboundPolicyForTests({ lookup });
    await expect(assertPublicUrl('http://flaky.test/')).rejects.toBeInstanceOf(DnsLookupError);
    fail = false;
    await expect(assertPublicUrl('http://flaky.test/')).resolves.toBeInstanceOf(URL);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('does not let a per-call resolver populate the shared cache', async () => {
    await expect(
      assertPublicUrl('http://public.test/', { lookup: async () => ['93.184.216.34'] }),
    ).resolves.toBeInstanceOf(URL);
    const lookup = vi.fn(async () => ['127.0.0.1']);
    setOutboundPolicyForTests({ lookup });
    await expect(assertPublicUrl('http://public.test/')).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('drops a lookup that finished after the policy changed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setOutboundPolicyForTests({ lookup: async () => (await gate, ['93.184.216.34']) });
    const first = assertPublicUrl('http://late.test/');
    const lookup = vi.fn(async () => ['10.0.0.1']);
    setOutboundPolicyForTests({ lookup });
    release();
    await first;
    await expect(assertPublicUrl('http://late.test/')).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('bounds the cache at 5,000 hosts (least recently used evicted)', async () => {
    const lookup = vi.fn(async () => ['93.184.216.34']);
    setOutboundPolicyForTests({ lookup });
    await assertPublicUrl('http://h0.test/');
    for (let i = 1; i <= 5_000; i++) await assertPublicUrl(`http://h${i}.test/`);
    expect(lookup).toHaveBeenCalledTimes(5_001);
    await assertPublicUrl('http://h5000.test/'); // recent: cached
    expect(lookup).toHaveBeenCalledTimes(5_001);
    await assertPublicUrl('http://h0.test/'); // oldest: evicted
    expect(lookup).toHaveBeenCalledTimes(5_002);
  });
});

describe('checkPublicUrl', () => {
  it('maps outcomes to a result value', async () => {
    const ok = await checkPublicUrl('http://public.test/');
    expect(ok.ok).toBe(true);
    const blocked = await checkPublicUrl('http://metadata.test/');
    expect(blocked).toMatchObject({ ok: false, reason: 'blocked' });
    const dns = await checkPublicUrl('http://nowhere.test/');
    expect(dns).toMatchObject({ ok: false, reason: 'dns' });
  });
});

// ─────────────────────────────────────────────────────────────
// guardedLookup (connect-time check)
// ─────────────────────────────────────────────────────────────

function callLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
): Promise<{ err: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number }> {
  return new Promise((resolve) => {
    guardedLookup(hostname, options, (err, address, family) => resolve({ err, address, family }));
  });
}

describe('guardedLookup', () => {
  it('answers in single and all forms', async () => {
    expect(await callLookup('dual.test', {})).toEqual({ err: null, address: '93.184.216.34', family: 4 });
    expect(await callLookup('dual.test', { all: true })).toMatchObject({
      err: null,
      address: [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:4700::1111', family: 6 },
      ],
    });
    expect(await callLookup('dual.test', { family: 6 })).toMatchObject({ address: '2606:4700::1111', family: 6 });
  });

  it('refuses when any answer is blocked', async () => {
    const { err } = await callLookup('mixed.test', { all: true });
    expect(isOutboundBlockedError(err)).toBe(true);
  });

  it('resolves afresh on every call (no cache), defeating rebinding after the pre-check', async () => {
    let n = 0;
    setOutboundPolicyForTests({ lookup: async () => (n++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']) });
    await assertPublicUrl('http://rebind.test/');
    const { err } = await callLookup('rebind.test', {});
    expect(isOutboundBlockedError(err)).toBe(true);
  });

  it('passes DNS failures and family mismatches through as DNS errors', async () => {
    expect(isDnsLookupError((await callLookup('nowhere.test', {})).err)).toBe(true);
    expect(isDnsLookupError((await callLookup('public.test', { family: 6 })).err)).toBe(true);
  });

  it('turns a throwing predicate into an error instead of hanging', async () => {
    setOutboundPolicyForTests({
      lookup: fakeLookup,
      isBlocked: () => {
        throw new Error('bad predicate');
      },
    });
    expect(isDnsLookupError((await callLookup('public.test', {})).err)).toBe(true);
  });

  it('blocks a real http.request whose host resolves to a blocked address', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const get = (host: string) =>
        new Promise<number>((resolve, reject) => {
          http
            .get({ host, port, path: '/', lookup: guardedLookup }, (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            })
            .on('error', reject);
        });
      setOutboundPolicyForTests({
        lookup: async (h) => (h === 'ok.test' || h === 'bad.test' ? ['127.0.0.1'] : []),
        isBlocked: () => false,
      });
      expect(await get('ok.test')).toBe(200);
      setOutboundPolicyForTests({ lookup: async () => ['127.0.0.1'] });
      expect(isOutboundBlockedError(await rejection(get('bad.test')))).toBe(true);
      expect(hits).toEqual(['/']);
    } finally {
      server.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// fetchWithSafeRedirects
// ─────────────────────────────────────────────────────────────

interface FakeResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: string;
}

function respond(status: number, location?: string, body = ''): FakeResponse {
  return {
    status,
    body,
    headers: { get: (name: string) => (name.toLowerCase() === 'location' ? location ?? null : null) },
  };
}

/** Fake origin: path → response. Records every URL requested. */
function fakeSite(routes: Record<string, FakeResponse | ((hop: RedirectHop) => FakeResponse)>) {
  const requested: RedirectHop[] = [];
  const fetchHop = vi.fn(async (hop: RedirectHop) => {
    requested.push(hop);
    const route = routes[hop.url.href];
    if (!route) return respond(404);
    return typeof route === 'function' ? route(hop) : route;
  });
  return { fetchHop, requested };
}

describe('fetchWithSafeRedirects', () => {
  it('returns a non-redirect response directly', async () => {
    const { fetchHop } = fakeSite({ 'http://public.test/': respond(200, undefined, 'hi') });
    const out = await fetchWithSafeRedirects('http://public.test/', fetchHop);
    expect(out.response.body).toBe('hi');
    expect(out.url.href).toBe('http://public.test/');
    expect(out.redirects).toBe(0);
  });

  it('follows 301/302/303/307/308 and resolves relative Locations against the current URL', async () => {
    const { fetchHop, requested } = fakeSite({
      'http://public.test/a/start': respond(301, 'next'),
      'http://public.test/a/next': respond(302, '/b/c?x=1'),
      'http://public.test/b/c?x=1': respond(303, '//dual.test/d'),
      'http://dual.test/d': respond(307, 'https://public6.test/e'),
      'https://public6.test/e': respond(308, '../f#frag'),
      'https://public6.test/f#frag': respond(200, undefined, 'done'),
    });
    const discard = vi.fn();
    const out = await fetchWithSafeRedirects('http://public.test/a/start', fetchHop, { discard });
    expect(out.response.body).toBe('done');
    expect(out.redirects).toBe(5);
    expect(out.url.href).toBe('https://public6.test/f#frag');
    expect(requested.map((h) => h.hop)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(discard).toHaveBeenCalledTimes(5);
  });

  it('checks the first URL before any request', async () => {
    const { fetchHop } = fakeSite({});
    await expect(fetchWithSafeRedirects('http://169.254.169.254/', fetchHop)).rejects.toBeInstanceOf(
      OutboundBlockedError,
    );
    await expect(fetchWithSafeRedirects('http://nowhere.test/', fetchHop)).rejects.toBeInstanceOf(DnsLookupError);
    expect(fetchHop).not.toHaveBeenCalled();
  });

  it.each([
    'http://127.0.0.1:6379/',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://0x7f.1/',
    'http://metadata.test/',
    'http://mixed.test/',
    'http://localhost/',
    'file:///etc/passwd',
    'gopher://public.test:6379/_INFO',
  ])('refuses a redirect to %s without requesting it', async (target) => {
    const { fetchHop, requested } = fakeSite({ 'http://public.test/': respond(302, target) });
    const err = await rejection(fetchWithSafeRedirects('http://public.test/', fetchHop));
    expect(isOutboundBlockedError(err)).toBe(true);
    expect(requested.map((h) => h.url.href)).toEqual(['http://public.test/']);
  });

  it('allows exactly maxRedirects hops and fails on one more', async () => {
    const chain = (n: number) => {
      const routes: Record<string, FakeResponse> = {};
      for (let i = 0; i < n; i++) routes[`http://public.test/${i}`] = respond(302, `/${i + 1}`);
      routes[`http://public.test/${n}`] = respond(200, undefined, 'end');
      return fakeSite(routes);
    };
    const ten = chain(10);
    expect((await fetchWithSafeRedirects('http://public.test/0', ten.fetchHop)).redirects).toBe(10);
    const eleven = chain(11);
    const err = await rejection(fetchWithSafeRedirects('http://public.test/0', eleven.fetchHop));
    expect(err).toBeInstanceOf(TooManyRedirectsError);
    expect(eleven.fetchHop).toHaveBeenCalledTimes(11);
    const custom = chain(3);
    await expect(
      fetchWithSafeRedirects('http://public.test/0', custom.fetchHop, { maxRedirects: 2 }),
    ).rejects.toBeInstanceOf(TooManyRedirectsError);
  });

  it('stops on a self-redirect loop', async () => {
    const { fetchHop } = fakeSite({ 'http://public.test/': respond(302, '') });
    await expect(fetchWithSafeRedirects('http://public.test/', fetchHop)).rejects.toBeInstanceOf(
      TooManyRedirectsError,
    );
  });

  it.each([
    [300, '/x'],
    [304, '/x'],
    [305, '/x'],
    [302, undefined],
    [302, 'http://[::1'],
    [200, '/x'],
  ])('returns status %i with Location %j as the final response', async (status, location) => {
    const { fetchHop } = fakeSite({ 'http://public.test/': respond(status, location) });
    const out = await fetchWithSafeRedirects('http://public.test/', fetchHop);
    expect(out.response.status).toBe(status);
    expect(fetchHop).toHaveBeenCalledTimes(1);
  });

  it('keeps going when releasing a body fails', async () => {
    const { fetchHop } = fakeSite({
      'http://public.test/': respond(302, '/ok'),
      'http://public.test/ok': respond(200),
    });
    const discard = vi.fn(async () => {
      throw new Error('stream gone');
    });
    expect((await fetchWithSafeRedirects('http://public.test/', fetchHop, { discard })).response.status).toBe(200);
  });

  it('marks hops after leaving the initial origin as cross-origin, permanently', async () => {
    const { fetchHop, requested } = fakeSite({
      'http://public.test/': respond(302, '/same'),
      'http://public.test/same': respond(302, 'https://public.test/scheme-change'),
      'https://public.test/scheme-change': respond(302, 'http://public.test/back'),
      'http://public.test/back': respond(200),
    });
    await fetchWithSafeRedirects('http://public.test/', fetchHop);
    expect(requested.map((h) => h.sameOrigin)).toEqual([true, true, false, false]);
  });
});

describe('headersForHop', () => {
  const headers = {
    Authorization: 'Bearer t',
    COOKIE: 'a=b',
    'Proxy-Authorization': 'Basic x',
    'Accept-Language': 'en',
  };

  it('keeps everything on same-origin hops', () => {
    expect(headersForHop(headers, { sameOrigin: true })).toBe(headers);
  });

  it('drops credentials case-insensitively on cross-origin hops', () => {
    expect(headersForHop(headers, { sameOrigin: false })).toEqual({ 'Accept-Language': 'en' });
  });
});

describe('hostile hostnames', () => {
  it('handles a 200k-dot hostname in linear time', async () => {
    const host = `a${'.'.repeat(200_000)}b`;
    const t0 = performance.now();
    expect(isBlockedHostname(host)).toBe(false);
    expect(isBlockedHostname(`localhost${'.'.repeat(200_000)}`)).toBe(true);
    expect(isUrlSafe(`http://${host}/`)).toBe(true);
    const lookup = vi.fn(fakeLookup);
    const err = (await rejection(assertPublicUrl(`http://${host}/`, { lookup }))) as DnsLookupError;
    expect(err).toBeInstanceOf(DnsLookupError);
    expect(lookup).not.toHaveBeenCalled();
    expect(err.message.length).toBeLessThan(200);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('keeps over-long names out of the resolver and error messages short', async () => {
    const lookup = vi.fn(fakeLookup);
    const longName = `${'a'.repeat(60)}.`.repeat(5) + 'test';
    expect(await rejection(assertPublicUrl(`http://${longName}/`, { lookup }))).toBeInstanceOf(DnsLookupError);
    expect(lookup).not.toHaveBeenCalled();
    const blocked = (await rejection(assertPublicUrl(`http://${'a'.repeat(300)}.localhost/`))) as OutboundBlockedError;
    expect(blocked.message.length).toBeLessThan(200);
  });

  it('still resolves a fully qualified name with its trailing dot', async () => {
    const lookup = vi.fn(fakeLookup);
    await assertPublicUrl('http://public.test./', { lookup });
    expect(lookup).toHaveBeenCalledWith('public.test.');
  });
});
