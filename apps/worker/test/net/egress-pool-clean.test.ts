// BrowserPool cleaning between fetches (finding pool-storage-leak-across-fetches),
// with fake contexts: which origins are cleared, and that a context that
// cannot be cleaned is replaced rather than handed out again.

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext } from 'patchright';
import { BrowserPool } from '../../src/browser/pool.js';

class FakePage {
  closed = false;
  failClose = false;
  close = vi.fn(async () => {
    if (this.failClose) throw new Error('page close failed');
    this.closed = true;
  });
}

class FakeContext extends EventEmitter {
  closed = false;
  open: FakePage[] = [];
  cleared: string[][] = [];
  failClear = false;
  serviceWorkers = () => [];
  clearCookies = vi.fn(async () => {});
  pages = () => this.open.filter((p) => !p.closed);
  newPage = vi.fn(async () => {
    const page = new FakePage();
    this.open.push(page);
    return page;
  });
  newCDPSession = vi.fn(async () => {
    const batch: string[] = [];
    this.cleared.push(batch);
    return {
      send: vi.fn(async (method: string, params: { origin: string; storageTypes: string }) => {
        if (this.failClear) throw new Error('Storage.clearDataForOrigin failed');
        expect(method).toBe('Storage.clearDataForOrigin');
        expect(params.storageTypes).toBe('all');
        batch.push(params.origin);
      }),
      detach: vi.fn(async () => {}),
    };
  });
  close = vi.fn(async () => {
    this.closed = true;
  });
  request(url: string) {
    this.emit('request', { url: () => url });
  }
}

function makePool() {
  const contexts: FakeContext[] = [];
  const browser = Object.assign(new EventEmitter(), {
    isConnected: () => true,
    close: async () => {},
    newContext: async () => {
      const c = new FakeContext();
      contexts.push(c);
      return c;
    },
  });
  const pool = new BrowserPool(1, 100, 60_000, {
    launch: async () => browser as unknown as Browser,
    egressProxy: async () => 'http://127.0.0.1:9',
    logger: { log() {}, warn() {} },
    acquireTimeoutMs: 2_000,
  });
  return { pool, contexts };
}

const fake = (c: BrowserContext) => c as unknown as FakeContext;

describe('BrowserPool cleaning between fetches', () => {
  it('clears the storage of every origin the fetch requested, then reuses the context', async () => {
    const { pool } = makePool();
    const ctx = await pool.acquire();
    fake(ctx).request('https://shop.example/page');
    fake(ctx).request('https://shop.example/app.js');
    fake(ctx).request('https://cdn.example:8443/x.png');
    fake(ctx).request('http://widget.example/frame');
    fake(ctx).request('data:text/plain,hi'); // no storage of its own
    fake(ctx).request('blob:https://shop.example/1234'); // the creator's origin, seen already
    pool.release(ctx);

    const again = await pool.acquire();
    expect(again).toBe(ctx);
    expect(fake(ctx).cleared).toEqual([['https://shop.example', 'https://cdn.example:8443', 'http://widget.example']]);
    expect(fake(ctx).clearCookies).toHaveBeenCalledTimes(1);
    // The page used to send the CDP commands is closed again.
    expect(fake(ctx).pages()).toEqual([]);

    // Nothing requested since: nothing more to clear.
    pool.release(again);
    await pool.acquire();
    expect(fake(ctx).cleared).toHaveLength(1);
    expect(fake(ctx).newPage).toHaveBeenCalledTimes(1);
  });

  it('closes pages a fetch left open before cleaning', async () => {
    const { pool } = makePool();
    const ctx = await pool.acquire();
    const popup = await fake(ctx).newPage();
    fake(ctx).request('https://shop.example/');
    pool.release(ctx);
    expect(await pool.acquire()).toBe(ctx);
    expect(popup.closed).toBe(true);
  });

  it.each([
    ['the storage cannot be cleared', (c: FakeContext) => (c.failClear = true)],
    ['a leftover page cannot be closed', (c: FakeContext) => void c.newPage().then((p) => (p.failClose = true))],
  ])('replaces a context when %s', async (_label, sabotage) => {
    const { pool, contexts } = makePool();
    const ctx = await pool.acquire();
    fake(ctx).request('https://shop.example/');
    sabotage(fake(ctx));
    await new Promise((r) => setTimeout(r, 0));
    pool.release(ctx);
    const next = await pool.acquire();
    expect(next).not.toBe(ctx);
    expect(fake(ctx).closed).toBe(true);
    expect(contexts).toHaveLength(2);
  });

  it('replaces a context that reached more origins than it can clear one by one', async () => {
    const { pool } = makePool();
    const ctx = await pool.acquire();
    for (let i = 0; i < 201; i++) fake(ctx).request(`https://site${i}.example/`);
    pool.release(ctx);
    const next = await pool.acquire();
    expect(next).not.toBe(ctx);
    expect(fake(ctx).closed).toBe(true);
    expect(fake(ctx).newCDPSession).not.toHaveBeenCalled();
  });
});

describe('BrowserPool launch', () => {
  it('points Chromium at the egress proxy, loopback included, and keeps WebRTC from bypassing it', async () => {
    const launch = vi.fn(async () => {
      return Object.assign(new EventEmitter(), {
        isConnected: () => true,
        close: async () => {},
        newContext: async () => new FakeContext(),
      }) as unknown as Browser;
    });
    const pool = new BrowserPool(1, 100, 60_000, {
      launch,
      egressProxy: async () => 'http://127.0.0.1:4567',
      logger: { log() {}, warn() {} },
    });
    await pool.initialize();
    const args = (launch.mock.calls[0] as unknown as [{ args: string[] }])[0].args;
    expect(args).toEqual(
      expect.arrayContaining([
        '--proxy-server=http://127.0.0.1:4567',
        '--proxy-bypass-list=<-loopback>',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ]),
    );
    await pool.shutdown();
  });

  it('does not launch Chromium unguarded when the egress proxy cannot start', async () => {
    const launch = vi.fn();
    const pool = new BrowserPool(1, 100, 60_000, {
      launch,
      egressProxy: async () => {
        throw new Error('EADDRINUSE');
      },
      logger: { log() {}, warn() {} },
    });
    await expect(pool.initialize()).rejects.toThrow('EADDRINUSE');
    expect(launch).not.toHaveBeenCalled();
  });
});
