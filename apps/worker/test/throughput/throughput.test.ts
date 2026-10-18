// Phase 3 throughput pieces: the fetch snapshot cache, request coalescing,
// per-site fetch limits and the model-call gate. Redis-backed parts run
// against a throwaway redis-server.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resultCacheKey, snapshotCacheKey, type ScrapeOptions } from '@scrapeforge/shared';
import { ensureRedis, shutdownRedis } from '../../../../tests/latency/lib/redis-instance.js';
import { Coalescer, flightKey } from '../../src/throughput/coalesce.js';
import { DomainBusyError, DomainLimiter, domainConcurrency, domainKey, Semaphore } from '../../src/throughput/limits.js';
import { SECTION_ADD } from '../../src/engine/router.js';
import {
  decodeSnapshot,
  encodeSnapshot,
  MAX_SNAPSHOT_BYTES,
  readSnapshot,
  snapshotEligible,
  snapshotTtlSec,
  snapshotWorthy,
  writeSnapshot,
  type PageSnapshot,
  type SnapshotKv,
} from '../../src/throughput/snapshot.js';
import { Budget } from '../../src/extract/llm/budget.js';
import { CircuitBreaker } from '../../src/extract/llm/breaker.js';
import { ModelClient } from '../../src/extract/llm/client.js';
import { fakeCaps, fakeResponse, FakeProvider } from '../../src/extract/llm/providers/fake.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

let port = 0;
let started = false;
let redis: Redis;

beforeAll(async () => {
  port = await freePort();
  started = await ensureRedis(port);
  redis = new Redis(port, '127.0.0.1', { maxRetriesPerRequest: null });
}, 30_000);

