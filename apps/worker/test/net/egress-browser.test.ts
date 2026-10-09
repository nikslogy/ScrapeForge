// The pooled Chromium connects through the egress guard, so what the route
// guard cannot see (redirect hops, WebSockets, popups, workers) is refused
// when the connection is made instead of being detected after it was sent
// (finding browser-ws-redirect-detect-only). Real Chromium; skipped when
// none is installed. Test policy: 127.0.0.1 "public", 127.0.0.2 "internal".

import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'patchright';
import { OutboundBlockedError, setOutboundPolicyForTests } from '@scrapeforge/shared';
import { BrowserPool } from '../../src/browser/pool.js';
import { monitorOutbound } from '../../src/browser/outbound-guard.js';
import { tier4Fetch } from '../../src/engine/tier4-browser.js';
import { egressGuard } from '../../src/net/egress.js';
import { findChromium } from '../../../../tests/latency/lib/chromium-path.js';
import { INTERNAL_IP, PUBLIC_IP, html, redirect, routes, startServer, useFixturePolicy, type FixtureServer } from './fixtures.js';

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || findChromium() || undefined;

/** Records WebSocket handshakes (and answers them, so a connection that gets through stays open). */
async function startWsServer(host: string) {
  const handshakes: string[] = [];
  const upgraded = new Set<Duplex>();
  const server = http.createServer((_req, res) => res.writeHead(426).end());
  server.on('upgrade', (req, socket: Duplex) => {
    handshakes.push(req.url ?? '');
    upgraded.add(socket);
    socket.on('end', () => socket.end());
    socket.on('error', () => {});
    socket.on('close', () => upgraded.delete(socket));
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise<void>((r) => server.listen(0, host, r));
  return {
    port: (server.address() as AddressInfo).port,
    handshakes,
    close: () =>
      new Promise<void>((r) => {
        for (const s of upgraded) s.destroy();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

describe.skipIf(!chromiumPath)('pooled Chromium behind the egress guard', () => {
  let site: FixtureServer;
  let internal: FixtureServer;
  let wsInternal: Awaited<ReturnType<typeof startWsServer>>;
  let wsPublic: Awaited<ReturnType<typeof startWsServer>>;
  let pool: BrowserPool;

  beforeAll(async () => {
    internal = await startServer(INTERNAL_IP, html('<p>INTERNAL SECRET</p>'));
    wsInternal = await startWsServer(INTERNAL_IP);
    wsPublic = await startWsServer(PUBLIC_IP);
    const inside = (path: string) => `${internal.origin}${path}`;
    site = await startServer(
      PUBLIC_IP,
      routes({
        '/plain': html('<html><body><p>PLAIN PAGE</p></body></html>'),
        '/bounce': redirect(302, inside('/pixel.png')),
        '/subresource-redirect': html('<html><body><p>HAS BOUNCING IMAGE</p><img src="/bounce"></body></html>'),
        '/navigate-redirect': redirect(302, inside('/landing')),
        '/websocket': html(`<html><body><p>SOCKET</p>
          <script>try { new WebSocket('ws://${INTERNAL_IP}:${wsInternal.port}/page-ws'); } catch (e) {}</script>
          </body></html>`),
        '/websocket-public': html(`<html><body><p>PUBLIC SOCKET</p><script>
          const ws = new WebSocket('ws://${PUBLIC_IP}:${wsPublic.port}/public-ws');
          ws.onopen = () => (document.body.dataset.ws = 'open');
          </script></body></html>`),
        '/worker-fetch': html(`<html><body><p>WORKER</p><script>
          const src = 'fetch(${JSON.stringify(inside('/from-worker'))}).catch(() => {});';
          new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
          </script></body></html>`),
      }),
    );
    pool = new BrowserPool(1, 100, 30 * 60 * 1000, { executablePath: chromiumPath, logger: { log() {}, warn() {} } });
  }, 30_000);

  afterAll(async () => {
    await pool?.shutdown();
    await Promise.all([site?.close(), internal?.close(), wsInternal?.close(), wsPublic?.close()]);
  });

  beforeEach(() => {
    useFixturePolicy();
    site.requests.length = 0;
    internal.requests.length = 0;
    wsInternal.handshakes.length = 0;
    wsPublic.handshakes.length = 0;
  });

  afterEach(() => setOutboundPolicyForTests(null));

  async function withContext<T>(fn: (ctx: BrowserContext) => Promise<T>): Promise<T> {
    const ctx = await pool.acquire();
    try {
      return await fn(ctx);
    } finally {
      pool.release(ctx);
    }
  }

  it('loads public pages through the guard', async () => {
    const guard = await egressGuard();
    const before = guard.stats().requests;
    const r = await withContext((ctx) => tier4Fetch(`${site.origin}/plain`, ctx));
    expect(r.statusCode).toBe(200);
    expect(r.html).toContain('PLAIN PAGE');
    expect(guard.stats().requests).toBeGreaterThan(before);
  });

  it('never sends a sub-resource redirect hop to an internal address', async () => {
    await expect(withContext((ctx) => tier4Fetch(`${site.origin}/subresource-redirect`, ctx))).rejects.toBeInstanceOf(
      OutboundBlockedError,
    );
    expect(site.requests.map((r) => r.url)).toContain('/bounce');
    expect(internal.requests).toEqual([]);
  });

  it('never sends a navigation redirect hop to an internal address', async () => {
    await expect(withContext((ctx) => tier4Fetch(`${site.origin}/navigate-redirect`, ctx))).rejects.toBeInstanceOf(
      OutboundBlockedError,
    );
    expect(internal.requests).toEqual([]);
  });

  it('never sends a WebSocket handshake to an internal address', async () => {
    const guard = await egressGuard();
    const refused = guard.stats().refused;
    // The tunnel is refused before any handshake, so Chromium reports no
    // WebSocket for the monitor to flag: the page simply could not connect.
    const r = await withContext((ctx) => tier4Fetch(`${site.origin}/websocket`, ctx));
    expect(r.html).toContain('SOCKET');
    await new Promise((resolve) => setTimeout(resolve, 200)); // a handshake that got through would be here by now
    expect(wsInternal.handshakes).toEqual([]);
    expect(guard.stats().refused).toBeGreaterThan(refused);
  });

  it('lets a WebSocket to a public address through (tunnelled by the guard)', async () => {
    const guard = await egressGuard();
    const tunnels = guard.stats().tunnels;
    const r = await withContext((ctx) => tier4Fetch(`${site.origin}/websocket-public`, ctx));
    expect(r.html).toContain('PUBLIC SOCKET');
    expect(wsPublic.handshakes).toEqual(['/public-ws']);
    expect(guard.stats().tunnels).toBeGreaterThan(tunnels);
  });

  it('never lets a worker reach an internal address', async () => {
    await withContext((ctx) => tier4Fetch(`${site.origin}/worker-fetch`, ctx)).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    expect(internal.requests).toEqual([]);
  });
});

// The monitor itself (layer 2, kept as defence in depth): WebSockets of every
// page in the context count, popups included. Plain Chromium, no guard.
describe.skipIf(!chromiumPath)('monitorOutbound with popups', () => {
  let browser: Browser;
  let site: FixtureServer;
  let wsInternal: Awaited<ReturnType<typeof startWsServer>>;

  beforeAll(async () => {
    wsInternal = await startWsServer(INTERNAL_IP);
    site = await startServer(
      PUBLIC_IP,
      routes({
        // A user gesture opens it: script-opened popups are blocked.
        '/opener': html(`<html><body><p>OPENER</p><a id="go" href="/popup-ws" target="_blank">open</a></body></html>`),
        '/popup-ws': html(`<html><body><p>POPUP</p>
          <script>try { new WebSocket('ws://${INTERNAL_IP}:${wsInternal.port}/popup-ws'); } catch (e) {}</script>
          </body></html>`),
      }),
    );
    browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-sandbox'] });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await Promise.all([site?.close(), wsInternal?.close()]);
  });

  beforeEach(() => useFixturePolicy());
  afterEach(() => setOutboundPolicyForTests(null));

  it('reports a WebSocket opened by a popup of the page', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const monitor = monitorOutbound(page);
      await page.goto(`${site.origin}/opener`);
      const popup = context.waitForEvent('page', { timeout: 5_000 });
      await page.click('#go');
      await popup;
      await vi.waitFor(() => expect(wsInternal.handshakes).toEqual(['/popup-ws']), { timeout: 5_000 });
      // Playwright reports the socket a little after the handshake has left.
      await vi.waitFor(() => expect(monitor.assertClean()).rejects.toBeInstanceOf(OutboundBlockedError), {
        timeout: 5_000,
      });
      monitor.dispose();
    } finally {
      await context.close();
    }
  });
});
