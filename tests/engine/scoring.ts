// Scores engine output against the hand-labelled gold of an extraction fixture.
//
// Deliberately independent of the engine's own normalization/grounding code:
// it is the yardstick, so a bug in the engine's normalizer must show up here
// as a wrong value rather than be reproduced on both sides.
//
// Definitions (per fixture; "slot" = one field of one record):
//   absent    = null, undefined, a missing key, "" (or whitespace only), or an
//               array holding only such values. Engines and models use all of
//               these for "not on the page"; they are treated alike.
//               Output keys outside the schema (and gold) are ignored.
//   expected  = slots whose gold value is present.
//   returned  = slots whose output value is present.
//   correct   = slots where both are present and the values compare equal.
//   valuePrecision = correct / returned   (1 when nothing was returned)
//   valueRecall    = correct / expected   (1 when nothing was expected)
//   hallucinatedNulls = values returned where the gold says "absent": a null
//               gold field, or any value when the whole gold is null (a page
//               with nothing extractable). They also count in `returned`.
//   correctNulls = slots absent on both sides. Not part of precision/recall
//               (recall over absences would reward returning nothing), but
//               reported so "correctly said nothing" is visible.
// Records (array fixtures) are matched by the fixture's recordKey, compared
// after normalization, unordered; equal keys pair up by multiplicity (best
// agreeing pairs first). A gold record without a partner contributes its
// present values to `expected`; an output record without a partner
// contributes its present values to `returned`. recordPrecision/Recall count
// key matches only (values are scored separately).
// Fields declared derived (x-derived: true in the schema, or opts.derivedFields)
// are inferences, not verbatim facts, and are skipped entirely.
//
// Comparators (gold value decides the comparator):
//   number  → output must be a number; integers exact, others within 0.5 %
//             relative (opts.numberTolerance).
//   boolean → strict equality.
//   string  → absolute http(s) URL: equal after URL normalization (output must
//             be absolute too); ISO date-time with offset: same instant when
//             the output is one as well; otherwise NFKC, case, whitespace,
//             quote and dash normalized exact match.
//   array   → unordered set of normalized scalars (objects: unordered multiset).
//   object  → every gold key compares equal (extra output keys are ignored).
// A value of a different JSON type than the gold is wrong ("type").

import type { Fixture } from '../fixtures/extraction/load.js';

export interface FieldScore {
  /** Present output values equal to the present gold value. */
  correct: number;
  /** Present output values. */
  returned: number;
  /** Present gold values. */
  expected: number;
}

export type MismatchReason =
  | 'wrong'
  | 'type'
  | 'missing'
  | 'hallucinated'
  | 'missing-record'
  | 'extra-record'
  | 'shape';

export interface Mismatch {
  /**
   * JSON pointer into the gold ("/price", "/3/price", "/3" for a whole
   * record). Output records without a gold partner are "output:/<index>".
   */
  path: string;
  expected: unknown;
  got: unknown;
  reason: MismatchReason;
}

export interface ScoreOptions {
  /** Extra fields to skip, on top of those the schema marks x-derived. */
  derivedFields?: string[];
  /** Relative tolerance for non-integer numbers. Default 0.005 (0.5 %). */
  numberTolerance?: number;
}

export interface ScoreResult {
  id: string;
  valuePrecision: number;
  valueRecall: number;
  /** Array fixtures only. */
  recordPrecision?: number;
  recordRecall?: number;
  fieldScores: Record<string, FieldScore>;
  mismatches: Mismatch[];
  /** Mismatches beyond MAX_MISMATCHES (counted, not listed). */
  mismatchesOmitted: number;
  hallucinatedNulls: number;
  correctNulls: number;
  /** Output had the expected shape (a single-key wrapper object around the record array is accepted). */
  shapeOk: boolean;
  /** Derived fields that were not scored. */
  skippedFields: string[];
  counts: {
    correct: number;
    returned: number;
    expected: number;
    recordsExpected: number;
    recordsReturned: number;
    recordsMatched: number;
  };
}

