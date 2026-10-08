// BrowserPool: slot accounting, bounded waits, cleaning between users,
// recovery. A fake browser is used for the logic; one test launches a real
// Chromium through PLAYWRIGHT_CHROMIUM_EXECUTABLE with the worker's
// three-argument constructor.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, LaunchOptions } from 'patchright';
import { BrowserPool, BrowserPoolError } from '../../src/browser/pool.js';
import { findChromium } from '../../../../tests/latency/lib/chromium-path.js';

class FakeContext {
  static seq = 0;
  readonly id = ++FakeContext.seq;
  closed = false;
  workers: unknown[] = [];
  serviceWorkers = () => this.workers;
  clearCookies = vi.fn(async () => {});
  close = vi.fn(async () => {
    this.closed = true;
  });
}

class FakeBrowser extends EventEmitter {
  connected = true;
  created: FakeContext[] = [];
  createDelayMs = 0;
  failNext = 0;
  newContext = vi.fn(async (_opts?: unknown) => {
    if (this.createDelayMs) await new Promise((r) => setTimeout(r, this.createDelayMs));
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('newContext failed');
    }
    const c = new FakeContext();
    this.created.push(c);
    return c;
  });
  isConnected() {
    return this.connected;
  }
  close = vi.fn(async () => {
    this.connected = false;
  });
  crash() {
    this.connected = false;
    this.emit('disconnected');
  }
}

function makePool(
  max = 2,
  opts: { uses?: number; ageMs?: number; acquireTimeoutMs?: number; maxWaiters?: number; executablePath?: string } = {},
) {
  const browsers: FakeBrowser[] = [];
  const launch = vi.fn(async (_o: LaunchOptions) => {
    const b = new FakeBrowser();
    browsers.push(b);
    return b as unknown as Browser;
  });
  const logger = { log: vi.fn(), warn: vi.fn() };
  const pool = new BrowserPool(max, opts.uses ?? 100, opts.ageMs ?? 60_000, {
    launch,
    logger,
    acquireTimeoutMs: opts.acquireTimeoutMs ?? 5_000,
    maxWaiters: opts.maxWaiters,
    executablePath: opts.executablePath,
  });
  return { pool, launch, browsers, logger, browser: () => browsers[browsers.length - 1] };
}

const asFake = (c: BrowserContext) => c as unknown as FakeContext;
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
  delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  delete process.env.BROWSER_ACQUIRE_TIMEOUT_MS;
  delete process.env.BROWSER_POOL_MAX_WAITERS;
});

describe('BrowserPool construction and launch', () => {
  it('keeps the worker\'s three-argument constructor and validates the size', () => {
    expect(() => new BrowserPool(5, 100, 30 * 60 * 1000)).not.toThrow();
    expect(() => new BrowserPool(0)).toThrow(RangeError);
    expect(() => new BrowserPool(1.5)).toThrow(RangeError);
  });

  it('launches PLAYWRIGHT_CHROMIUM_EXECUTABLE when set, and an explicit path over it', async () => {
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE = '/env/chrome';
    const a = makePool(1);
    await a.pool.initialize();
    expect(a.launch.mock.calls[0][0]).toMatchObject({ headless: true, executablePath: '/env/chrome' });

    const b = makePool(1, { executablePath: '/explicit/chrome' });
    await b.pool.initialize();
    expect(b.launch.mock.calls[0][0].executablePath).toBe('/explicit/chrome');

    delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
    const c = makePool(1);
    await c.pool.initialize();
    expect(c.launch.mock.calls[0][0]).not.toHaveProperty('executablePath');
  });

  it('warms min(3, max) fingerprinted contexts, keeping service-worker requests routed', async () => {
    const { pool, browser } = makePool(5);
    await pool.initialize();
    expect(browser().newContext).toHaveBeenCalledTimes(3);
    for (const [opts] of browser().newContext.mock.calls) {
      expect(opts).toMatchObject({ userAgent: expect.any(String), viewport: expect.any(Object) });
      // 'block' would stop Patchright routing worker requests through the SSRF guard.
      expect(opts).not.toHaveProperty('serviceWorkers');
    }
    expect(pool.stats()).toEqual({ total: 3, inUse: 0, idle: 3, creating: 0, waiting: 0 });
  });

  it('closes Chromium when initialization fails, and can be initialized again', async () => {
    const { pool, launch, browsers } = makePool(2);
    launch.mockImplementationOnce(async () => {
      const b = new FakeBrowser();
      b.failNext = 1;
      browsers.push(b);
      return b as unknown as Browser;
    });
    await expect(pool.initialize()).rejects.toThrow('newContext failed');
    expect(browsers[0].close).toHaveBeenCalled();
    await expect(pool.initialize()).resolves.toBeUndefined();
    expect(pool.stats().total).toBe(2);
  });
});

