import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { isBlockedAddress, isBlockedHostname } from './net.js';
import { API_KEY_PREFIX, type ScrapeOptions } from './types.js';

export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `${API_KEY_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 12);
  return { raw, hash, prefix };
}

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function createCacheKey(url: string, options: Record<string, unknown>): string {
  const payload = JSON.stringify({ url, ...options });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function hasExtractSchema(options: ScrapeOptions): boolean {
  return Boolean(options.extractSchema) && Object.keys(options.extractSchema as object).length > 0;
}

function byJson(a: string[], b: string[]): number {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Digest of the caller's headers and cookies (independent of order and header-name case), or undefined when none are sent. */
function credentialsDigest(options: ScrapeOptions): string | undefined {
  const headers = Object.entries(options.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), String(value)])
    .sort(byJson);
  const cookies = (options.cookies ?? []).map((c) => [c.name, c.value, c.domain ?? '', c.path ?? '']).sort(byJson);
  if (headers.length === 0 && cookies.length === 0) return undefined;
  return crypto.createHash('sha256').update(JSON.stringify({ headers, cookies })).digest('hex');
}

/**
 * Redis key (`cache:<hash>`) of a cached scrape/extract result. The API reads
 * and the worker writes with this function, both from the job's `options`
 * object, so the two keys cannot drift. A result is only ever served back to
 * the same tenant with the same custom headers and cookies (they can carry
 * credentials; only their hash enters the key), and an extraction result
 * only to a request with the same spend cap.
 */
export function resultCacheKey(userId: string, url: string, options: ScrapeOptions): string {
  return `cache:${createCacheKey(url, {
    tenant: userId,
    formats: options.formats,
    proxy: options.proxy,
    // Fetch options that change what comes back (browser tier, viewport, screenshot).
    screenshot: options.screenshot,
    mobile: options.mobile,
    waitFor: options.waitFor,
    blockResources: options.blockResources,
    extractSchema: options.extractSchema,
    // Optional parts are left out when unset (JSON.stringify drops undefined).
    includeEvidence: options.includeEvidence || undefined,
    maxLlmCostUsd: hasExtractSchema(options) ? options.maxLlmCostUsd : undefined,
    credentials: credentialsDigest(options),
  })}`;
}

/**
 * Whether a finished job's result may be cached. Plain scrapes are; an
 * extraction only when `complete`: a partial result can come from this
 * request's spend cap, deadline or a transient provider failure, and would
 * otherwise be served to later requests for the whole cacheTtl.
 */
export function isCacheableResult(options: ScrapeOptions, extractionStatus: string | undefined): boolean {
  if (!options.cacheTtl || options.cacheTtl <= 0) return false;
  return !hasExtractSchema(options) || extractionStatus === 'complete';
}

/**
 * Cheap synchronous pre-check only. It reads the URL text and never resolves
 * DNS, so a public name that resolves to a private address passes. Use
 * assertPublicUrl (net.ts) before making any outbound request.
 */
export function isUrlSafe(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // WHATWG URL keeps IPv6 hosts bracketed ("[::1]") and has already
  // normalized legacy IPv4 spellings ("0x7f.1" → "127.0.0.1").
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (isIP(host)) return !isBlockedAddress(host);
  return !isBlockedHostname(host);
}