export type ScorableFixture = Pick<Fixture, 'id' | 'gold' | 'schema' | 'expectedShape' | 'recordKey'>;

export const DEFAULT_NUMBER_TOLERANCE = 0.005;
export const MAX_MISMATCHES = 1_000;
/** Above this many candidate pairs within one duplicate-key group, pair in order instead of by agreement. */
const MAX_PAIRING_WORK = 10_000;
const PREVIEW_CHARS = 200;

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

export function scoreExtraction(fixture: ScorableFixture, output: unknown, opts: ScoreOptions = {}): ScoreResult {
  const tolerance = opts.numberTolerance ?? DEFAULT_NUMBER_TOLERANCE;
  const schemaInfo = schemaFields(fixture.schema);
  const derived = new Set([...schemaInfo.derived, ...(opts.derivedFields ?? [])]);
  const goldRecords = goldRecordsOf(fixture);
  const universe = fieldUniverse(schemaInfo.names, goldRecords);
  const fields = universe.filter((f) => !derived.has(f));
  const unwrapped = unwrapOutput(output, fixture.expectedShape, new Set(universe));
  const acc = new Accumulator(fields, tolerance, fixture.gold === null);

  if (!unwrapped.shapeOk) acc.mismatch(() => ({ path: '', expected: fixture.expectedShape, got: describeShape(output), reason: 'shape' }));

  if (fixture.expectedShape === 'array') {
    const key = fixture.recordKey;
    if (key === undefined) throw new Error(`${fixture.id}: array fixtures need a recordKey`);
    const pairs = matchRecords(goldRecords, unwrapped.records, key, fields, tolerance);
    for (const [gi, oi] of pairs.matched) acc.pair(goldRecords[gi], unwrapped.records[oi] as Record<string, unknown>, `/${gi}`);
    for (const gi of pairs.unmatchedGold) acc.missingRecord(goldRecords[gi], `/${gi}`, keyValue(goldRecords[gi], key));
    for (const oi of pairs.unmatchedOutput) acc.extraRecord(unwrapped.records[oi], `output:/${oi}`, key);
    acc.records(goldRecords.length, unwrapped.records.length, pairs.matched.length);
  } else if (goldRecords.length === 1 && unwrapped.records.length === 1 && isPlainObject(unwrapped.records[0])) {
    acc.pair(goldRecords[0], unwrapped.records[0], '');
  } else {
    goldRecords.forEach((g) => acc.missingRecord(g, '', null));
    unwrapped.records.forEach((r, i) => acc.extraRecord(r, `output:/${i}`, undefined));
  }

  return acc.result(fixture, unwrapped.shapeOk, [...derived].filter((f) => schemaInfo.names.includes(f) || hasGoldField(goldRecords, f)), fixture.expectedShape === 'array');
}

// ─────────────────────────────────────────────────────────────
// Accumulation
// ─────────────────────────────────────────────────────────────

class Accumulator {
  private readonly scores = new Map<string, FieldScore>();
  private readonly mismatches: Mismatch[] = [];
  private omitted = 0;
  private hallucinated = 0;
  private correctNulls = 0;
  private recordCounts = { recordsExpected: 0, recordsReturned: 0, recordsMatched: 0 };

  constructor(
    private readonly fields: string[],
    private readonly tolerance: number,
    /** Gold is null: every returned value is a hallucination. */
    private readonly goldIsNull: boolean,
  ) {
    for (const f of fields) this.scores.set(f, { correct: 0, returned: 0, expected: 0 });
  }

  /** Takes a thunk so previews are not built for mismatches beyond the cap. */
  mismatch(make: () => Mismatch): void {
    if (this.mismatches.length < MAX_MISMATCHES) this.mismatches.push(make());
    else this.omitted++;
  }

