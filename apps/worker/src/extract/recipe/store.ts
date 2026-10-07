// Redis-backed store for extraction recipes with a candidate → active
// lifecycle and drift invalidation.
//
// Lifecycle:
//   saveCandidate     stores a validated recipe as a candidate (never replaces
//                     an active one); saving the same recipe again counts as
//                     agreement on that snapshot.
//   recordAgreement   the recipe reproduced grounded results on a snapshot;
//                     a candidate becomes active once it agreed on
//                     promoteAfter + 1 distinct snapshots.
//   recordDisagreement  a candidate is dropped; an active recipe counts a failure.
//   recordUse         an active recipe served a request; failures in a row
//                     (invariants broken) delete it (drift invalidation).
//
// Keys are scoped per tenant, host, page template and schema hash, with each
// part escaped so no part can inject ":" and alias another tenant's key.
// Updates are read-modify-write without a transaction: concurrent workers may
// lose an increment, which only delays a promotion or an invalidation.
// Anything unreadable in the store is treated as missing and deleted.

import { createHash } from 'node:crypto';
import type { ExtractionRecipe, RecipeKey, StoredRecipe } from '../types.js';
import { validateRecipe } from './validate.js';

export interface RecipeKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSec: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface RecipeStoreOptions {
  /** TTL refreshed on every write. Default 14 days. */
  ttlSec?: number;
  /** Additional distinct agreeing snapshots before a candidate is promoted. Default 2. */
  promoteAfter?: number;
  /** Consecutive failed uses that delete an active recipe. Default 2. */
  maxConsecutiveFailures?: number;
}

export interface CandidateInfo {
  /** Snapshot the recipe was derived from and agreed with. */
  snapshotHash: string;
  /** Fields the recipe must fill for its output to be accepted. */
  requiredFields: string[];
  /** Records the recipe produced on that snapshot (array shape). */
  recordCount?: number;
}

export type SaveCandidateResult =
  | { saved: true; stored: StoredRecipe }
  | { saved: false; reason: 'active-exists' | 'invalid'; detail?: string };

const DEFAULT_TTL_SEC = 14 * 24 * 3600;
const MAX_KEY_PART_CHARS = 128;
const MAX_SNAPSHOT_CHARS = 200;
/** Most recent distinct snapshots remembered per recipe. */
const MAX_VALIDATED_SNAPSHOTS = 20;
/** Stored entries larger than this are treated as corrupt. */
const MAX_STORED_CHARS = 1_000_000;

export class RecipeStore {
  private readonly ttlSec: number;
  private readonly promoteAfter: number;
  private readonly maxConsecutiveFailures: number;

  constructor(
    private readonly kv: RecipeKv,
    opts: RecipeStoreOptions = {},
  ) {
    this.ttlSec = positiveInt(opts.ttlSec, DEFAULT_TTL_SEC, 1);
    this.promoteAfter = positiveInt(opts.promoteAfter, 2, 0);
    this.maxConsecutiveFailures = positiveInt(opts.maxConsecutiveFailures, 2, 1);
  }

  /** "recipe:v1:{tenant}:{host}:{template}:{schemaHash}" with every part escaped. */
  key(k: RecipeKey): string {
    return [
      'recipe:v1',
      keyPart(k.tenantId, 'tenantId'),
      keyPart(typeof k.host === 'string' ? k.host.toLowerCase() : k.host, 'host'),
      keyPart(k.templateSignature, 'templateSignature'),
      keyPart(k.schemaHash, 'schemaHash'),
    ].join(':');
  }

  async get(k: RecipeKey): Promise<StoredRecipe | null> {
    return this.load(this.key(k));
  }

  async saveCandidate(k: RecipeKey, recipe: ExtractionRecipe, info: CandidateInfo): Promise<SaveCandidateResult> {
    if (!isSnapshotHash(info.snapshotHash)) return { saved: false, reason: 'invalid', detail: 'snapshotHash must be a non-empty string' };
    const checked = validateRecipe(recipe);
    if (!checked.ok) return { saved: false, reason: 'invalid', detail: checked.errors.join('; ') };
    const fieldNames = Object.keys(checked.recipe.fields);
    const required = [...new Set(info.requiredFields)];
    const unknown = required.filter((f) => typeof f !== 'string' || !fieldNames.includes(f));
    if (unknown.length > 0) return { saved: false, reason: 'invalid', detail: `required fields not in recipe: ${unknown.join(', ')}` };
    const count = validCount(info.recordCount);

    const key = this.key(k);
    const existing = await this.load(key);
    if (existing?.state === 'active') return { saved: false, reason: 'active-exists' };
    if (existing && sameRecipe(existing.recipe, checked.recipe)) {
      // The same recipe proposed again from another snapshot is agreement.
      const stored = this.withAgreement(existing, info.snapshotHash, count);
      await this.write(key, stored);
      return { saved: true, stored };
    }
    let stored: StoredRecipe = {
      recipe: checked.recipe,
      state: 'candidate',
      createdAt: new Date().toISOString(),
      validatedOn: [info.snapshotHash],
      uses: 0,
      failures: 0,
      requiredFields: required,
    };
    if (count !== undefined) stored.recordCount = { min: count, max: count };
    stored = this.promoteIfReady(stored);
    await this.write(key, stored);
    return { saved: true, stored };
  }

  /** The recipe agreed with grounded results on this snapshot. Returns the updated entry, or null when none exists. */
  async recordAgreement(k: RecipeKey, snapshotHash: string, info: { recordCount?: number } = {}): Promise<StoredRecipe | null> {
    const key = this.key(k);
    const existing = await this.load(key);
    if (!existing || !isSnapshotHash(snapshotHash)) return existing;
    const stored = this.withAgreement(existing, snapshotHash, validCount(info.recordCount));
    await this.write(key, stored);
    return stored;
  }

