// Output validation against the customer's (normalized) JSON Schema.
//
// One shared Ajv instance compiles validators; compiled functions are kept in
// an LRU keyed by NormalizedSchema.hash. On eviction the schema is also
// removed from Ajv's own cache, otherwise every distinct customer schema
// would stay in memory for the life of the process.
//
// Options: no type coercion, no defaults, no property removal: the output is
// judged as returned, never repaired by the validator. Formats are NOT
// validated ("format" is accepted and ignored): ajv-formats is not a
// dependency, and normalization owns conversions such as absolute URLs.
// OpenAPI-style `nullable: true` is understood natively by Ajv 8 (it adds
// "null" to `type`); normalizeSchema already rewrites it, so it only matters
// for schemas built elsewhere.

import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { JsonSchema, NormalizedSchema } from '../types.js';

export const MAX_REPORTED_ERRORS = 20;
export const VALIDATOR_CACHE_SIZE = 200;

const MAX_ERROR_CHARS = 300;
const MAX_COMPILE_ERROR_CHARS = 300;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

interface CacheEntry {
  /** The schema object Ajv compiled (Ajv caches by object identity). */
  source: JsonSchema;
  /** JSON of `source`; guards against 64-bit hash collisions across tenants. */
  fingerprint: string;
  /** jsonSchema objects already confirmed equal to `source` (one per request). */
  confirmed: WeakSet<object>;
  validate?: ValidateFunction;
  compileError?: string;
}

/**
 * Strings longer than this are not matched against "pattern" (they fail it).
 * normalizeSchema only admits patterns that are at most quadratic, and the
 * cap keeps even those to milliseconds on page-derived values. Patterns on
 * multi-kilobyte strings are not a realistic extraction use.
 */
export const MAX_PATTERN_INPUT_CHARS = 2_000;

// Ajv's RegExpEngine/RegExpLike shapes (not exported from the package entry).
interface RegExpLike {
  test: (s: string) => boolean;
  toString: () => string;
}
type RegExpEngine = ((pattern: string, flags: string) => RegExpLike) & { code: string };

const boundedRegExp: RegExpEngine = Object.assign(
  (pattern: string, flags: string): RegExpLike => {
    const re = new RegExp(pattern, flags);
    // Ajv keys compiled patterns by toString(); it must stay unique per pattern.
    return { test: (s: string) => s.length <= MAX_PATTERN_INPUT_CHARS && re.test(s), toString: () => re.toString() };
  },
  { code: 'boundedRegExp' },
);

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  validateFormats: false,
  // Without this Ajv reads inherited members: a field named "toString" sees
  // Object.prototype.toString (false type error) and required: ["valueOf"]
  // passes on an empty object.
  ownProperties: true,
  // Never copy instance data into error objects: outputs can be large.
  verbose: false,
  code: { regExp: boundedRegExp },
});

const cache = new Map<string, CacheEntry>();

/** Validates the final engine output against the customer schema. */
export function validateOutput(schema: NormalizedSchema, data: unknown): ValidationResult {
  const entry = getEntry(schema);
  if (!entry.validate) {
    return { valid: false, errors: [`schema_compile_failed: ${entry.compileError ?? 'unknown error'}`] };
  }
  let ok: unknown;
  try {
    ok = entry.validate(data);
  } catch (err) {
    // Only reachable with non-JSON data (cycles, getters that throw).
    return { valid: false, errors: [`validation_failed: ${clip(errorMessage(err), MAX_COMPILE_ERROR_CHARS)}`] };
  }
  if (ok === true) return { valid: true, errors: [] };
  return { valid: false, errors: formatErrors(entry.validate.errors ?? [], schema, data) };
}

/**
 * Compiles (or fetches) the validator for `schema`; returns the compile error
 * message, or null when the schema compiles. Lets callers reject a schema
 * before any extraction work is spent on it.
 */
