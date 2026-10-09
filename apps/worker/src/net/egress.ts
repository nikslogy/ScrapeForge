// The worker's egress guard: one EgressProxy per process, started on first
// use. HTTP tiers (Impit) and the pooled Chromium connect through it, so the
// outbound policy is enforced on the address actually connected to (see
// egress-proxy.ts). Fails closed: if it cannot start, fetches fail rather
// than going out unguarded.
//
// Environment (all optional): EGRESS_MAX_CONNECTIONS (default 512),
// EGRESS_CONNECT_TIMEOUT_MS (10 s), EGRESS_IDLE_TIMEOUT_MS (60 s).

import type { OutboundBlockedError } from '@scrapeforge/shared';
import { EGRESS_REFUSED_HEADER, EgressProxy, type EgressProxyOptions } from './egress-proxy.js';

let starting: Promise<EgressProxy> | null = null;
let running: EgressProxy | null = null;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function optionsFromEnv(): EgressProxyOptions {
  return {
    maxConnections: envInt('EGRESS_MAX_CONNECTIONS', 512),
    connectTimeoutMs: envInt('EGRESS_CONNECT_TIMEOUT_MS', 10_000),
    idleTimeoutMs: envInt('EGRESS_IDLE_TIMEOUT_MS', 60_000),
  };
}

/** The process's egress guard, started on the first call. */
export function egressGuard(): Promise<EgressProxy> {
  if (!starting) {
    const proxy = new EgressProxy(optionsFromEnv());
    const pending = proxy.listen().then(() => {
      running = proxy;
      return proxy;
    });
    starting = pending;
    // Let the next caller try again rather than caching a failed start.
    pending.catch(() => {
      if (starting === pending) starting = null;
    });
  }
  return starting;
}

/** URL of the process's egress guard (http://127.0.0.1:<port>). */
export async function egressProxyUrl(): Promise<string> {
  return (await egressGuard()).url;
}

/**
 * The proxy an HTTP client should use: the configured upstream proxy when
 * there is one (commercial proxies resolve names on their side, outside our
 * network, and the pre-connect check still runs), else the egress guard.
 */
export async function httpClientProxy(upstream: string | undefined): Promise<string> {
  return upstream ? upstream : egressProxyUrl();
}

interface HopResponse {
  status: number;
  headers: { get(name: string): string | null };
}

/**
 * `send()` for a request to `url` made through the guard, with a refusal by
 * the guard reported as the OutboundBlockedError it is: a refused tunnel
 * reaches the client as a connect error, a refused plain-HTTP request as the
 * guard's own 403. Only refusals the guard recorded count, so a server
 * cannot fake one.
 */
export async function throughEgressGuard<R extends HopResponse>(url: URL, send: () => Promise<R>): Promise<R> {
  let response: R;
  try {
    response = await send();
  } catch (err) {
    throw egressRefusal(url) ?? err;
  }
  if (response.status === 403 && response.headers.get(EGRESS_REFUSED_HEADER) === 'refused') {
    const refusal = egressRefusal(url);
    if (refusal) throw refusal;
  }
  return response;
}

/** The guard's recent refusal of `url`'s host and port, if any. */
export function egressRefusal(url: URL): OutboundBlockedError | undefined {
  if (!running) return undefined;
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  return running.recentRefusal(url.hostname, Number(url.port) || (secure ? 443 : 80));
}

/** Stop the guard (worker shutdown, tests). The next use starts a new one. */
export async function closeEgressGuard(): Promise<void> {
  const pending = starting;
  starting = null;
  running = null;
  const proxy = await pending?.catch(() => null);
  await proxy?.close();
}
