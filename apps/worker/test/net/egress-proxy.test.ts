// EgressProxy (apps/worker/src/net/egress-proxy.ts) against local servers.
// Test policy (fixtures.ts): 127.0.0.1 is "public", 127.0.0.2 "internal".

import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertPublicUrl, isOutboundBlockedError, setOutboundPolicyForTests } from '@scrapeforge/shared';
import { EgressProxy, parseAuthority } from '../../src/net/egress-proxy.js';
import { closeEgressGuard, egressGuard, egressProxyUrl } from '../../src/net/egress.js';
import { INTERNAL_IP, PUBLIC_IP, html, routes, startServer, useFixturePolicy, type FixtureServer } from './fixtures.js';

interface RawReply {
  status: number;
  head: string;
  socket: net.Socket;
  /** Bytes received after the response head. */
  rest: Buffer;
}

/** Send `text` to the proxy on a fresh connection and read one response head. */
function raw(port: number, text: string): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      const head = buf.subarray(0, end).toString('latin1');
      resolve({ status: Number(head.split(' ')[1]), head, socket, rest: buf.subarray(end + 4) });
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => reject(new Error(`closed before a response (${buf.length} bytes)`)));
    socket.write(text);
  });
}

/** Read from `socket` until `predicate(all bytes so far)` holds. */
function readUntil(socket: net.Socket, initial: Buffer, predicate: (s: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = initial;
    if (predicate(buf.toString('latin1'))) return resolve(buf.toString('latin1'));
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (predicate(buf.toString('latin1'))) {
        socket.off('data', onData);
        resolve(buf.toString('latin1'));
      }
    };
    socket.on('data', onData);
    socket.once('close', () => reject(new Error(`closed: ${buf.toString('latin1').slice(0, 200)}`)));
  });
}

function closed(socket: net.Socket): Promise<void> {
  return socket.destroyed ? Promise.resolve() : new Promise((r) => socket.once('close', () => r()));
}