afterAll(async () => {
  await redis?.quit();
  if (started) shutdownRedis(port);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────

describe('snapshot cache', () => {
  const page: PageSnapshot = { html: '<html><body><h1>Hi</h1></body></html>', statusCode: 200, tierUsed: 4, proxyTier: 'none', fetchedAt: 1_700_000_000_000 };

  it('round-trips through gzip and rejects other versions or junk', () => {
    expect(decodeSnapshot(encodeSnapshot(page))).toEqual(page);
    expect(decodeSnapshot(Buffer.from('not gzip'))).toBeNull();
  });

  it('is used only when the request allows it, and keeps only clean fetches', () => {
    expect(snapshotEligible({}, 300)).toBe(true);
    expect(snapshotEligible({ cacheTtl: 0 }, 300)).toBe(false);
    expect(snapshotEligible({ screenshot: true }, 300)).toBe(false);
    expect(snapshotEligible({ formats: ['markdown', 'screenshot'] }, 300)).toBe(false);
    expect(snapshotEligible({}, 0)).toBe(false);
    expect(snapshotWorthy(200, false, '<p>x</p>')).toBe(true);
    expect(snapshotWorthy(403, false, '<p>x</p>')).toBe(false);
    expect(snapshotWorthy(200, true, '<p>x</p>')).toBe(false);
    expect(snapshotWorthy(200, false, '')).toBe(false);
    expect(snapshotTtlSec({})).toBe(300);
    expect(snapshotTtlSec({ SNAPSHOT_TTL_SEC: '0' })).toBe(0);
    expect(snapshotTtlSec({ SNAPSHOT_TTL_SEC: 'x' })).toBe(300);
  });

  it('keys by what shapes the fetch: tenant and credentials yes, schema and formats no', () => {
    const base: ScrapeOptions = { formats: ['markdown'] };
    const k = snapshotCacheKey('t1', 'https://a.example/p', base);
    expect(k).toMatch(/^snapshot:v1:/);
    expect(snapshotCacheKey('t1', 'https://a.example/p', { ...base, formats: ['html'], extractSchema: { title: 'string' } })).toBe(k);
    expect(snapshotCacheKey('t2', 'https://a.example/p', base)).not.toBe(k);
    expect(snapshotCacheKey('t1', 'https://a.example/p', { ...base, headers: { Authorization: 'Bearer x' } })).not.toBe(k);
    expect(snapshotCacheKey('t1', 'https://a.example/p', { ...base, mobile: true })).not.toBe(k);
    // The result cache key does depend on the schema.
    expect(resultCacheKey('t1', 'https://a.example/p', { ...base, extractSchema: { title: 'string' } })).not.toBe(resultCacheKey('t1', 'https://a.example/p', base));
  });

  it('reads and writes through Redis, expiring with the TTL', async () => {
    const kv: SnapshotKv = { getBuffer: (k) => redis.getBuffer(k), set: (k, v, m, t) => redis.set(k, v, m, t) };
    const key = `snapshot:v1:test-${Math.random()}`;
    expect(await readSnapshot(kv, key)).toBeNull();
    expect(await writeSnapshot(kv, key, page, 60)).toBe(true);
    expect(await readSnapshot(kv, key)).toEqual(page);
    expect(await redis.ttl(key)).toBeGreaterThan(50);
    expect(await writeSnapshot(kv, key, page, 0)).toBe(false);
  });

  it('never fails a job: store errors and oversized pages are skipped', async () => {
    const broken: SnapshotKv = { getBuffer: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); } };
    expect(await readSnapshot(broken, 'k')).toBeNull();
    expect(await writeSnapshot(broken, 'k', page, 60)).toBe(false);
    // Random base64 compresses to about 3/4: still larger than the cap after gzip.
    const noise = randomBytes(MAX_SNAPSHOT_BYTES * 1.5).toString('base64');
    const kv: SnapshotKv = { getBuffer: async () => null, set: async () => 'OK' };
    expect(await writeSnapshot(kv, 'k', { ...page, html: noise }, 60)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────

describe('request coalescing', () => {
  const kv = () => ({
    set: (k: string, v: string, px: 'PX', ms: number, nx: 'NX') => redis.set(k, v, px, ms, nx),
    get: (k: string) => redis.get(k),
    eval: (script: string, n: number, ...args: Array<string | number>) => redis.eval(script, n, ...args),
  });

  it('the first job leads, the second follows it, a retried leader still leads', async () => {
    const c = new Coalescer(kv());
    const key = flightKey(`cache:${Math.random()}`);
    expect(await c.claim(key, 'job-a', 5_000)).toBeNull();
    expect(await c.claim(key, 'job-b', 5_000)).toBe('job-a');
    expect(await c.claim(key, 'job-a', 5_000)).toBeNull();
    // Only the holder releases.
    await c.release(key, 'job-b');
    expect(await redis.get(key)).toBe('job-a');
    await c.release(key, 'job-a');
    expect(await redis.get(key)).toBeNull();
  });

  it("a follower gets the leader's result as soon as it is stored", async () => {
    const c = new Coalescer(kv(), { pollMs: 20 });
    const key = flightKey(`cache:${Math.random()}`);
    await c.claim(key, 'lead', 5_000);
    setTimeout(() => void redis.set('result:lead-x', '{"ok":1}', 'EX', 60).then(() => c.release(key, 'lead')), 80);
    const t0 = Date.now();
    const got = await c.waitFor(key, 'lead', Date.now() + 5_000, (id) => redis.get(`result:${id}-x`));
    expect(got).toBe('{"ok":1}');
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('a leader that disappears without a result releases its followers at once', async () => {
    const c = new Coalescer(kv(), { pollMs: 20 });
    const key = flightKey(`cache:${Math.random()}`);
    await c.claim(key, 'lead', 5_000);
    setTimeout(() => void c.release(key, 'lead'), 50);
    const t0 = Date.now();
    expect(await c.waitFor(key, 'lead', Date.now() + 5_000, async () => null)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('claims expire (a crashed worker never blocks a key) and followers stop at their deadline', async () => {
    const c = new Coalescer(kv(), { pollMs: 20 });
    const key = flightKey(`cache:${Math.random()}`);
    await c.claim(key, 'crashed', 100);
    await sleep(150);
    expect(await c.claim(key, 'next', 5_000)).toBeNull();
    const t0 = Date.now();
    expect(await c.waitFor(key, 'next', Date.now() + 120, async () => null)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("a failed result from the leader's previous attempt is waited past while the leader holds the key", async () => {
    const c = new Coalescer(kv(), { pollMs: 20 });
    const key = flightKey(`cache:${Math.random()}`);
    const resultKey = `result:${Math.random()}`;
    // Attempt 1 failed and left its result; the BullMQ retry (same job id) leads again.
    await redis.set(resultKey, '{"status":"failed"}', 'EX', 60);
    await c.claim(key, 'lead', 5_000);
    setTimeout(() => void redis.set(resultKey, '{"status":"completed"}', 'EX', 60).then(() => c.release(key, 'lead')), 120);
    const completed = (raw: string) => (JSON.parse(raw) as { status: string }).status === 'completed';
    const got = await c.waitFor(key, 'lead', Date.now() + 5_000, () => redis.get(resultKey), completed);
    expect(got).toBe('{"status":"completed"}');
    // A leader that fails for good releases the key: its failure is returned at once.
    const key2 = flightKey(`cache:${Math.random()}`);
    await c.claim(key2, 'lead', 5_000);
    await c.release(key2, 'lead');
    expect(await c.waitFor(key2, 'lead', Date.now() + 5_000, async () => '{"status":"failed"}', completed)).toBe('{"status":"failed"}');
  });

  it('a store failure makes every job lead (coalescing never fails a job)', async () => {
    const c = new Coalescer({ set: async () => { throw new Error('down'); }, get: async () => null, eval: async () => { throw new Error('down'); } });
    expect(await c.claim('k', 'j', 1_000)).toBeNull();
    await expect(c.release('k', 'j')).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────

describe('Semaphore', () => {
  it('caps work in flight and serves waiters in order', async () => {
    const s = new Semaphore(2);
    const order: string[] = [];
    const task = (name: string, ms: number) => s.run(async () => {
      order.push(`start ${name}`);
      await sleep(ms);
      order.push(`end ${name}`);
    });
    await Promise.all([task('a', 30), task('b', 30), task('c', 5), task('d', 5)]);
    expect(order.slice(0, 2)).toEqual(['start a', 'start b']);
    expect(order.indexOf('start c')).toBeGreaterThan(order.indexOf('end a') < order.indexOf('end b') ? order.indexOf('end a') : order.indexOf('end b'));
    expect(s.active).toBe(0);
  });

  it('a waiter whose signal aborts leaves the queue', async () => {
    const s = new Semaphore(1);
    const release = await s.acquire();
    const ctl = new AbortController();
    const waiting = s.acquire(ctl.signal);
    ctl.abort(new Error('gave up'));
    await expect(waiting).rejects.toThrow('gave up');
    expect(s.waiting).toBe(0);
    release();
    release();
    expect(s.active).toBe(0);
  });
});

describe('per-site fetch limit', () => {
  const kv = () => ({ eval: (script: string, n: number, ...args: Array<string | number>) => redis.eval(script, n, ...args) });

  it('holds at most `limit` fetches per site; www. shares the budget; other sites are independent', async () => {
    const limiter = new DomainLimiter(kv(), { limit: 2, pollMs: 10 });
    const host = `shop-${Math.random().toString(36).slice(2)}.example`;
    const deadline = Date.now() + 5_000;
    const a = await limiter.acquire(`https://${host}/1`, deadline);
    const b = await limiter.acquire(`https://www.${host}/2`, deadline);
    let third = false;
    const c = limiter.acquire(`https://${host}/3`, deadline).then((r) => {
      third = true;
      return r;
    });
    const other = await limiter.acquire(`https://other-${host}/`, deadline);
    await sleep(60);
    expect(third).toBe(false);
    await a();
    await (await c)();
    expect(third).toBe(true);
    await b();
    await other();
    expect(await redis.zcard(domainKey(`https://${host}/`)!)).toBe(0);
  });

  it('a lease expires at its deadline (a crashed worker frees its slots)', async () => {
    const limiter = new DomainLimiter(kv(), { limit: 1, pollMs: 10 });
    const host = `crash-${Math.random().toString(36).slice(2)}.example`;
    await limiter.acquire(`https://${host}/`, Date.now() + 80); // never released
    const t0 = Date.now();
    const release = await limiter.acquire(`https://${host}/`, Date.now() + 5_000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
    await release();
  });

  it('gives up at the deadline with a timeout error, and on abort', async () => {
    const limiter = new DomainLimiter(kv(), { limit: 1, pollMs: 10 });
    const host = `busy-${Math.random().toString(36).slice(2)}.example`;
    const hold = await limiter.acquire(`https://${host}/`, Date.now() + 5_000);
    await expect(limiter.acquire(`https://${host}/`, Date.now() + 50)).rejects.toBeInstanceOf(DomainBusyError);
    const ctl = new AbortController();
    const waiting = limiter.acquire(`https://${host}/`, Date.now() + 5_000, { signal: ctl.signal });
    ctl.abort(new Error('job deadline'));
    await expect(waiting).rejects.toThrow('job deadline');
    await hold();
  });

  it('a short lease never shortens the others: the site key lives as long as its longest lease', async () => {
    const limiter = new DomainLimiter(kv(), { limit: 2, pollMs: 10 });
    const host = `ttl-${Math.random().toString(36).slice(2)}.example`;
    const long = await limiter.acquire(`https://${host}/a`, Date.now() + 5_000);
    await limiter.acquire(`https://${host}/b`, Date.now() + 100); // a short job, never released
    expect(await redis.pttl(domainKey(`https://${host}/`)!)).toBeGreaterThan(4_000);
    await sleep(250);
    // The long lease still holds its slot: one is free, not two.
    const third = await limiter.acquire(`https://${host}/c`, Date.now() + 1_000);
    await expect(limiter.acquire(`https://${host}/d`, Date.now() + 150)).rejects.toBeInstanceOf(DomainBusyError);
    await third();
    await long();
  });

  it('a lease with a TTL outlives the wait deadline for fetches still running after it', async () => {
    const limiter = new DomainLimiter(kv(), { limit: 1, pollMs: 10 });
    const host = `tail-${Math.random().toString(36).slice(2)}.example`;
    await limiter.acquire(`https://${host}/`, Date.now() + 50, { leaseTtlMs: 5_000 });
    await sleep(120);
    await expect(limiter.acquire(`https://${host}/`, Date.now() + 100)).rejects.toBeInstanceOf(DomainBusyError);
  });

  it('a lease with a TTL is counted from its grant: granted late in a long wait, it still lives its TTL', async () => {
    const limiter = new DomainLimiter(kv(), { limit: 1, pollMs: 10 });
    const host = `late-${Math.random().toString(36).slice(2)}.example`;
    const hold = await limiter.acquire(`https://${host}/`, Date.now() + 5_000);
    const deadline = Date.now() + 400;
    const late = limiter.acquire(`https://${host}/`, deadline, { leaseTtlMs: 2_000 });
    await sleep(300);
    await hold();
    await late; // granted ~100 ms before its wait deadline
    await sleep(Math.max(0, deadline - Date.now()) + 200);
    // Past the wait deadline, inside the TTL: the slot is still held.
    await expect(limiter.acquire(`https://${host}/`, Date.now() + 100)).rejects.toBeInstanceOf(DomainBusyError);
  });

  it('a crashed holder\'s lease with a TTL expires that long after its grant, not at a far wait deadline', async () => {
    const limiter = new DomainLimiter(kv(), { limit: 1, pollMs: 10 });
    const host = `ttl-crash-${Math.random().toString(36).slice(2)}.example`;
    await limiter.acquire(`https://${host}/`, Date.now() + 120_000, { leaseTtlMs: 150 }); // never released nor renewed
    expect(await redis.pttl(domainKey(`https://${host}/`)!)).toBeLessThanOrEqual(150);
    const t0 = Date.now();
    const release = await limiter.acquire(`https://${host}/`, Date.now() + 2_000);
    expect(Date.now() - t0).toBeLessThan(1_000);
    await release();
  });

  it('shares a busy site between tenants: one holding its share waits while another tenant waits', async () => {
    const limiter = new DomainLimiter(kv(), { limit: 4, pollMs: 10 });
    const host = `fair-${Math.random().toString(36).slice(2)}.example`;
    const url = `https://${host}/`;
    const deadline = Date.now() + 5_000;
    const a = await Promise.all([1, 2, 3, 4].map(() => limiter.acquire(url, deadline, { tenant: 'A' })));
    const order: string[] = [];
    const aMore = limiter.acquire(url, deadline, { tenant: 'A' }).then((r) => (order.push('A'), r));
    const b1 = limiter.acquire(url, deadline, { tenant: 'B' }).then((r) => (order.push('B1'), r));
    const b2 = limiter.acquire(url, deadline, { tenant: 'B' }).then((r) => (order.push('B2'), r));
    await sleep(60);
    // A frees two slots: both go to B (A holds 3 or 2 of 4, at or above its share of 2).
    await a[0]();
    await (await b1)();
    await a[1]();
    await sleep(60);
    expect(order.slice(0, 2)).toEqual(['B1', 'B2']);
    // B is done waiting: A may take the free slots again.
    await (await b2)();
    await (await aMore)();
    expect(order).toEqual(['B1', 'B2', 'A']);
    for (const r of a.slice(2)) await r();
  });

  it('a renewed lease outlives its first expiry while its fetch runs', async () => {
    const limiter = new DomainLimiter(kv(), { limit: 1, pollMs: 10 });
    const host = `renew-${Math.random().toString(36).slice(2)}.example`;
    const lease = await limiter.acquire(`https://${host}/`, Date.now() + 80);
    await lease.renew(Date.now() + 5_000);
    await sleep(150);
    await expect(limiter.acquire(`https://${host}/`, Date.now() + 100)).rejects.toBeInstanceOf(DomainBusyError);
    await lease();
    await (await limiter.acquire(`https://${host}/`, Date.now() + 1_000))();
  });

  it('max-min between tenants: a freed slot goes to the waiting tenant holding the fewest', async () => {
    const limiter = new DomainLimiter(kv(), { limit: 6, pollMs: 10 });
    const url = `https://maxmin-${Math.random().toString(36).slice(2)}.example/`;
    const deadline = Date.now() + 5_000;
    const held: Record<string, Array<() => Promise<void>>> = { A: [], B: [], C: [] };
    for (const t of ['A', 'B', 'C']) for (let i = 0; i < 2; i++) held[t].push(await limiter.acquire(url, deadline, { tenant: t }));
    const order: string[] = [];
    const d = limiter.acquire(url, deadline, { tenant: 'D' }).then((r) => (order.push('D'), r));
    const a = limiter.acquire(url, deadline, { tenant: 'A' }).then((r) => (order.push('A'), r));
    await sleep(60);
    // A frees one of its two: A (now 1) must not take it back ahead of D (0).
    await held.A[0]();
    await sleep(80);
    expect(order).toEqual(['D']);
    await held.B[0]();
    await (await a)();
    expect(order).toEqual(['D', 'A']);
    await (await d)();
    for (const r of [held.A[1], held.B[1], ...held.C]) await r();
  });

  it('is off with limit 0, and never fails a job when the store is down', async () => {
    const off = new DomainLimiter(kv(), { limit: 0 });
    await (await off.acquire('https://a.example/', Date.now() + 1_000))();
    const down = new DomainLimiter({ eval: async () => { throw new Error('down'); } }, { limit: 1 });
    await (await down.acquire('https://a.example/', Date.now() + 1_000))();
    expect(domainConcurrency({})).toBe(6);
    expect(domainConcurrency({ FETCH_DOMAIN_CONCURRENCY: '0' })).toBe(0);
    expect(domainKey('not a url')).toBeNull();
  });
});

describe('per-site section set (router)', () => {
  it('admits known sections and at most `max` new ones, and keeps the set alive', async () => {
    const key = `domain-section-set:${Math.random().toString(36).slice(2)}.example`;
    const now = Date.now();
    const add = (section: string, at = now) => redis.eval(SECTION_ADD, 1, key, section, 2, 60, at);
    expect(await add('/a')).toBe(1);
    expect(await add('/b')).toBe(1);
    expect(await add('/c')).toBe(0);
    expect(await add('/a')).toBe(1);
    expect(await redis.zcard(key)).toBe(2);
    expect(await redis.ttl(key)).toBeGreaterThan(50);
    // A section unwritten for the TTL gives its slot up, even while another stays busy.
    expect(await add('/a', now + 61_000)).toBe(1);
    expect(await add('/c', now + 61_500)).toBe(1);
    expect(await redis.zrange(key, 0, -1)).toEqual(['/a', '/c']);
  });
});

// ─────────────────────────────────────────────────────────────

describe('model-call gate', () => {
  it('serializes provider calls beyond the cap, across requests', async () => {
    let inFlight = 0;
    let peak = 0;
    const provider = new FakeProvider(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(20);
      inFlight--;
      return fakeResponse('{"records":[]}');
    });
    const client = new ModelClient({ models: [fakeCaps()], providers: { fake: provider }, breaker: new CircuitBreaker(), gate: new Semaphore(2) });
    const req = { system: 's', user: 'u', maxOutputTokens: 100 };
    await Promise.all(Array.from({ length: 6 }, () => client.complete(req, { purpose: 'extract', budget: new Budget({ deadlineMs: Date.now() + 10_000 }) })));
    expect(peak).toBe(2);
    expect(provider.calls).toHaveLength(6);
  });

  it('a call still waiting at its deadline ends as budget_exhausted', async () => {
    const gate = new Semaphore(1);
    const hold = await gate.acquire();
    const client = new ModelClient({ models: [fakeCaps()], providers: { fake: new FakeProvider(() => fakeResponse('{}')) }, breaker: new CircuitBreaker(), gate });
    await expect(
      client.complete({ system: 's', user: 'u', maxOutputTokens: 10 }, { purpose: 'extract', budget: new Budget({ deadlineMs: Date.now() + 50 }) }),
    ).rejects.toMatchObject({ category: 'budget_exhausted' });
    hold();
  });
});