export function compileError(schema: NormalizedSchema): string | null {
  return getEntry(schema).compileError ?? null;
}

/** Test/diagnostic hooks. */
export function validatorCacheSize(): number {
  return cache.size;
}

export function clearValidatorCache(): void {
  for (const entry of cache.values()) ajv.removeSchema(entry.source);
  cache.clear();
}

function getEntry(schema: NormalizedSchema): CacheEntry {
  const key = schema.hash;
  const cached = cache.get(key);
  if (cached && sameSchema(cached, schema.jsonSchema)) {
    // Refresh LRU position.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  if (cached) evict(key, cached);

  const entry = compile(schema.jsonSchema);
  cache.set(key, entry);
  while (cache.size > VALIDATOR_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value as string;
    evict(oldestKey, cache.get(oldestKey)!);
  }
  return entry;
}

function sameSchema(entry: CacheEntry, jsonSchema: JsonSchema): boolean {
  if (entry.source === jsonSchema || entry.confirmed.has(jsonSchema)) return true;
  if (safeStringify(jsonSchema) !== entry.fingerprint) return false;
  entry.confirmed.add(jsonSchema);
  return true;
}

function compile(source: JsonSchema): CacheEntry {
  const entry: CacheEntry = { source, fingerprint: safeStringify(source), confirmed: new WeakSet() };
  try {
    const validate = ajv.compile(source);
    // An async validator returns a Promise, which would read as "valid".
    if ((validate as { $async?: unknown }).$async) throw new Error('$async schemas are not supported');
    entry.validate = validate;
  } catch (err) {
    entry.compileError = clip(errorMessage(err), MAX_COMPILE_ERROR_CHARS);
    // A failed compile can leave a partial entry in Ajv's cache.
    ajv.removeSchema(source);
  }
  return entry;
}

function evict(key: string, entry: CacheEntry): void {
  cache.delete(key);
  ajv.removeSchema(entry.source);
}

// ─────────────────────────────────────────────────────────────
// Error formatting
// ─────────────────────────────────────────────────────────────

function formatErrors(errors: ErrorObject[], schema: NormalizedSchema, data: unknown): string[] {
  const relevant = schema.shape === 'auto' ? autoBranchErrors(errors, data) : errors;
  const messages = [...new Set(relevant.map(formatError))];
  if (messages.length <= MAX_REPORTED_ERRORS) return messages;
  const shown = messages.slice(0, MAX_REPORTED_ERRORS - 1);
  shown.push(`(${messages.length - shown.length} more errors not shown)`);
  return shown;
}

/**
 * For shape 'auto' the schema is anyOf[record, array of records]. Ajv reports
 * the failures of both branches plus "must match a schema in anyOf"; only the
 * branch matching the data's shape is useful to a reader.
 */
function autoBranchErrors(errors: ErrorObject[], data: unknown): ErrorObject[] {
  const branch = Array.isArray(data) ? '#/anyOf/1' : '#/anyOf/0';
  const filtered = errors.filter((e) => e.schemaPath === branch || e.schemaPath.startsWith(`${branch}/`));
  return filtered.length > 0 ? filtered : errors;
}

function formatError(error: ErrorObject): string {
  const path = error.instancePath === '' ? '/' : error.instancePath;
  let text = `${path} ${error.message ?? `failed ${error.keyword}`}`;
  const params = error.params as Record<string, unknown>;
  if (error.keyword === 'additionalProperties' && typeof params.additionalProperty === 'string') {
    text += `: ${JSON.stringify(clip(params.additionalProperty, 60))}`;
  } else if (error.keyword === 'enum' && Array.isArray(params.allowedValues)) {
    const shown = params.allowedValues.slice(0, 5).map((v) => clip(safeStringify(v), 40));
    text += `: ${shown.join(', ')}${params.allowedValues.length > 5 ? ', …' : ''}`;
  }
  return clip(text, MAX_ERROR_CHARS);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