/** Minimal WebSocket endpoint: answers the handshake, then echoes raw bytes. */
async function startWsServer(host: string) {
  const handshakes: http.IncomingHttpHeaders[] = [];
  const upgraded = new Set<Duplex>();
  const server = http.createServer((_req, res) => res.writeHead(426).end());
  server.on('upgrade', (req, socket: Duplex) => {
    handshakes.push(req.headers);
    // Upgraded sockets are half-open and untracked by closeAllConnections.
    upgraded.add(socket);
    socket.on('end', () => socket.end());
    socket.on('close', () => upgraded.delete(socket));
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on('data', (d) => socket.write(d));
    socket.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, host, r));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    handshakes,
    close: () =>
      new Promise<void>((r) => {
        for (const socket of upgraded) socket.destroy();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const WS_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const upgradeRequest = (host: string, port: number, extra = '') =>
  `GET http://${host}:${port}/socket HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
  `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${WS_KEY}\r\n${extra}\r\n`;

const DNS: Record<string, string[]> = {
  'public.test': [PUBLIC_IP],
  'internal.test': [INTERNAL_IP],
  'mixed.test': [PUBLIC_IP, '169.254.169.254'],
};
const lookup = async (host: string) => {
  const answers = DNS[host.replace(/\.$/, '')];
  if (!answers) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return [...answers];
};

let site: FixtureServer;
let internal: FixtureServer;
let ws: Awaited<ReturnType<typeof startWsServer>>;
let wsInternal: Awaited<ReturnType<typeof startWsServer>>;
let proxy: EgressProxy;
let port: number;
const logger = { warn: vi.fn() };
const savedEnv = { ...process.env };

beforeAll(async () => {
  site = await startServer(
    PUBLIC_IP,
    routes({
      '/page': html('<p>PUBLIC</p>'),
      '/echo-headers': (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes', 'set-cookie': ['a=1', 'b=2'] });
        res.end(JSON.stringify(req.headers));
      },
      '/post': (_req, res, body) => html(`got:${body}`)(_req, res, body),
    }),
  );
  internal = await startServer(INTERNAL_IP, html('<p>INTERNAL SECRET</p>'));
  ws = await startWsServer(PUBLIC_IP);
  wsInternal = await startWsServer(INTERNAL_IP);
  proxy = new EgressProxy({ logger });
  const url = await proxy.listen();
  port = Number(new URL(url).port);
});

afterAll(async () => {
  await proxy?.close();
  await Promise.all([site?.close(), internal?.close(), ws?.close(), wsInternal?.close()]);
});

beforeEach(() => {
  delete process.env.SCRAPEFORGE_ALLOW_PRIVATE_NETWORK;
  useFixturePolicy(lookup);
  site.requests.length = 0;
  internal.requests.length = 0;
  ws.handshakes.length = 0;
  wsInternal.handshakes.length = 0;
  logger.warn.mockClear();
});

afterEach(() => {
  process.env = { ...savedEnv };
  setOutboundPolicyForTests(null);
});

describe('EgressProxy CONNECT', () => {
  it('opens a tunnel to a public destination', async () => {
    const reply = await raw(port, `CONNECT public.test:${site.port} HTTP/1.1\r\nHost: public.test:${site.port}\r\n\r\n`);
    expect(reply.status).toBe(200);
    reply.socket.write(`GET /page HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`);
    const body = await readUntil(reply.socket, reply.rest, (s) => s.includes('PUBLIC'));
    expect(body).toMatch(/^HTTP\/1.1 200/);
    expect(site.requests.map((r) => r.url)).toEqual(['/page']);
    reply.socket.destroy();
  });

  it.each([
    ['a name resolving to a blocked address', `internal.test:${0}`],
    ['a name with any blocked answer', 'mixed.test:0'],
    ['a blocked IP literal', `${INTERNAL_IP}:0`],
    ['a legacy IPv4 spelling', '0x7f.0.0.2:0'],
    ['an internal hostname', 'localhost:0'],
  ])('refuses %s with 403 and connects nowhere', async (_label, authority) => {
    const target = authority.replace(/:0$/, `:${internal.port}`);
    const reply = await raw(port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    expect(reply.status).toBe(403);
    expect(reply.head.toLowerCase()).toContain('x-scrapeforge-egress: refused');
    await closed(reply.socket);
    expect(internal.requests).toEqual([]);
  });

  it('re-resolves at connect time: a name that rebinds after the pre-check is refused', async () => {
    let n = 0;
    useFixturePolicy(async () => (n++ === 0 ? [PUBLIC_IP] : [INTERNAL_IP]));
    await assertPublicUrl(`https://rebind.test:${internal.port}/`); // passes and caches "public"
    const reply = await raw(port, `CONNECT rebind.test:${internal.port} HTTP/1.1\r\n\r\n`);
    expect(reply.status).toBe(403);
    expect(n).toBe(2);
    expect(internal.requests).toEqual([]);
    expect(isOutboundBlockedError(proxy.recentRefusal('rebind.test', internal.port))).toBe(true);
    expect(proxy.recentRefusal('rebind.test', internal.port + 1)).toBeUndefined();
  });

  it('answers 502 for an unresolvable name and 400 for a malformed target', async () => {
    expect((await raw(port, 'CONNECT nowhere.test:443 HTTP/1.1\r\n\r\n')).status).toBe(502);
    for (const target of ['public.test', 'public.test:0', 'public.test:70000', 'a b:443', 'user@public.test:443']) {
      expect((await raw(port, `CONNECT ${target} HTTP/1.1\r\n\r\n`)).status, target).toBe(400);
    }
  });

  it('never connects to itself, even when private destinations are allowed', async () => {
    process.env.SCRAPEFORGE_ALLOW_PRIVATE_NETWORK = '1';
    const reply = await raw(port, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`);
    expect(reply.status).toBe(403);
    // The dev override itself works: an "internal" destination is reachable.
    const ok = await raw(port, `CONNECT ${INTERNAL_IP}:${internal.port} HTTP/1.1\r\n\r\n`);
    expect(ok.status).toBe(200);
    ok.socket.destroy();
  });

  it('logs refusals by host and port only, never credentials or paths', async () => {
    // A fresh proxy: refusals are logged once per destination per minute.
    const fresh = new EgressProxy({ logger });
    const port = Number(new URL(await fresh.listen()).port);
    await raw(
      port,
      `CONNECT internal.test:${internal.port} HTTP/1.1\r\nProxy-Authorization: Basic c2VjcmV0OnB3\r\n\r\n`,
    );
    await raw(port, `GET http://user:hunter2@internal.test:${internal.port + 1}/private/path?token=abc HTTP/1.1\r\n\r\n`);
    const logged = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logged).toContain(`internal.test:${internal.port}`);
    expect(logged).not.toMatch(/c2VjcmV0|hunter2|private\/path|token=abc|127\.0\.0\.2/);
    await fresh.close();
  });
});

