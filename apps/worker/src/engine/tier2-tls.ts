import { Impit, type Browser, type ImpitResponse } from 'impit';
import { fetchWithSafeRedirects, headersForHop } from '@scrapeforge/shared';
import { httpClientProxy, throughEgressGuard } from '../net/egress.js';

export interface FetchResult {
  html: string;
  statusCode: number;
  headers: Record<string, string>;
  latencyMs: number;
  /** URL of the final response, after redirects. */
  finalUrl: string;
}

const BROWSER_PROFILES: Browser[] = [
  'chrome',
  'chrome131',
  'firefox',
  'firefox135',
  'chrome116',
];

const DEFAULT_HEADERS: Record<string, string> = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'max-age=0',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

// One client per (profile, proxy) instead of one per request: Impit fixes
// both at construction, and reusing an instance keeps its connection pool and
// TLS sessions warm. Bounded because proxy URLs can rotate (per-session
// credentials); the oldest client is dropped first.
const MAX_CLIENTS = 64;
const clients = new Map<string, Impit>();

function clientFor(browser: Browser, proxyUrl: string | undefined): Impit {
  const key = `${browser}\n${proxyUrl ?? ''}`;
  let client = clients.get(key);
  if (!client) {
    if (clients.size >= MAX_CLIENTS) clients.delete(clients.keys().next().value!);
    // Redirects are followed by fetchWithSafeRedirects so every hop is checked.
    client = new Impit({ browser, proxyUrl, followRedirects: false });
    clients.set(key, client);
  }
  return client;
}

/** Release a redirect response without reading its (possibly endless) body. */
async function discardImpitBody(response: ImpitResponse): Promise<void> {
  await response.body.cancel();
}

/**
 * Tier 2: HTTP fetch with explicit browser TLS fingerprint.
 * Rotates through Chrome/Firefox profiles to evade JA3/JA4-based blocking.
 */
export async function tier2Fetch(
  url: string,
  options: {
    headers?: Record<string, string>;
    timeout?: number;
    proxy?: string;
  } = {},
): Promise<FetchResult> {
  const start = performance.now();

  const profile = BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)];
  // Every hop is checked before it is sent (fetchWithSafeRedirects); without
  // an upstream proxy, Impit also connects through the local egress guard,
  // which checks the address actually connected to (DNS rebinding).
  const viaGuard = !options.proxy;
  const client = clientFor(profile, await httpClientProxy(options.proxy));
  const headers = { ...DEFAULT_HEADERS, ...options.headers };
  // One deadline for the whole redirect chain, as before.
  const signal = AbortSignal.timeout(options.timeout || 15_000);

  const { response, url: finalUrl } = await fetchWithSafeRedirects(
    url,
    (hop) => {
      const send = () =>
        client.fetch(hop.url.href, {
          headers: headersForHop(headers, hop),
          redirect: 'manual',
          signal,
        });
      return viaGuard ? throughEgressGuard(hop.url, send) : send();
    },
    { signal, discard: discardImpitBody },
  );

  const html = await response.text();
  const latencyMs = Math.round(performance.now() - start);

  return {
    html,
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    latencyMs,
    finalUrl: finalUrl.href,
  };
}
