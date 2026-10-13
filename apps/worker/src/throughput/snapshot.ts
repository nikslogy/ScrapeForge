// Fetch snapshot cache: the fetched page, kept apart from the result cache.
//
// The result cache answers only an identical request (same formats, schema,
// spend cap). A request for the same page with another schema, other
// formats, or a retry after a partial extraction would refetch it, often
// through a browser tier. The snapshot cache keeps the fetched HTML for a
// short time (gzip-compressed) so those requests skip the fetch.
//
// Only clean fetches are kept: a 2xx/3xx status, not a block or challenge
// page, no screenshot (it would have to be re-taken anyway). A request with
// cacheTtl: 0 asks for a fresh page and neither reads nor writes.

import { gunzipSync, gzipSync } from 'node:zlib';

export interface SnapshotKv {
  getBuffer(key: string): Promise<Buffer | null>;
  set(key: string, value: Buffer, mode: 'EX', ttlSec: number): Promise<unknown>;
}

export interface PageSnapshot {
  html: string;
  statusCode: number;
  tierUsed: number;
  proxyTier: string;
  /** When the page was fetched (epoch ms). */
  fetchedAt: number;
}

/** Seconds a snapshot is kept. SNAPSHOT_TTL_SEC overrides; 0 turns the cache off. */
export const DEFAULT_SNAPSHOT_TTL_SEC = 300;
/** Larger pages (compressed) are not kept. */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

const VERSION = 1;

export function snapshotTtlSec(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SNAPSHOT_TTL_SEC;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SNAPSHOT_TTL_SEC;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_SNAPSHOT_TTL_SEC;
}

/** Whether a request may use the snapshot cache at all. */
export function snapshotEligible(options: { cacheTtl?: number; screenshot?: boolean; formats?: readonly string[] }, ttlSec: number): boolean {
  return ttlSec > 0 && options.cacheTtl !== 0 && options.screenshot !== true && !(options.formats ?? []).includes('screenshot');
}

/** Whether a fetch is worth keeping: a usable page, not a block page or an error. */
export function snapshotWorthy(statusCode: number, blocked: boolean, html: string): boolean {
  return statusCode >= 200 && statusCode < 400 && !blocked && html.length > 0;
}

export function encodeSnapshot(snapshot: PageSnapshot): Buffer {
  return gzipSync(Buffer.from(JSON.stringify({ v: VERSION, ...snapshot }), 'utf8'));
}

export function decodeSnapshot(data: Buffer): PageSnapshot | null {
  try {
    const parsed = JSON.parse(gunzipSync(data).toString('utf8')) as Partial<PageSnapshot> & { v?: number };
    if (parsed.v !== VERSION || typeof parsed.html !== 'string' || typeof parsed.statusCode !== 'number') return null;
    if (typeof parsed.tierUsed !== 'number' || typeof parsed.proxyTier !== 'string' || typeof parsed.fetchedAt !== 'number') return null;
    return { html: parsed.html, statusCode: parsed.statusCode, tierUsed: parsed.tierUsed, proxyTier: parsed.proxyTier, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
}

/** The cached page, or null (missing, expired, corrupt, or the store failed: a cache never fails a job). */
export async function readSnapshot(kv: SnapshotKv, key: string): Promise<PageSnapshot | null> {
  try {
    const data = await kv.getBuffer(key);
    return data ? decodeSnapshot(data) : null;
  } catch {
    return null;
  }
}

/** Stores the page; false when it is too large or the store failed. */
export async function writeSnapshot(kv: SnapshotKv, key: string, snapshot: PageSnapshot, ttlSec: number): Promise<boolean> {
  if (ttlSec <= 0) return false;
  try {
    const data = encodeSnapshot(snapshot);
    if (data.length > MAX_SNAPSHOT_BYTES) return false;
    await kv.set(key, data, 'EX', ttlSec);
    return true;
  } catch {
    return false;
  }
}