  pair(gold: Record<string, unknown>, out: Record<string, unknown>, base: string): void {
    for (const f of this.fields) {
      const expected = ownValue(gold, f);
      const got = ownValue(out, f);
      const score = this.scores.get(f)!;
      const path = `${base}/${escapePointer(f)}`;
      const e = !isAbsent(expected);
      const g = !isAbsent(got);
      if (!e && !g) {
        this.correctNulls++;
      } else if (!e) {
        score.returned++;
        this.hallucinated++;
        this.mismatch(() => ({ path, expected: null, got: preview(got), reason: 'hallucinated' }));
      } else if (!g) {
        score.expected++;
        this.mismatch(() => ({ path, expected, got: preview(got ?? null), reason: 'missing' }));
      } else {
        score.expected++;
        score.returned++;
        if (valuesEqual(expected, got, this.tolerance)) score.correct++;
        else this.mismatch(() => ({ path, expected, got: preview(got), reason: sameJsonType(expected, got) ? 'wrong' : 'type' }));
      }
    }
  }

  missingRecord(gold: Record<string, unknown>, path: string, key: unknown): void {
    for (const f of this.fields) if (!isAbsent(ownValue(gold, f))) this.scores.get(f)!.expected++;
    this.mismatch(() => ({ path, expected: key ?? preview(gold), got: null, reason: 'missing-record' }));
  }

  extraRecord(record: unknown, path: string, key: string | undefined): void {
    if (isPlainObject(record)) {
      for (const f of this.fields) {
        if (isAbsent(ownValue(record, f))) continue;
        this.scores.get(f)!.returned++;
        if (this.goldIsNull) this.hallucinated++;
      }
    }
    this.mismatch(() => {
      const keyed = key !== undefined && isPlainObject(record) && !isAbsent(ownValue(record, key));
      return { path, expected: null, got: preview(keyed ? ownValue(record, key) : record), reason: 'extra-record' };
    });
  }

  records(expected: number, returned: number, matched: number): void {
    this.recordCounts = { recordsExpected: expected, recordsReturned: returned, recordsMatched: matched };
  }

  result(fixture: ScorableFixture, shapeOk: boolean, skippedFields: string[], isArray: boolean): ScoreResult {
    let correct = 0;
    let returned = 0;
    let expected = 0;
    for (const s of this.scores.values()) {
      correct += s.correct;
      returned += s.returned;
      expected += s.expected;
    }
    const result: ScoreResult = {
      id: fixture.id,
      valuePrecision: ratio(correct, returned),
      valueRecall: ratio(correct, expected),
      // fromEntries defines own properties, so a field named "__proto__" stays data.
      fieldScores: Object.fromEntries(this.scores),
      mismatches: this.mismatches,
      mismatchesOmitted: this.omitted,
      hallucinatedNulls: this.hallucinated,
      correctNulls: this.correctNulls,
      shapeOk,
      skippedFields,
      counts: { correct, returned, expected, ...this.recordCounts },
    };
    if (isArray) {
      result.recordPrecision = ratio(this.recordCounts.recordsMatched, this.recordCounts.recordsReturned);
      result.recordRecall = ratio(this.recordCounts.recordsMatched, this.recordCounts.recordsExpected);
    }
    return result;
  }
}

/** Vacuous ratios are 1: nothing returned means nothing wrong was claimed. */
function ratio(num: number, den: number): number {
  return den === 0 ? 1 : num / den;
}

// ─────────────────────────────────────────────────────────────
// Shapes and records
// ─────────────────────────────────────────────────────────────

function goldRecordsOf(fixture: ScorableFixture): Array<Record<string, unknown>> {
  const gold = fixture.gold;
  if (gold === null) return [];
  if (fixture.expectedShape === 'array') {
    if (!Array.isArray(gold) || !gold.every(isPlainObject)) throw new Error(`${fixture.id}: array gold must be an array of objects`);
    return gold;
  }
  if (!isPlainObject(gold)) throw new Error(`${fixture.id}: object gold must be an object or null`);
  return [gold];
}

