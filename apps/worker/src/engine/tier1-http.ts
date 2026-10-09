import { Impit, type ImpitResponse } from 'impit';
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
  // Every hop is checked before it is sent (fetchWithSafeRedirects); without
  // an upstream proxy, Impit also connects through the local egress guard,
  // which checks the address actually connected to (DNS rebinding).
  const viaGuard = !options.proxy;
  const client = clientFor(await httpClientProxy(options.proxy));
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

// Phrases and markers that only block/challenge pages carry. Matched
// case-insensitively anywhere in small responses.
const BLOCK_INDICATORS = [
  'cf-browser-verification',
  'challenge-platform',
  '_cf_chl_opt',
  'ddos-protection',
  'captcha-delivery',
  'access denied',
  'please verify you are human',
  'just a moment',
  'enable javascript and cookies to continue',
  'attention required! | cloudflare',
  'sorry, you have been blocked',
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
  '_incapsula_resource',
  'request unsuccessful. incapsula',
  'pardon our interruption',
  'sec-if-cpt',
];

// Structural (script src, element ids) rather than prose: safe to look for in
// the <head> of large pages too.
const STRUCTURAL_MARKERS = [
  'cf-browser-verification',
  'challenge-platform',
  '_cf_chl_opt',
  'captcha-delivery',
  'errors/validatecaptcha',
  'px-captcha',
  'pxcaptcha',
  '_incapsula_resource',
];

// Real block pages are almost always under ~10 KB; prose mentions of these
// words in long articles must not count.
const SMALL_PAGE_BYTES = 10_000;
const LARGE_PAGE_HEAD_BYTES = 4_000;
const CLOAKED_STUB_BYTES = 1_000;

function isContentHeavyHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    return CONTENT_HEAVY_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false; // bad URL: skip the heuristic
  }
}

/**
 * Returns false if the page looks like a bot-detection challenge
 * rather than real content.
 *
 * `url` is optional — when supplied, enables a short-body check for
 * content-heavy domains (walmart's block page is a 423-char 200 OK).
 *
 * This is the fast first gate; calculateQualityScore (quality-scorer.ts)
 * judges how much real content a page that passes here carries.
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
  // tier. Status codes + block-phrase matches below are sufficient. A body of
  // nothing but whitespace is not a page, though.
  if (!html || !/\S/.test(html)) return false;

  // Keyword-based block detection is only reliable on SMALL responses.
  // Long-form articles legitimately mention vendor names ("DataDome",
  // "PerimeterX"), CAPTCHA, and phrases like "access denied" — Wikipedia's
  // "Web scraping" article is the canonical example.
  if (html.length < SMALL_PAGE_BYTES) {
    const lowerHtml = html.toLowerCase();
    if (BLOCK_INDICATORS.some((indicator) => lowerHtml.includes(indicator))) {
      return false;
    }
  } else {
    // On large pages, still catch the obvious Cloudflare / DataDome challenge
    // markers that appear in page <head> regardless of body size.
    const head = html.slice(0, LARGE_PAGE_HEAD_BYTES).toLowerCase();
    if (STRUCTURAL_MARKERS.some((m) => head.includes(m))) {
      return false;
    }
  }

  // Cloaked-block check: some sites serve a 200 OK with a near-empty body
  // when they suspect automation (walmart, google SERP). If the URL's host
  // matches a known content-heavy domain and the body is <1KB, treat it as
  // a block so the router escalates.
  if (url && html.length < CLOAKED_STUB_BYTES && isContentHeavyHost(url)) {
    return false;
  }

  return true;
}
