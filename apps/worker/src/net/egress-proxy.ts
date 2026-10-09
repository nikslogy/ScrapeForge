// Local egress guard: an HTTP proxy on 127.0.0.1 that enforces the outbound
// policy (packages/shared/src/net.ts) when a connection is made.
//
// The pre-request checks (assertPublicUrl, the browser route guard) resolve a
// name and judge the answer, but the client then resolves it again to
// connect, and a hostile DNS server can answer differently the second time
// (DNS rebinding). Redirect hops and WebSockets in Chromium never reach a
// route handler at all. Clients that connect through this proxy cannot get
// around the policy: for every tunnel or request it resolves the target
// itself (resolveForConnect: no cache, every answer must be public) and
// connects to exactly those addresses. The name is never resolved again.
//
// It speaks the three forms clients use through an HTTP proxy:
//   - CONNECT host:port         HTTPS, and WebSockets (Chromium tunnels ws:// too)
//   - GET http://host/path      plain HTTP in absolute form
//   - GET http://host/path + Upgrade   a plain-HTTP WebSocket handshake
// A refused destination gets 403 with `X-ScrapeForge-Egress: refused`; a DNS
// or connect failure 502, a connect timeout 504.
//
// Bound to loopback only, without authentication: only processes on this
// host can use it, and it reaches nothing they could not reach directly. It
// refuses to connect to itself. Logs name the destination host and port,
// never headers, paths or credentials.

import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import {
  isBlockedAddress,
  isOutboundBlockedError,
  OutboundBlockedError,
  resolveForConnect,
} from '@scrapeforge/shared';

export interface EgressProxyOptions {
  /** TCP connect timeout per destination (default 10 s). */
  connectTimeoutMs?: number;
  /** Close a tunnel or upstream connection with no traffic for this long (default 60 s). */
  idleTimeoutMs?: number;
  /** Client connections served at once; more are dropped (default 512). */
  maxConnections?: number;
  /** Destination check; the default applies the shared outbound policy. */
  resolve?: (host: string, signal: AbortSignal) => Promise<string[]>;
  logger?: Pick<Console, 'warn'>;
}

export interface EgressStats {
  /** Client connections open now. */
  active: number;
  tunnels: number;
  requests: number;
  upgrades: number;
  /** Destinations refused by the policy. */
  refused: number;
  /** DNS or connect failures. */
  failed: number;
  /** Client connections dropped over maxConnections. */
  dropped: number;
}

interface Target {
  /** Hostname or IP literal, lower case, no IPv6 brackets. */
  host: string;
  port: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONNECTIONS = 512;
// Refusals are remembered briefly so a client's connect error can be
// reported as the policy decision it was (see recentRefusal).
const REFUSAL_TTL_MS = 60_000;
const MAX_REFUSALS = 1_024;

/** Response header (value `refused`) on the guard's own refusals. */
export const EGRESS_REFUSED_HEADER = 'x-scrapeforge-egress';

// Never forwarded: connection-level headers (RFC 9110 §7.6.1) and anything
// meant for this proxy.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  502: 'Bad Gateway',
  504: 'Gateway Timeout',
};

class ConnectTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
}

export class EgressProxy {
  private readonly server: http.Server;
  private readonly agent: http.Agent;
  /** Client connections, and upstream sockets this proxy opened. */
  private readonly clients = new Set<net.Socket>();
  private readonly upstreams = new Set<net.Socket>();
  private readonly refusals = new Map<string, { error: OutboundBlockedError; expiresAt: number }>();
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly resolve: (host: string, signal: AbortSignal) => Promise<string[]>;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly counters = { tunnels: 0, requests: 0, upgrades: 0, refused: 0, failed: 0, dropped: 0 };
  private port = 0;

