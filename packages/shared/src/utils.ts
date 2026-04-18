import crypto from 'node:crypto';
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

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

export function isUrlSafe(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname;
    if (BLOCKED_HOST_PATTERNS.some(pattern => pattern.test(hostname))) return false;
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return true;
  } catch {
    return false;
  }
}