describe('BrowserPool slots', () => {
  it('never creates more than maxContexts under concurrent acquire()', async () => {
    const { pool, browser } = makePool(2);
    await pool.initialize();
    // Drop the warm contexts so every acquire must create one.
    const warm = await Promise.all([pool.acquire(), pool.acquire()]);
    browser().newContext.mockClear();
    browser().createDelayMs = 20;
    for (const c of warm) asFake(c).clearCookies.mockRejectedValueOnce(new Error('dead'));
    for (const c of warm) pool.release(c);
    await vi.waitFor(() => expect(pool.stats().total).toBe(0));

    const all = Array.from({ length: 6 }, () => pool.acquire());
    await vi.waitFor(() => expect(pool.stats().inUse).toBe(2));
    expect(browser().newContext).toHaveBeenCalledTimes(2);
    expect(pool.stats()).toMatchObject({ total: 2, waiting: 4 });

    const got: BrowserContext[] = [];
    for (const p of all) {
      const ctx = await Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 200))]);
      if (!ctx) continue;
      got.push(ctx);
      pool.release(ctx);
    }
    // Everyone was served, by the same two contexts.
    const results = await Promise.all(all);
    expect(new Set(results.map((c) => asFake(c).id)).size).toBe(2);
    expect(browser().newContext).toHaveBeenCalledTimes(2);
  });

  it('acquire(timeoutMs) fails with a clear error and leaves the queue', async () => {
    const { pool } = makePool(1);
    await pool.initialize();
    const held = await pool.acquire();

    const t0 = performance.now();
    const err = await pool.acquire(50).catch((e: unknown) => e);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(45);
    expect(err).toBeInstanceOf(BrowserPoolError);
    expect(err).toMatchObject({ reason: 'timeout', code: 'BROWSER_POOL_UNAVAILABLE' });
    expect((err as Error).message).toBe('Timed out after 50 ms waiting for a browser context');
    expect(pool.stats().waiting).toBe(0);

    // The released context is not handed to the caller that gave up.
    pool.release(held);
    await tick();
    expect(pool.stats()).toMatchObject({ idle: 1, inUse: 0 });
  });

  it('uses the constructor or environment default timeout', async () => {
    process.env.BROWSER_ACQUIRE_TIMEOUT_MS = '30';
    const launch = vi.fn(async () => new FakeBrowser() as unknown as Browser);
    const pool = new BrowserPool(1, 100, 60_000, { launch, logger: { log() {}, warn() {} } });
    await pool.initialize();
    await pool.acquire();
    await expect(pool.acquire()).rejects.toThrow('Timed out after 30 ms');
  });

  it('rejects at once beyond maxWaiters', async () => {
    const { pool } = makePool(1, { maxWaiters: 2 });
    await pool.initialize();
    await pool.acquire();
    const w1 = pool.acquire();
    const w2 = pool.acquire();
    await expect(pool.acquire()).rejects.toMatchObject({ reason: 'queue-full' });
    expect(pool.stats().waiting).toBe(2);
    await pool.shutdown();
    await expect(w1).rejects.toMatchObject({ reason: 'closed' });
    await expect(w2).rejects.toMatchObject({ reason: 'closed' });
  });

  it('serves waiters first-come first-served', async () => {
    const { pool } = makePool(1);
    await pool.initialize();
    const held = await pool.acquire();
    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) =>
      pool.acquire().then((c) => {
        order.push(n);
        pool.release(c);
      }),
    );
    pool.release(held);
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
  });

  it('ignores a second release of the same context and unknown contexts', async () => {
    const { pool } = makePool(1);
    await pool.initialize();
    const ctx = await pool.acquire();
    pool.release(ctx);
    await tick();
    const again = await pool.acquire();
    expect(again).toBe(ctx);
    pool.release({} as BrowserContext); // unknown object: no-op
    const waiter = pool.acquire(100);
    pool.release(again);
    pool.release(again); // double release must not hand it out twice
    const w = await waiter;
    expect(w).toBe(again);
    await expect(pool.acquire(30)).rejects.toMatchObject({ reason: 'timeout' });
  });
});