  constructor(options: EgressProxyOptions = {}) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.resolve = options.resolve ?? ((host, signal) => resolveForConnect(host, { signal }));
    this.logger = options.logger ?? console;
    // Pooled upstream sockets stay bound to the address that was checked
    // when they connected.
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 64, maxTotalSockets: 256, timeout: this.idleTimeoutMs });

    this.server = http.createServer({ requireHostHeader: false }, (req, res) => this.onRequest(req, res));
    this.server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.server.headersTimeout = 15_000;
    this.server.requestTimeout = 120_000;
    this.server.on('connect', (req: http.IncomingMessage, socket: Duplex, head: Buffer) =>
      this.onConnect(req, socket as net.Socket, head),
    );
    this.server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) =>
      this.onUpgrade(req, socket as net.Socket, head),
    );
    this.server.on('connection', (socket: net.Socket) => track(this.clients, socket));
    this.server.on('drop', () => this.counters.dropped++);
    this.server.on('clientError', (_err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
    });
  }

  /** Start listening on an ephemeral loopback port; resolves to the proxy URL. */
  async listen(): Promise<string> {
    if (this.port) return this.url;
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.port = (this.server.address() as net.AddressInfo).port;
    // A worker shuts down when its queue does; the guard must not hold it up.
    this.server.unref();
    return this.url;
  }

  /** http://127.0.0.1:<port>, once listening. */
  get url(): string {
    if (!this.port) throw new Error('egress proxy is not listening');
    return `http://127.0.0.1:${this.port}`;
  }

  stats(): EgressStats {
    return { active: this.clients.size, ...this.counters };
  }

  /**
   * The policy refusal for `host:port` in the last minute, if any. Clients
   * see a refused tunnel as a generic connect error; this tells the caller
   * it was a policy decision.
   */
  recentRefusal(host: string, port: number): OutboundBlockedError | undefined {
    const key = refusalKey(host, port);
    const entry = this.refusals.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.refusals.delete(key);
      return undefined;
    }
    return entry.error;
  }

  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    for (const socket of [...this.clients, ...this.upstreams]) socket.destroy();
    this.agent.destroy();
    if (this.server.listening) await closed;
  }

  // ── protocol handlers ─────────────────────────────────

  private onConnect(req: http.IncomingMessage, client: net.Socket, head: Buffer): void {
    client.on('error', () => client.destroy());
    const target = parseAuthority(req.url ?? '');
    if (!target) return reject(client, 400);
    void this.openTunnel(client, target, head);
  }

  private async openTunnel(client: net.Socket, target: Target, head: Buffer): Promise<void> {
    const upstream = await this.connectFor(client, target, 'CONNECT');
    if (!upstream) return;
    this.counters.tunnels++;
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    this.splice(client, upstream);
  }

  private onUpgrade(req: http.IncomingMessage, client: net.Socket, head: Buffer): void {
    client.on('error', () => client.destroy());
    const url = parseAbsoluteUrl(req.url ?? '', ['http:', 'ws:']);
    if (!url) return reject(client, 400);
    void this.openUpgrade(req, client, head, url);
  }

  private async openUpgrade(req: http.IncomingMessage, client: net.Socket, head: Buffer, url: URL): Promise<void> {
    const upstream = await this.connectFor(client, targetOf(url, 80), 'upgrade');
    if (!upstream) return;
    this.counters.upgrades++;
    // The handshake is replayed in origin form; Connection and Upgrade must
    // reach the server, the proxy's own headers must not.
    const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`];
    const raw = req.rawHeaders;
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const name = raw[i].toLowerCase();
      if (name.startsWith('proxy-') || name === 'keep-alive') continue;
      lines.push(`${raw[i]}: ${raw[i + 1]}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    this.splice(client, upstream);
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = parseAbsoluteUrl(req.url ?? '', ['http:']);
    if (!url) {
      res.writeHead(400, { connection: 'close', 'content-length': '0' }).end();
      return;
    }
    void this.forward(req, res, url);
  }

  private async forward(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const target = targetOf(url, 80);
    const abort = new AbortController();
    const onClose = () => abort.abort(new Error('client closed'));
    res.once('close', onClose);
    let addresses: string[];
    try {
      addresses = await this.admit(target, abort.signal);
    } catch (err) {
      if (abort.signal.aborted) return;
      const status = this.failure(target, 'request', err);
      if (!res.headersSent && !res.destroyed) {
        // A body makes a browser commit a refused navigation hop as an
        // ordinary response (an empty 403 becomes a network error), so the
        // redirect-chain check still names the blocked hop.
        const body = status === 403 ? 'Blocked by egress policy\n' : '';
        res.writeHead(status, {
          connection: 'close',
          'content-type': 'text/plain; charset=utf-8',
          'content-length': String(Buffer.byteLength(body)),
          ...(status === 403 ? { [EGRESS_REFUSED_HEADER]: 'refused' } : {}),
        });
        res.end(body);
      }
      return;
    } finally {
      res.off('close', onClose);
    }
    this.counters.requests++;

    const headers = forwardableHeaders(req.rawHeaders);
    if (!req.headers.host) headers.push('Host', url.host);
    const upstream = http.request({
      host: target.host,
      port: target.port,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
      setHost: false,
      agent: this.agent,
      lookup: pinnedLookup(addresses),
    });
    upstream.on('socket', (socket: net.Socket) => {
      if (!socket.connecting) return;
      const timer = setTimeout(() => socket.destroy(new ConnectTimeoutError('connect timeout')), this.connectTimeoutMs);
      socket.once('connect', () => clearTimeout(timer));
      socket.once('close', () => clearTimeout(timer));
    });
    upstream.setTimeout(this.idleTimeoutMs, () => upstream.destroy(new ConnectTimeoutError('idle timeout')));
    upstream.on('response', (up) => {
      res.writeHead(up.statusCode ?? 502, up.statusMessage, forwardableHeaders(up.rawHeaders));
      up.pipe(res);
      up.on('error', () => res.destroy());
    });
    upstream.on('error', (err) => {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = this.failure(target, 'request', err);
      res.writeHead(status, { connection: 'close', 'content-length': '0' }).end();
    });
    res.once('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  // ── connecting ────────────────────────────────────────

  /** Admit and connect for a raw-socket client; on failure answer it and return null. */
  private async connectFor(client: net.Socket, target: Target, kind: string): Promise<net.Socket | null> {
    const abort = new AbortController();
    const onClose = () => abort.abort(new Error('client closed'));
    client.once('close', onClose);
    try {
      const addresses = await this.admit(target, abort.signal);
      const upstream = await this.connect(target, addresses, abort.signal);
      if (client.destroyed) {
        upstream.destroy();
        return null;
      }
      return upstream;
    } catch (err) {
      if (!abort.signal.aborted) reject(client, this.failure(target, kind, err));
      return null;
    } finally {
      client.off('close', onClose);
    }
  }

  /** Resolve and check `target`; the returned addresses are the only ones to connect to. */
  private async admit(target: Target, signal: AbortSignal): Promise<string[]> {
    const addresses = await this.resolve(target.host, signal);
    // Whatever the policy (the dev override allows private addresses), never
    // loop back into this proxy.
    if (target.port === this.port && addresses.some((a) => isBlockedAddress(a))) {
      throw new OutboundBlockedError('address', target.host, 'the egress proxy itself is not a destination');
    }
    return addresses;
  }

  private connect(target: Target, addresses: string[], signal: AbortSignal): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({
        // One address: connect to it directly. Several: the pinned lookup
        // hands Node exactly these (happy eyeballs across them), no DNS.
        host: addresses.length === 1 ? addresses[0] : target.host,
        port: target.port,
        lookup: pinnedLookup(addresses),
        autoSelectFamily: true,
      });
      track(this.upstreams, socket);
      const timer = setTimeout(() => socket.destroy(new ConnectTimeoutError('connect timeout')), this.connectTimeoutMs);
      const onAbort = () => socket.destroy(signal.reason as Error);
      signal.addEventListener('abort', onAbort, { once: true });
      const settle = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      socket.once('connect', () => {
        settle();
        socket.off('error', onError);
        // Never unhandled, whatever happens before the caller wires it up.
        socket.on('error', () => socket.destroy());
        resolve(socket);
      });
      const onError = (err: Error) => {
        settle();
        reject(err);
      };
      socket.once('error', onError);
    });
  }

  /** Pipe two sockets together until either closes or both sit idle. */
  private splice(a: net.Socket, b: net.Socket): void {
    const close = () => {
      a.destroy();
      b.destroy();
    };
    for (const socket of [a, b]) {
      socket.setTimeout(this.idleTimeoutMs, close);
      socket.on('error', close);
      socket.on('close', close);
    }
    a.pipe(b);
    b.pipe(a);
  }

  /** Count and log a failed admission or connect; the HTTP status to answer with. */
  private failure(target: Target, kind: string, err: unknown): number {
    if (isOutboundBlockedError(err)) {
      this.counters.refused++;
      const key = refusalKey(target.host, target.port);
      const known = this.refusals.has(key);
      this.refusals.delete(key);
      this.refusals.set(key, { error: err, expiresAt: Date.now() + REFUSAL_TTL_MS });
      if (this.refusals.size > MAX_REFUSALS) this.refusals.delete(this.refusals.keys().next().value!);
      // One line per destination per minute: pages can retry in a loop.
      if (!known) this.logger.warn(`[egress] refused ${kind} to ${display(target)} (${err.reason})`);
      return 403;
    }
    this.counters.failed++;
    return err instanceof ConnectTimeoutError ? 504 : 502;
  }

}