describe('EgressProxy plain HTTP (absolute form)', () => {
  it('forwards to a public destination without proxy or hop-by-hop headers', async () => {
    const reply = await raw(
      port,
      `GET http://public.test:${site.port}/echo-headers HTTP/1.1\r\nHost: public.test:${site.port}\r\n` +
        'Proxy-Authorization: Basic c2VjcmV0\r\nProxy-Connection: keep-alive\r\nConnection: close, X-Hop\r\n' +
        'X-Hop: 1\r\nX-Kept: 2\r\n\r\n',
    );
    expect(reply.status).toBe(200);
    expect(reply.head).toMatch(/x-upstream: yes/i);
    expect(reply.head.match(/set-cookie/gi)).toHaveLength(2);
    // Chunked: read to the last chunk.
    const body = await readUntil(reply.socket, reply.rest, (s) => s.endsWith('\r\n0\r\n\r\n'));
    const seen = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
    expect(seen).toMatchObject({ host: `public.test:${site.port}`, 'x-kept': '2' });
    expect(seen).not.toHaveProperty('proxy-authorization');
    expect(seen).not.toHaveProperty('proxy-connection');
    expect(seen).not.toHaveProperty('x-hop');
    reply.socket.destroy();
  });

  it('forwards request bodies', async () => {
    const reply = await raw(
      port,
      `POST http://public.test:${site.port}/post HTTP/1.1\r\nHost: public.test:${site.port}\r\nContent-Length: 5\r\n\r\nhello`,
    );
    expect(reply.status).toBe(200);
    expect(await readUntil(reply.socket, reply.rest, (s) => s.includes('got:hello'))).toContain('got:hello');
    reply.socket.destroy();
  });

  it('refuses a blocked destination with 403 and sends nothing', async () => {
    for (const host of ['internal.test', INTERNAL_IP, 'mixed.test']) {
      const reply = await raw(port, `GET http://${host}:${internal.port}/secret HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
      expect(reply.status, host).toBe(403);
      expect(reply.head.toLowerCase()).toContain('x-scrapeforge-egress: refused');
      reply.socket.destroy();
    }
    expect(internal.requests).toEqual([]);
  });

  it('rejects origin-form and non-http requests', async () => {
    expect((await raw(port, 'GET /page HTTP/1.1\r\nHost: public.test\r\n\r\n')).status).toBe(400);
    expect((await raw(port, 'GET ftp://public.test/x HTTP/1.1\r\n\r\n')).status).toBe(400);
  });
});

describe('EgressProxy WebSocket upgrade (absolute form)', () => {
  it('relays the handshake and frames to a public destination', async () => {
    const reply = await raw(port, upgradeRequest('public.test', ws.port, 'Proxy-Authorization: Basic eA==\r\n'));
    expect(reply.status).toBe(101);
    expect(ws.handshakes).toHaveLength(1);
    expect(ws.handshakes[0]).not.toHaveProperty('proxy-authorization');
    expect(ws.handshakes[0]).toMatchObject({ upgrade: 'websocket', 'sec-websocket-key': WS_KEY });
    reply.socket.write('ping-bytes');
    expect(await readUntil(reply.socket, reply.rest, (s) => s.includes('ping-bytes'))).toContain('ping-bytes');
    reply.socket.destroy();
  });

  it('refuses an upgrade to a blocked destination and sends no handshake', async () => {
    const reply = await raw(port, upgradeRequest('internal.test', wsInternal.port));
    expect(reply.status).toBe(403);
    const literal = await raw(port, upgradeRequest(INTERNAL_IP, wsInternal.port));
    expect(literal.status).toBe(403);
    expect(wsInternal.handshakes).toEqual([]);
  });

  it('refuses a WebSocket tunnel (CONNECT, as Chromium sends it) to a blocked destination', async () => {
    const reply = await raw(port, `CONNECT internal.test:${wsInternal.port} HTTP/1.1\r\n\r\n`);
    expect(reply.status).toBe(403);
    expect(wsInternal.handshakes).toEqual([]);
  });
});

describe('EgressProxy limits', () => {
  it('closes an idle tunnel', async () => {
    const short = new EgressProxy({ idleTimeoutMs: 200, logger });
    const p = Number(new URL(await short.listen()).port);
    try {
      const reply = await raw(p, `CONNECT public.test:${site.port} HTTP/1.1\r\n\r\n`);
      expect(reply.status).toBe(200);
      const t0 = performance.now();
      await closed(reply.socket);
      expect(performance.now() - t0).toBeLessThan(2_000);
      expect(short.stats()).toMatchObject({ tunnels: 1 });
    } finally {
      await short.close();
    }
  });

  it('gives up on a destination that does not answer the connect', async () => {
    // 10.255.255.1 is unroutable: the SYN goes nowhere (some networks refuse at once).
    const slow = new EgressProxy({ connectTimeoutMs: 300, resolve: async () => ['10.255.255.1'], logger });
    const p = Number(new URL(await slow.listen()).port);
    try {
      const t0 = performance.now();
      const reply = await raw(p, 'CONNECT unroutable.test:81 HTTP/1.1\r\n\r\n');
      const elapsed = performance.now() - t0;
      expect([502, 504]).toContain(reply.status);
      if (elapsed >= 250) expect(reply.status).toBe(504);
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      await slow.close();
    }
  });

  it('caps concurrent client connections', async () => {
    const capped = new EgressProxy({ maxConnections: 2, logger });
    const p = Number(new URL(await capped.listen()).port);
    try {
      const a = await raw(p, `CONNECT public.test:${site.port} HTTP/1.1\r\n\r\n`);
      const b = await raw(p, `CONNECT public.test:${site.port} HTTP/1.1\r\n\r\n`);
      expect([a.status, b.status]).toEqual([200, 200]);
      await expect(raw(p, `CONNECT public.test:${site.port} HTTP/1.1\r\n\r\n`)).rejects.toThrow(/closed|ECONNRESET/);
      expect(capped.stats()).toMatchObject({ active: 2, dropped: 1 });
      a.socket.destroy();
      await closed(a.socket);
      await vi.waitFor(() => expect(capped.stats().active).toBe(1));
      const c = await raw(p, `CONNECT public.test:${site.port} HTTP/1.1\r\n\r\n`);
      expect(c.status).toBe(200);
      b.socket.destroy();
      c.socket.destroy();
    } finally {
      await capped.close();
    }
  });

  it('close() ends open tunnels', async () => {
    const temp = new EgressProxy({ logger });
    const p = Number(new URL(await temp.listen()).port);
    const reply = await raw(p, `CONNECT public.test:${site.port} HTTP/1.1\r\n\r\n`);
    expect(reply.status).toBe(200);
    await temp.close();
    await closed(reply.socket);
  });
});

describe('parseAuthority', () => {
  it('normalizes hosts like a URL and validates the port', () => {
    expect(parseAuthority('Example.COM:443')).toEqual({ host: 'example.com', port: 443 });
    expect(parseAuthority('[::1]:8443')).toEqual({ host: '::1', port: 8443 });
    expect(parseAuthority('0x7f.1:80')).toEqual({ host: '127.0.0.1', port: 80 });
    for (const bad of ['example.com', ':443', 'example.com:0', 'example.com:65536', 'a/b:1', '[::1:80', 'x:y']) {
      expect(parseAuthority(bad), bad).toBeNull();
    }
  });
});

describe('process egress guard', () => {
  it('starts once on first use, is shared, and starts afresh after close', async () => {
    const [a, b] = await Promise.all([egressGuard(), egressGuard()]);
    expect(a).toBe(b);
    expect(await egressProxyUrl()).toBe(a.url);
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await closeEgressGuard();
    const c = await egressGuard();
    expect(c).not.toBe(a);
    await closeEgressGuard();
  });
});