describe('BrowserPool cleaning and recycling', () => {
  it('clears cookies before the context is handed to the next user', async () => {
    const { pool } = makePool(1);
    await pool.initialize();
    const ctx = await pool.acquire();
    let finishClear!: () => void;
    asFake(ctx).clearCookies.mockImplementationOnce(() => new Promise<void>((r) => (finishClear = r)));
    const next = pool.acquire();
    pool.release(ctx);
    let handed = false;
    void next.then(() => (handed = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(handed).toBe(false);
    finishClear();
    expect(await next).toBe(ctx);
  });

  it('replaces a context whose cookies cannot be cleared', async () => {
    const { pool, browser } = makePool(1);
    await pool.initialize();
    const ctx = await pool.acquire();
    asFake(ctx).clearCookies.mockRejectedValueOnce(new Error('target closed'));
    const next = pool.acquire();
    pool.release(ctx);
    const fresh = await next;
    expect(fresh).not.toBe(ctx);
    expect(asFake(ctx).closed).toBe(true);
    expect(browser().created).toHaveLength(2);
  });

  it('gives up on a hanging clearCookies after 5 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { pool } = makePool(1);
    await pool.initialize();
    const ctx = await pool.acquire();
    asFake(ctx).clearCookies.mockImplementationOnce(() => new Promise<void>(() => {}));
    const next = pool.acquire(60_000);
    pool.release(ctx);
    await vi.advanceTimersByTimeAsync(5_001);
    const fresh = await next;
    expect(fresh).not.toBe(ctx);
    expect(asFake(ctx).closed).toBe(true);
  });

  it('retires a context a page left a service worker in', async () => {
    const { pool } = makePool(1);
    await pool.initialize();
    const ctx = await pool.acquire();
    asFake(ctx).workers.push({});
    const next = pool.acquire();
    pool.release(ctx);
    const fresh = await next;
    expect(fresh).not.toBe(ctx);
    expect(asFake(ctx).closed).toBe(true);
    expect(asFake(ctx).clearCookies).not.toHaveBeenCalled();
  });

  it('recycles after maxUsesPerContext uses', async () => {
    const { pool } = makePool(1, { uses: 2 });
    await pool.initialize();
    const first = await pool.acquire();
    pool.release(first);
    await tick();
    const second = await pool.acquire();
    expect(second).toBe(first);
    pool.release(second); // second use: expired
    await tick();
    expect(asFake(first).closed).toBe(true);
    const third = await pool.acquire();
    expect(third).not.toBe(first);
  });

  it('recycles contexts that expired while idle instead of waiting forever', async () => {
    const { pool } = makePool(2, { ageMs: 30 });
    await pool.initialize();
    await new Promise((r) => setTimeout(r, 50));
    // Both warm contexts are now too old; the previous pool kept them in
    // their slots and acquire() waited forever.
    const ctx = await pool.acquire(500);
    expect(pool.stats()).toMatchObject({ total: 1, inUse: 1 });
    expect(asFake(ctx).closed).toBe(false);
  });

  it('hands the error to a waiter when its replacement context cannot be created', async () => {
    const { pool, browser } = makePool(1, { uses: 1 });
    await pool.initialize();
    const ctx = await pool.acquire(); // its single use
    const waiter = pool.acquire(10_000);
    browser().failNext = 1;
    pool.release(ctx); // expired → retired → replacement fails
    await expect(waiter).rejects.toThrow('newContext failed');
    expect(pool.stats()).toMatchObject({ total: 0, creating: 0, waiting: 0 });
    // The slot is free again.
    await expect(pool.acquire(100)).resolves.toBeTruthy();
  });

  it('frees the slot when creating a context fails in acquire()', async () => {
    const { pool, browser } = makePool(1);
    await pool.initialize();
    const warm = await pool.acquire();
    asFake(warm).clearCookies.mockRejectedValueOnce(new Error('dead'));
    pool.release(warm);
    await vi.waitFor(() => expect(pool.stats().total).toBe(0));
    browser().failNext = 1;
    await expect(pool.acquire()).rejects.toThrow('newContext failed');
    expect(pool.stats().creating).toBe(0);
    await expect(pool.acquire(100)).resolves.toBeTruthy();
  });
});

describe('BrowserPool failed creation', () => {
  it('serves a caller queued behind a reservation whose creation failed', async () => {
    const { pool, browser } = makePool(1);
    await pool.initialize();
    const warm = await pool.acquire();
    asFake(warm).clearCookies.mockRejectedValueOnce(new Error('dead'));
    pool.release(warm);
    await vi.waitFor(() => expect(pool.stats().total).toBe(0));

    browser().createDelayMs = 30;
    browser().failNext = 1;
    const first = pool.acquire(); // reserves the only slot, then fails
    const second = pool.acquire(2_000); // queued behind the reservation
    expect(pool.stats()).toMatchObject({ creating: 1, waiting: 1 });
    await expect(first).rejects.toThrow('newContext failed');
    const t0 = Date.now();
    await expect(second).resolves.toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(pool.stats()).toMatchObject({ total: 1, inUse: 1, creating: 0, waiting: 0 });
  });
});

describe('BrowserPool lifecycle', () => {
  it('shutdown rejects waiters, refuses new callers and closes everything', async () => {
    const { pool, browser } = makePool(1);
    await pool.initialize();
    const ctx = await pool.acquire();
    const waiter = pool.acquire();
    await pool.shutdown();
    await expect(waiter).rejects.toMatchObject({ reason: 'closed' });
    await expect(pool.acquire()).rejects.toMatchObject({ reason: 'closed' });
    expect(asFake(ctx).closed).toBe(true);
    expect(browser().close).toHaveBeenCalled();
    pool.release(ctx); // harmless after shutdown
  });

  it('relaunches Chromium after it disconnects', async () => {
    const { pool, launch, browsers, logger } = makePool(2);
    await pool.initialize();
    const inUse = await pool.acquire();
    browsers[0].crash();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('disconnected'));

    const fresh = await pool.acquire();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(browsers[1].created.map((c) => c.id)).toContain(asFake(fresh).id);

    // The dead browser's context leaves the pool when it comes back.
    pool.release(inUse);
    await tick();
    expect(asFake(inUse).closed).toBe(true);
    expect(pool.stats()).toMatchObject({ total: 1, inUse: 1 });
  });

  it('shares one launch between concurrent callers after a crash', async () => {
    const { pool, launch, browsers } = makePool(3);
    await pool.initialize();
    const held = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
    browsers[0].crash();
    for (const c of held) pool.release(c);
    await tick();
    await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
    expect(launch).toHaveBeenCalledTimes(2);
  });
});

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || findChromium() || undefined;

describe.skipIf(!chromiumPath)('BrowserPool with a real Chromium', () => {
  it('launches the binary named by PLAYWRIGHT_CHROMIUM_EXECUTABLE (worker.ts constructor)', async () => {
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE = chromiumPath!;
    const pool = new BrowserPool(1, 100, 30 * 60 * 1000);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await pool.initialize();
      const ctx = await pool.acquire();
      const page = await ctx.newPage();
      await page.setContent('<p>hello from the pool</p>');
      expect(await page.textContent('p')).toBe('hello from the pool');
      await page.close();
      pool.release(ctx);
    } finally {
      await pool.shutdown();
      log.mockRestore();
    }
  }, 30_000);
});