// ── helpers ──────────────────────────────────────────────

/** "host:port" or "[v6]:port" (a CONNECT target), normalized like a URL host. */
export function parseAuthority(authority: string): Target | null {
  const match = /^(\[[0-9a-fA-F:.%]+\]|[^\s:/?#@[\]]+):(\d{1,5})$/.exec(authority);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) return null;
  let hostname: string;
  try {
    hostname = new URL(`http://${match[1]}`).hostname;
  } catch {
    return null;
  }
  return { host: unbracket(hostname), port };
}

function parseAbsoluteUrl(raw: string, schemes: string[]): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return schemes.includes(url.protocol) && url.hostname !== '' ? url : null;
}

function targetOf(url: URL, defaultPort: number): Target {
  return { host: unbracket(url.hostname), port: Number(url.port) || defaultPort };
}

function track(set: Set<net.Socket>, socket: net.Socket): void {
  set.add(socket);
  socket.once('close', () => set.delete(socket));
}

function unbracket(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function refusalKey(host: string, port: number): string {
  return `${unbracket(host).toLowerCase()}:${port}`;
}

function display(target: Target): string {
  const host = target.host.length > 100 ? `${target.host.slice(0, 100)}…` : target.host;
  return `${host.includes(':') ? `[${host}]` : host}:${target.port}`;
}

function reject(socket: net.Socket, status: number): void {
  if (socket.destroyed) return;
  const extra = status === 403 ? `${EGRESS_REFUSED_HEADER}: refused\r\n` : '';
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`);
}

/** Raw headers (flat name/value list) minus hop-by-hop ones and those Connection names. */
function forwardableHeaders(raw: string[]): string[] {
  const named = new Set<string>();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i].toLowerCase() === 'connection') {
      for (const token of raw[i + 1].split(',')) named.add(token.trim().toLowerCase());
    }
  }
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    if (HOP_BY_HOP.has(name) || named.has(name)) continue;
    out.push(raw[i], raw[i + 1]);
  }
  return out;
}

/** A node:net lookup that answers with `addresses` only: the name is never resolved again. */
function pinnedLookup(addresses: string[]): net.LookupFunction {
  return (_hostname, options, callback) => {
    const family = options.family === 4 || options.family === 'IPv4' ? 4 : options.family === 6 || options.family === 'IPv6' ? 6 : 0;
    const usable = addresses.filter((a) => family === 0 || net.isIP(a) === family);
    if (usable.length === 0) {
      callback(Object.assign(new Error('no address of the requested family'), { code: 'ENOTFOUND' }), '');
      return;
    }
    if (options.all) callback(null, usable.map((address) => ({ address, family: net.isIP(address) })));
    else callback(null, usable[0], net.isIP(usable[0]));
  };
}