interface Unwrapped {
  records: unknown[];
  shapeOk: boolean;
}

/**
 * Turns the output into a list of candidate records. null/undefined means "no
 * data" (a legitimate answer, not a shape error). For array fixtures an object
 * holding exactly one array under a key that is not a record field (the
 * customer's wrapper key, or an envelope such as {records: [...]}) is
 * unwrapped; a lone record with one array field ({name, images: [...]}) is not.
 * For object fixtures a one-record array is accepted as that record but
 * flagged, since the engine should honour the shape.
 */
function unwrapOutput(output: unknown, shape: Fixture['expectedShape'], recordFields: ReadonlySet<string>): Unwrapped {
  if (output === null || output === undefined) return { records: [], shapeOk: true };
  if (shape === 'array') {
    if (Array.isArray(output)) return { records: output, shapeOk: true };
    if (isPlainObject(output)) {
      const arrays = Object.keys(output).filter((k) => Array.isArray(output[k]));
      if (arrays.length === 1 && !recordFields.has(arrays[0])) return { records: output[arrays[0]] as unknown[], shapeOk: true };
      return { records: [output], shapeOk: false };
    }
    return { records: [], shapeOk: false };
  }
  if (isPlainObject(output)) return { records: [output], shapeOk: true };
  if (Array.isArray(output)) return { records: output, shapeOk: false };
  return { records: [], shapeOk: false };
}

function describeShape(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return 'null';
  return typeof value;
}

interface Matching {
  matched: Array<[number, number]>;
  unmatchedGold: number[];
  unmatchedOutput: number[];
}

/** Pairs gold and output records by normalized recordKey; see the header comment. */
export function matchRecords(
  gold: Array<Record<string, unknown>>,
  output: unknown[],
  key: string,
  fields: string[] = [],
  tolerance = DEFAULT_NUMBER_TOLERANCE,
): Matching {
  const goldGroups = groupByKey(gold, key);
  const outGroups = groupByKey(output, key);
  const matched: Array<[number, number]> = [];
  const usedOut = new Set<number>();
  const usedGold = new Set<number>();
  for (const [k, gis] of goldGroups) {
    const ois = outGroups.get(k);
    if (!ois) continue;
    for (const [gi, oi] of pairGroup(gis, ois, gold, output, fields, tolerance)) {
      matched.push([gi, oi]);
      usedGold.add(gi);
      usedOut.add(oi);
    }
  }
  matched.sort((a, b) => a[0] - b[0]);
  return {
    matched,
    unmatchedGold: gold.map((_, i) => i).filter((i) => !usedGold.has(i)),
    unmatchedOutput: output.map((_, i) => i).filter((i) => !usedOut.has(i)),
  };
}

function groupByKey(records: unknown[], key: string): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  records.forEach((record, i) => {
    if (!isPlainObject(record)) return;
    const k = scalarKey(ownValue(record, key));
    if (k === null) return;
    const list = groups.get(k);
    if (list) list.push(i);
    else groups.set(k, [i]);
  });
  return groups;
}

/**
 * Pairs records sharing a key. With duplicates, the pairs that agree on the
 * most fields are taken first, so [A $5, A $6] vs [A $6, A $5] scores fully.
 * Ties and oversized groups fall back to document order.
 */