  /** The recipe disagreed with grounded results. Returns what remains stored. */
  async recordDisagreement(k: RecipeKey): Promise<StoredRecipe | null> {
    const key = this.key(k);
    const existing = await this.load(key);
    if (!existing) return null;
    if (existing.state === 'candidate') {
      await this.kv.del(key);
      return null;
    }
    return this.fail(key, existing);
  }

  /** An active recipe served a request; `ok` = its output passed the invariants. Returns what remains stored. */
  async recordUse(k: RecipeKey, ok: boolean): Promise<StoredRecipe | null> {
    const key = this.key(k);
    const existing = await this.load(key);
    if (!existing) return null;
    if (!ok) return this.fail(key, existing);
    const stored: StoredRecipe = { ...existing, uses: existing.uses + 1, failures: 0 };
    await this.write(key, stored);
    return stored;
  }

  // ── internals ────────────────────────────────────────────

  private async fail(key: string, existing: StoredRecipe): Promise<StoredRecipe | null> {
    const failures = existing.failures + 1;
    // A candidate is never trusted after a failure; an active recipe gets
    // maxConsecutiveFailures chances before it is treated as drifted.
    if (existing.state === 'candidate' || failures >= this.maxConsecutiveFailures) {
      await this.kv.del(key);
      return null;
    }
    const stored: StoredRecipe = { ...existing, uses: existing.uses + 1, failures };
    await this.write(key, stored);
    return stored;
  }

  private withAgreement(existing: StoredRecipe, snapshotHash: string, count: number | undefined): StoredRecipe {
    let validatedOn = existing.validatedOn;
    if (!validatedOn.includes(snapshotHash)) validatedOn = [...validatedOn, snapshotHash].slice(-MAX_VALIDATED_SNAPSHOTS);
    const stored: StoredRecipe = { ...existing, validatedOn, failures: 0 };
    if (count !== undefined) {
      const range = existing.recordCount;
      stored.recordCount = range ? { min: Math.min(range.min, count), max: Math.max(range.max, count) } : { min: count, max: count };
    }
    return this.promoteIfReady(stored);
  }

  private promoteIfReady(stored: StoredRecipe): StoredRecipe {
    if (stored.state === 'candidate' && stored.validatedOn.length >= this.promoteAfter + 1) {
      return { ...stored, state: 'active' };
    }
    return stored;
  }

  private async write(key: string, stored: StoredRecipe): Promise<void> {
    await this.kv.set(key, JSON.stringify(stored), 'EX', this.ttlSec);
  }

  private async load(key: string): Promise<StoredRecipe | null> {
    const raw = await this.kv.get(key);
    if (raw === null || raw === undefined) return null;
    const stored = parseStored(raw);
    if (!stored) await this.kv.del(key);
    return stored;
  }
}

// ─────────────────────────────────────────────────────────────
// Keys
// ─────────────────────────────────────────────────────────────

/**
 * Injective escaping: [A-Za-z0-9._-] stay, every other UTF-16 unit becomes
 * "%" + 4 hex digits (so ":" can never appear). Long parts are replaced by
 * "#" + a sha256 prefix; "#" never survives escaping, so hashed and escaped
 * parts cannot collide.
 */
function keyPart(part: unknown, label: string): string {
  if (typeof part !== 'string' || part.length === 0) throw new TypeError(`recipe key: ${label} must be a non-empty string`);
  const escaped = part.replace(/[^A-Za-z0-9._-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (escaped.length <= MAX_KEY_PART_CHARS) return escaped;
  return `#${createHash('sha256').update(part).digest('hex').slice(0, 32)}`;
}

// ─────────────────────────────────────────────────────────────
// Parsing stored entries
// ─────────────────────────────────────────────────────────────

function parseStored(raw: string): StoredRecipe | null {
  if (typeof raw !== 'string' || raw.length > MAX_STORED_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const checked = validateRecipe(v.recipe);
  if (!checked.ok) return null;
  if (v.state !== 'candidate' && v.state !== 'active') return null;
  if (typeof v.createdAt !== 'string') return null;
  if (!Array.isArray(v.validatedOn) || v.validatedOn.length === 0 || !v.validatedOn.every(isSnapshotHash)) return null;
  if (!isCount(v.uses) || !isCount(v.failures)) return null;
  const fields = Object.keys(checked.recipe.fields);
  if (!Array.isArray(v.requiredFields) || !v.requiredFields.every((f) => typeof f === 'string' && fields.includes(f))) return null;
  const stored: StoredRecipe = {
    recipe: checked.recipe,
    state: v.state,
    createdAt: v.createdAt,
    validatedOn: (v.validatedOn as string[]).slice(-MAX_VALIDATED_SNAPSHOTS),
    uses: v.uses as number,
    failures: v.failures as number,
    requiredFields: v.requiredFields as string[],
  };
  if (v.recordCount !== undefined) {
    const rc = v.recordCount as { min?: unknown; max?: unknown } | null;
    if (!rc || typeof rc !== 'object' || !isCount(rc.min) || !isCount(rc.max) || rc.min > rc.max) return null;
    stored.recordCount = { min: rc.min, max: rc.max };
  }
  return stored;
}

function sameRecipe(a: ExtractionRecipe, b: ExtractionRecipe): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** JSON with object keys sorted, so field order does not make two recipes differ. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isSnapshotHash(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_SNAPSHOT_CHARS;
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function validCount(v: number | undefined): number | undefined {
  return isCount(v) ? v : undefined;
}

function positiveInt(v: number | undefined, fallback: number, min: number): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min ? v : fallback;
}
