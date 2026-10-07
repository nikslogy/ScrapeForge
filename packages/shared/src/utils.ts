import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { isBlockedAddress, isBlockedHostname } from './net.js';
import { API_KEY_PREFIX } from './types.js';

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
