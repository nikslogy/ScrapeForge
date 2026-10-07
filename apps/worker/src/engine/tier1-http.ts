import { Impit, type ImpitResponse } from 'impit';
import { fetchWithSafeRedirects, headersForHop } from '@scrapeforge/shared';

export interface FetchResult {
  html: string;
  statusCode: number;
  headers: Record<string, string>;
  latencyMs: number;
  /** URL of the final response, after redirects. */
  finalUrl: string;
}

const DEFAULT_HEADERS: Record<string, string> = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

// Impit fixes the proxy at construction and pools connections per instance,
// so keep one client per proxy. Bounded because proxy URLs can rotate
// (per-session credentials); the oldest client is dropped first.
const MAX_CLIENTS = 16;
const clients = new Map<string, Impit>();

function clientFor(proxyUrl: string | undefined): Impit {
  const key = proxyUrl ?? '';
  let client = clients.get(key);
  if (!client) {
    if (clients.size >= MAX_CLIENTS) clients.delete(clients.keys().next().value!);
    // Redirects are followed by fetchWithSafeRedirects so every hop is checked.
    client = new Impit({ proxyUrl, followRedirects: false });
    clients.set(key, client);
  }
  return client;
}

/** Release a redirect response without reading its (possibly endless) body. */
async function discardImpitBody(response: ImpitResponse): Promise<void> {
  await response.body.cancel();
}

export async function tier1Fetch(
  url: string,
  options: {
    headers?: Record<string, string>;
    timeout?: number;
    proxy?: string;
  } = {},
): Promise<FetchResult> {
  const start = performance.now();
  const client = clientFor(options.proxy);
  const headers = { ...DEFAULT_HEADERS, ...options.headers };
  // One deadline for the whole redirect chain, as before.
  const signal = AbortSignal.timeout(options.timeout || 15_000);

  const { response, url: finalUrl } = await fetchWithSafeRedirects(
    url,
    (hop) =>
      client.fetch(hop.url.href, {
        headers: headersForHop(headers, hop),
        redirect: 'manual',
        signal,
      }),
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

/**
 * Domains that legitimately return large (>1KB) pages for ANY path. If we
 * get <1000 chars of HTML from one of these at T1/T2, it's almost certainly
 * a cloaked block page served at HTTP 200 — escalate.
 */
const CONTENT_HEAVY_DOMAINS = [
  'walmart.com',
  'amazon.com',
  'target.com',
  'ebay.com',
  'bestbuy.com',
  'google.com',
  'youtube.com',
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
];

/**
 * Returns false if the page looks like a bot-detection challenge
 * rather than real content.
 *
 * `url` is optional — when supplied, enables a short-body check for
 * content-heavy domains (walmart's block page is a 423-char 200 OK).
 */
export function isValidContent(
  html: string,
  statusCode: number,
  url?: string,
): boolean {
  if (statusCode === 403 || statusCode === 429 || statusCode === 503) return false;
  if (statusCode >= 500) return false;
  // No length floor here. Legitimate tiny pages (example.com = 167 bytes)
  // were being flagged as blocked and re-routed all the way to the browser
  // tier. Status codes + block-phrase matches below are sufficient.
  if (!html) return false;

  const blockIndicators = [
    'cf-browser-verification',
    'challenge-platform',
    'ddos-protection',
    'captcha-delivery',
    'access denied',
    'please verify you are human',
    'just a moment',
    'enable javascript and cookies to continue',
    'to discuss automated access to amazon data',
    'errors/validatecaptcha',
    'unusual traffic from your computer network',
    'our systems have detected unusual traffic',
    'robot or human',
    'blocked.gif',
    'px-captcha',
    'pxcaptcha',
    'perimeterx',
    'datadome',
    'shieldsquare',
  ];

  // Keyword-based block detection is only reliable on SMALL responses.
  // Long-form articles legitimately mention vendor names ("DataDome",
  // "PerimeterX"), CAPTCHA, and phrases like "access denied" — Wikipedia's
  // "Web scraping" article is the canonical example. Real block pages are
  // almost always under ~10 KB, so we gate the heuristic on size.
  if (html.length < 10_000) {
    const lowerHtml = html.toLowerCase();
    if (blockIndicators.some((indicator) => lowerHtml.includes(indicator))) {
      return false;
    }
  } else {
    // On large pages, still catch the obvious Cloudflare / DataDome challenge
    // markers that appear in page <head> regardless of body size. These are
    // structural (script src, meta tags) rather than prose mentions.
    const head = html.slice(0, 4000).toLowerCase();
    const structuralMarkers = [
      'cf-browser-verification',
      'challenge-platform',
      'captcha-delivery',
      'errors/validatecaptcha',
      'px-captcha',
      'pxcaptcha',
    ];
    if (structuralMarkers.some((m) => head.includes(m))) {
      return false;
    }
  }

  // Cloaked-block check: some sites serve a 200 OK with a near-empty body
  // when they suspect automation (walmart, google SERP). If the URL's host
  // matches a known content-heavy domain and the body is <1KB, treat it as
  // a block so the router escalates.
  if (url && html.length < 1000) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (CONTENT_HEAVY_DOMAINS.some((d) => host === d || host.endsWith('.' + d))) {
        return false;
      }
    } catch { /* bad URL — skip the heuristic */ }
  }

  return true;
}