function pairGroup(
  gis: number[],
  ois: number[],
  gold: Array<Record<string, unknown>>,
  output: unknown[],
  fields: string[],
  tolerance: number,
): Array<[number, number]> {
  const n = Math.min(gis.length, ois.length);
  // One-to-one needs no choice; with one side single the other may still hold
  // a better partner than the first (gold [A $5, A $6] vs output [A $6]).
  const trivial = gis.length === 1 && ois.length === 1;
  if (trivial || gis.length * ois.length > MAX_PAIRING_WORK || fields.length === 0) {
    return gis.slice(0, n).map((gi, i) => [gi, ois[i]]);
  }
  const candidates: Array<{ gi: number; oi: number; score: number; order: number }> = [];
  let order = 0;
  for (const gi of gis) {
    for (const oi of ois) {
      const out = output[oi] as Record<string, unknown>;
      let score = 0;
      for (const f of fields) {
        const e = ownValue(gold[gi], f);
        const g = ownValue(out, f);
        if (isAbsent(e) ? isAbsent(g) : !isAbsent(g) && valuesEqual(e, g, tolerance)) score++;
      }
      candidates.push({ gi, oi, score, order: order++ });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  const usedG = new Set<number>();
  const usedO = new Set<number>();
  const pairs: Array<[number, number]> = [];
  for (const c of candidates) {
    if (usedG.has(c.gi) || usedO.has(c.oi)) continue;
    usedG.add(c.gi);
    usedO.add(c.oi);
    pairs.push([c.gi, c.oi]);
    if (pairs.length === n) break;
  }
  return pairs;
}

function keyValue(record: Record<string, unknown>, key: string): unknown {
  return ownValue(record, key) ?? null;
}

function fieldUniverse(schemaNames: string[], goldRecords: Array<Record<string, unknown>>): string[] {
  const fields = new Set(schemaNames);
  for (const r of goldRecords) for (const k of Object.keys(r)) fields.add(k);
  return [...fields];
}

function hasGoldField(goldRecords: Array<Record<string, unknown>>, field: string): boolean {
  return goldRecords.some((r) => Object.hasOwn(r, field));
}

// ─────────────────────────────────────────────────────────────
// Schema reading (record-level field names and derived flags)
// ─────────────────────────────────────────────────────────────

export interface SchemaFieldInfo {
  names: string[];
  derived: string[];
}

/**
 * Record-level field names of a customer schema, mirroring how the engine
 * reads it: shorthand ({"price": "number — ..."}), JSON Schema objects,
 * top-level arrays of objects, and an object wrapping exactly one array of
 * objects ({"books": [{...}]} or {"properties": {"books": {"type": "array", ...}}}).
 * allOf/$ref composition is not followed; corpus schemas do not use it.
 */
export function schemaFields(schema: Record<string, unknown>): SchemaFieldInfo {
  const record = recordSchemaOf(schema);
  const names: string[] = [];
  const derived: string[] = [];
  for (const [name, sub] of Object.entries(record.properties)) {
    names.push(name);
    if (isPlainObject(sub) && sub['x-derived'] === true) derived.push(name);
  }
  return { names, derived };
}

function recordSchemaOf(schema: Record<string, unknown>): { properties: Record<string, unknown> } {
  if (isJsonSchemaRoot(schema)) {
    if (!isPlainObject(schema.properties) && isPlainObject(schema.items)) return recordSchemaOf(schema.items);
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const names = Object.keys(properties);
    if (names.length === 1) {
      const only = properties[names[0]];
      if (isPlainObject(only) && isPlainObject(only.items) && isPlainObject(only.items.properties)) {
        return { properties: only.items.properties };
      }
    }
    return { properties };
  }
  const names = Object.keys(schema);
  if (names.length === 1) {
    const only = schema[names[0]];
    if (Array.isArray(only) && only.length === 1 && isPlainObject(only[0])) return recordSchemaOf(only[0]);
  }
  return { properties: schema };
}

function isJsonSchemaRoot(schema: Record<string, unknown>): boolean {
  if (isPlainObject(schema.properties) || typeof schema.$schema === 'string') return true;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.includes('object') || types.includes('array');
}

// ─────────────────────────────────────────────────────────────
// Comparators
// ─────────────────────────────────────────────────────────────

export function isAbsent(value: unknown): boolean {
  // Arrays look one level deep only: output is untrusted and may nest (or, in
  // memory, cycle) arbitrarily.
  if (Array.isArray(value)) return value.every(isAbsentScalar);
  return isAbsentScalar(value);
}

function isAbsentScalar(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === 'string' && value.trim() === '';
}

/** Compares one output value against one gold value (see the header comment). */
export function valuesEqual(expected: unknown, got: unknown, tolerance = DEFAULT_NUMBER_TOLERANCE): boolean {
  if (isAbsent(expected)) return isAbsent(got);
  if (typeof expected === 'number') return typeof got === 'number' && numbersEqual(expected, got, tolerance);
  if (typeof expected === 'boolean') return got === expected;
  if (typeof expected === 'string') return typeof got === 'string' && stringsEqual(expected, got);
  if (Array.isArray(expected)) return Array.isArray(got) && arraysEqual(expected, got, tolerance);
  if (isPlainObject(expected)) {
    if (!isPlainObject(got)) return false;
    return Object.keys(expected).every((k) => valuesEqual(expected[k], ownValue(got, k), tolerance));
  }
  return false;
}

export function numbersEqual(expected: number, got: number, tolerance = DEFAULT_NUMBER_TOLERANCE): boolean {
  if (!Number.isFinite(expected) || !Number.isFinite(got)) return false;
  if (Number.isInteger(expected)) return got === expected;
  return Math.abs(got - expected) <= tolerance * Math.abs(expected);
}

export function stringsEqual(expected: string, got: string): boolean {
  if (isAbsoluteHttpUrl(expected)) {
    const a = normalizeUrl(expected);
    const b = normalizeUrl(got);
    return a !== null && a === b;
  }
  const ta = isoInstant(expected);
  if (ta !== null) {
    const tb = isoInstant(got);
    if (tb !== null) return ta === tb;
  }
  return normalizeText(expected) === normalizeText(got);
}

function arraysEqual(expected: unknown[], got: unknown[], tolerance: number): boolean {
  const exp = expected.filter((v) => !isAbsent(v));
  const out = got.filter((v) => !isAbsent(v));
  if (exp.every(isScalar) && out.every(isScalar)) {
    if (exp.some((v) => typeof v === 'number' && !Number.isInteger(v))) return multisetEqual(exp, out, tolerance);
    const a = new Set(exp.map(scalarKey));
    const b = new Set(out.map(scalarKey));
    return a.size === b.size && [...a].every((k) => b.has(k));
  }
  return multisetEqual(exp, out, tolerance);
}

/** Unordered one-to-one matching; quadratic, so bounded. */
function multisetEqual(expected: unknown[], got: unknown[], tolerance: number): boolean {
  if (expected.length !== got.length) return false;
  if (expected.length * got.length > MAX_PAIRING_WORK) return expected.every((v, i) => valuesEqual(v, got[i], tolerance));
  const used = new Set<number>();
  return expected.every((v) => {
    const j = got.findIndex((g, i) => !used.has(i) && valuesEqual(v, g, tolerance));
    if (j < 0) return false;
    used.add(j);
    return true;
  });
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Normalized identity of a scalar, used for record keys and set comparison.
 * Type-prefixed so "1" and 1 stay distinct. null for absent/non-scalar values.
 */
export function scalarKey(value: unknown): string | null {
  if (isAbsent(value)) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? `n:${value}` : null;
  if (typeof value === 'boolean') return `b:${value}`;
  if (typeof value !== 'string') return null;
  if (isAbsoluteHttpUrl(value)) {
    const url = normalizeUrl(value);
    if (url !== null) return `u:${url}`;
  }
  const instant = isoInstant(value);
  if (instant !== null) return `t:${instant}`;
  return `s:${normalizeText(value)}`;
}

// Quote-like characters (straight, curly, low-9, primes, guillemets, backtick,
// acute) all become "'"; dash-like characters become "-".
const QUOTES = /["'`«´»‘-‟′-‷‹›❛-❞＂＇]/g;
const DASHES = /[‐-―−﹘﹣－]/g;
// Zero-width space/joiners, word joiner, BOM and soft hyphen are invisible.
const INVISIBLE = /[​-‍⁠﻿­]/g;

/** NFKC, invisible characters removed, quotes/dashes unified, whitespace collapsed, lowercase. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(QUOTES, "'")
    .replace(DASHES, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function isAbsoluteHttpUrl(text: string): boolean {
  return /^https?:\/\/[^\s/?#]/i.test(text.trim());
}

/**
 * Canonical form of an absolute URL: lowercase scheme/host and no default port
 * (WHATWG URL does both), no fragment or credentials, percent-encoded
 * unreserved characters decoded, other escapes upper-cased, no trailing slash
 * except for the root path, query parameters sorted. null for relative or
 * unparseable input.
 */
export function normalizeUrl(text: string): string | null {
  const trimmed = text.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  let path = normalizeEscapes(url.pathname);
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  let search = '';
  if (url.search.length > 1) {
    url.searchParams.sort();
    search = normalizeEscapes(url.search);
  }
  return `${url.protocol}//${url.host}${path}${search}`;
}

function normalizeEscapes(text: string): string {
  return text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}

// Full ISO 8601 date-time with an explicit offset; without one the instant is ambiguous.
const ISO_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/i;

/** Epoch ms of an ISO date-time with offset, or null. */
export function isoInstant(text: string): number | null {
  const m = ISO_DATE_TIME.exec(text.trim());
  if (!m) return null;
  const [, date, time, fraction, zone] = m;
  const offset = zone.toUpperCase() === 'Z' ? 'Z' : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const ms = fraction ? `.${fraction.slice(0, 3).padEnd(3, '0')}` : '';
  const seconds = time.length === 5 ? `${time}:00` : time;
  const t = Date.parse(`${date}T${seconds}${ms}${offset}`);
  return Number.isNaN(t) ? null : t;
}

function sameJsonType(a: unknown, b: unknown): boolean {
  return jsonType(a) === jsonType(b);
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// ─────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────

export interface AggregateRow {
  id: string;
  valuePrecision: number;
  valueRecall: number;
  recordPrecision?: number;
  recordRecall?: number;
  hallucinatedNulls: number;
  mismatches: number;
  shapeOk: boolean;
}

export interface AggregateSummary {
  fixtures: number;
  /** From summed counts: every value weighs the same (a 600-record listing dominates). */
  micro: { valuePrecision: number; valueRecall: number; f1: number };
  /** Mean of per-fixture ratios: every fixture weighs the same. */
  macro: { valuePrecision: number; valueRecall: number; f1: number };
  /** Summed record counts over array fixtures; absent when there were none. */
  records?: { precision: number; recall: number; fixtures: number };
  hallucinatedNulls: number;
  shapeErrors: number;
  counts: { correct: number; returned: number; expected: number };
  /** Per field name across fixtures ("price" pools every fixture's price). */
  byField: Record<string, FieldScore & { precision: number; recall: number }>;
  rows: AggregateRow[];
}

/** Summary over many fixture scores. With no results every ratio is 0, so an empty run never passes a threshold. */
export function aggregate(results: ScoreResult[]): AggregateSummary {
  const totals = { correct: 0, returned: 0, expected: 0 };
  const byField = new Map<string, FieldScore>();
  const rec = { matched: 0, returned: 0, expected: 0, fixtures: 0 };
  let hallucinated = 0;
  let shapeErrors = 0;
  for (const r of results) {
    totals.correct += r.counts.correct;
    totals.returned += r.counts.returned;
    totals.expected += r.counts.expected;
    hallucinated += r.hallucinatedNulls;
    if (!r.shapeOk) shapeErrors++;
    if (r.recordPrecision !== undefined) {
      rec.fixtures++;
      rec.matched += r.counts.recordsMatched;
      rec.returned += r.counts.recordsReturned;
      rec.expected += r.counts.recordsExpected;
    }
    for (const [field, s] of Object.entries(r.fieldScores)) {
      const t = byField.get(field) ?? { correct: 0, returned: 0, expected: 0 };
      t.correct += s.correct;
      t.returned += s.returned;
      t.expected += s.expected;
      byField.set(field, t);
    }
  }
  const empty = results.length === 0;
  const microP = empty ? 0 : ratio(totals.correct, totals.returned);
  const microR = empty ? 0 : ratio(totals.correct, totals.expected);
  const macroP = empty ? 0 : mean(results.map((r) => r.valuePrecision));
  const macroR = empty ? 0 : mean(results.map((r) => r.valueRecall));
  const summary: AggregateSummary = {
    fixtures: results.length,
    micro: { valuePrecision: microP, valueRecall: microR, f1: f1(microP, microR) },
    macro: { valuePrecision: macroP, valueRecall: macroR, f1: f1(macroP, macroR) },
    hallucinatedNulls: hallucinated,
    shapeErrors,
    counts: totals,
    byField: Object.fromEntries(
      [...byField].map(([f, s]) => [f, { ...s, precision: ratio(s.correct, s.returned), recall: ratio(s.correct, s.expected) }]),
    ),
    rows: results.map((r) => {
      const row: AggregateRow = {
        id: r.id,
        valuePrecision: r.valuePrecision,
        valueRecall: r.valueRecall,
        hallucinatedNulls: r.hallucinatedNulls,
        mismatches: r.mismatches.length + r.mismatchesOmitted,
        shapeOk: r.shapeOk,
      };
      if (r.recordPrecision !== undefined) row.recordPrecision = r.recordPrecision;
      if (r.recordRecall !== undefined) row.recordRecall = r.recordRecall;
      return row;
    }),
  };
  if (rec.fixtures > 0) {
    summary.records = { precision: ratio(rec.matched, rec.returned), recall: ratio(rec.matched, rec.expected), fixtures: rec.fixtures };
  }
  return summary;
}

/** Fixed-width text table of an aggregate, for logs and CI output. */
export function formatSummary(summary: AggregateSummary): string {
  const pct = (v: number | undefined): string => (v === undefined ? '-' : `${(v * 100).toFixed(1)}%`);
  const header = ['fixture', 'value P', 'value R', 'record P', 'record R', 'halluc.', 'mismatches', 'shape'];
  const rows = summary.rows.map((r) => [
    r.id,
    pct(r.valuePrecision),
    pct(r.valueRecall),
    pct(r.recordPrecision),
    pct(r.recordRecall),
    String(r.hallucinatedNulls),
    String(r.mismatches),
    r.shapeOk ? 'ok' : 'WRONG',
  ]);
  rows.push([
    `micro (${summary.fixtures})`,
    pct(summary.micro.valuePrecision),
    pct(summary.micro.valueRecall),
    pct(summary.records?.precision),
    pct(summary.records?.recall),
    String(summary.hallucinatedNulls),
    '',
    String(summary.shapeErrors),
  ]);
  rows.push(['macro', pct(summary.macro.valuePrecision), pct(summary.macro.valueRecall), '', '', '', '', '']);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]): string => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function f1(p: number, r: number): number {
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

// ─────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────

/** Own property only: an output field named "constructor" must not read Object.prototype. */
function ownValue(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Short stand-in for large values in mismatch reports. */
function preview(value: unknown): unknown {
  if (typeof value === 'string') return value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS)}…` : value;
  if (typeof value !== 'object' || value === null) return value;
  let json: string;
  try {
    json = JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable]';
  }
  return json.length > PREVIEW_CHARS ? `${json.slice(0, PREVIEW_CHARS)}…` : value;
}
