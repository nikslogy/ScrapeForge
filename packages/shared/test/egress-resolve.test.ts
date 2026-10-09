// resolveForConnect: the connect-time check used by the worker's egress proxy.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertPublicUrl,
  isDnsLookupError,
  isOutboundBlockedError,
  resolveForConnect,
  setOutboundPolicyForTests,
} from '../src/net.js';

const ZONE: Record<string, string[]> = {
  'public.test': ['93.184.216.34'],
  'dual.test': ['93.184.216.34', '2606:4700::1111'],
  'mixed.test': ['93.184.216.34', '10.0.0.5'],
  'metadata.test': ['169.254.169.254'],
  'garbage.test': ['not-an-address'],
};

const asked: string[] = [];

async function fakeLookup(hostname: string): Promise<string[]> {
  asked.push(hostname);
  const answers = ZONE[hostname.replace(/\.$/, '')];
  if (!answers) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
  return [...answers];
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected promise to reject');
}

const savedEnv = { ...process.env };

beforeEach(() => {
  delete process.env.SCRAPEFORGE_ALLOW_PRIVATE_NETWORK;
  asked.length = 0;
  setOutboundPolicyForTests({ lookup: fakeLookup });
});

afterEach(() => {
  process.env = { ...savedEnv };
  setOutboundPolicyForTests(null);
});

describe('resolveForConnect', () => {
  it('returns every answer of a public name, to connect to as is', async () => {
    expect(await resolveForConnect('public.test')).toEqual(['93.184.216.34']);
    expect(await resolveForConnect('dual.test')).toEqual(['93.184.216.34', '2606:4700::1111']);
  });

  it('refuses a name when any answer is blocked, without exposing the address in the message', async () => {
    for (const host of ['mixed.test', 'metadata.test']) {
      const err = await rejection(resolveForConnect(host));
      expect(isOutboundBlockedError(err)).toBe(true);
      expect((err as Error).message).not.toMatch(/10\.0\.0\.5|169\.254/);
    }
  });

  it('checks IP literals (bracketed or not, legacy IPv4 spellings) without DNS', async () => {
    expect(await resolveForConnect('93.184.216.34')).toEqual(['93.184.216.34']);
    expect(await resolveForConnect('[2606:4700::1111]')).toEqual(['2606:4700::1111']);
    for (const host of ['127.0.0.1', '[::1]', '[::ffff:127.0.0.1]', '127.1', '0x7f.1', '2130706433', '0']) {
      expect(isOutboundBlockedError(await rejection(resolveForConnect(host))), host).toBe(true);
    }
    expect(await resolveForConnect('0x5d.184.216.34')).toEqual(['93.184.216.34']);
    expect(asked).toEqual([]);
  });

  it('applies the hostname rules before any lookup', async () => {
    for (const host of ['localhost', 'redis', 'metadata.google.internal', 'printer.local']) {
      expect(isOutboundBlockedError(await rejection(resolveForConnect(host))), host).toBe(true);
    }
    expect(asked).toEqual([]);
  });

  it('resolves afresh on every call, so a rebinding answer after the pre-check is refused', async () => {
    let n = 0;
    setOutboundPolicyForTests({ lookup: async () => (n++ === 0 ? ['93.184.216.34'] : ['10.0.0.7']) });
    await assertPublicUrl('https://rebind.test/'); // first answer: public (and cached by the pre-check)
    expect(isOutboundBlockedError(await rejection(resolveForConnect('rebind.test')))).toBe(true);
    expect(n).toBe(2);
  });

  it('keeps a trailing dot for the lookup (fully qualified, as the client asked)', async () => {
    expect(await resolveForConnect('public.test.')).toEqual(['93.184.216.34']);
    expect(asked).toEqual(['public.test.']);
  });

  it('reports unresolvable names and garbage answers as DNS failures', async () => {
    expect(isDnsLookupError(await rejection(resolveForConnect('nowhere.test')))).toBe(true);
    // A non-address answer is "blocked" by the fail-closed predicate.
    expect(isOutboundBlockedError(await rejection(resolveForConnect('garbage.test')))).toBe(true);
    expect(isDnsLookupError(await rejection(resolveForConnect(`${'a'.repeat(250)}.test`)))).toBe(true);
  });

  it('honours the dev override but still resolves (the caller needs addresses)', async () => {
    process.env.SCRAPEFORGE_ALLOW_PRIVATE_NETWORK = '1';
    expect(await resolveForConnect('mixed.test')).toEqual(['93.184.216.34', '10.0.0.5']);
    expect(await resolveForConnect('127.0.0.1')).toEqual(['127.0.0.1']);
    expect(await resolveForConnect('metadata.test', { allowPrivate: false }).catch((e) => e)).toSatisfy(
      isOutboundBlockedError,
    );
    process.env.NODE_ENV = 'production';
    expect(isOutboundBlockedError(await rejection(resolveForConnect('mixed.test')))).toBe(true);
  });

  it('uses the test policy predicate (127.0.0.1 public, 127.0.0.2 private)', async () => {
    setOutboundPolicyForTests({
      lookup: async (h) => (h === 'fixture.test' ? ['127.0.0.1'] : ['127.0.0.2']),
      isBlocked: (ip) => ip !== '127.0.0.1',
    });
    expect(await resolveForConnect('fixture.test')).toEqual(['127.0.0.1']);
    expect(isOutboundBlockedError(await rejection(resolveForConnect('other.test')))).toBe(true);
  });

  it('stops waiting for DNS when the signal fires', async () => {
    setOutboundPolicyForTests({ lookup: () => new Promise<string[]>(() => {}) });
    const controller = new AbortController();
    const pending = resolveForConnect('slow.test', { signal: controller.signal });
    controller.abort(new Error('client went away'));
    await expect(pending).rejects.toThrow('client went away');
  });
});
