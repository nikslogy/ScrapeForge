// Agreement checks between recipe output and grounded reference results, and
// output invariants for an active recipe.
//
// A candidate recipe is saved and promoted only after it reproduces grounded
// LLM results exactly on several snapshots (compareOutputs: every compared
// value of every record must match), and an active recipe's output is
// accepted only while it still looks like what was validated
// (checkInvariants). Values are compared after normalization: strings ignore
// case and whitespace, and a string is compared with a number or boolean
// through the same parser the engine uses to normalize values. Numbers must be
// equal for compareOutputs (valuesMatch); valuesAgree is a looser check (0.5%)
// for conflict warnings, never for trusting a recipe.

import type { FieldSpec, StoredRecipe } from '../types.js';
import { normalizeValue } from '../validate/normalize.js';
import { RECIPE_LIMITS } from './limits.js';

export interface CompareResult {
  /** Every compared pair matches (and there was at least one). */
  agree: boolean;
  /** Matching (field, record) pairs / compared pairs; pairs empty on both sides are not compared. */
  fieldAgreement: number;
  /** Recipe record count / reference record count (array data only). */
  recordCountRatio?: number;
  details: string[];
}

export interface InvariantResult {
  ok: boolean;
  reasons: string[];
}

/** Share of compared pairs that must match: all of them (one wrong value in a listing is a wrong recipe). */
export const AGREEMENT_THRESHOLD = 1;
/** Loose tolerance of valuesAgree (conflict warnings only). */
const NUMBER_TOLERANCE = 0.005;
/** Float noise allowed by valuesMatch (same value parsed along different paths). */
const NUMBER_EPSILON = 1e-9;
/** Records beyond this are not verified, so a longer listing cannot agree. */
const MAX_COMPARED_RECORDS = RECIPE_LIMITS.defaultMaxRecords;
const REQUIRED_FILL_RATE = 0.9;
const MAX_DETAILS = 20;
/** Longest value a recipe can yield, so the whole value is compared. */
const MAX_TEXT_COMPARE_CHARS = RECIPE_LIMITS.maxValueChars;
/** Nesting followed when comparing arrays/objects (data comes from model output). */
const MAX_DEPTH = 32;

/**
 * Exact agreement of a recipe's output with a grounded reference: records are
 * paired by position (a record missing on one side counts as empty), every
 * listed field that is non-empty on either side is compared with valuesMatch,
 * and a single mismatch means no agreement.
 */
export function compareOutputs(recipeData: unknown, referenceData: unknown, fieldNames: string[]): CompareResult {
  const details: string[] = [];
  const tally = { compared: 0, agreed: 0 };
  let recordCountRatio: number | undefined;
  let complete = true;

  if (Array.isArray(recipeData) && Array.isArray(referenceData)) {
    const rc = recipeData.length;
    const ref = referenceData.length;
    recordCountRatio = ref === 0 ? (rc === 0 ? 1 : Number.POSITIVE_INFINITY) : rc / ref;
    if (rc !== ref) details.push(`record count ${rc} vs reference ${ref}`);
    const n = Math.max(rc, ref);
    if (n > MAX_COMPARED_RECORDS) {
      complete = false;
      details.push(`${n} records: more than the ${MAX_COMPARED_RECORDS} that can be compared`);
    }
    for (let i = 0; i < Math.min(n, MAX_COMPARED_RECORDS); i++) {
      compareRecord(recipeData[i], referenceData[i], fieldNames, `/${i}`, tally, details);
    }
  } else if (isRecord(recipeData) && isRecord(referenceData)) {
    compareRecord(recipeData, referenceData, fieldNames, '', tally, details);
  } else {
    details.push(`shape mismatch: recipe ${describeShape(recipeData)}, reference ${describeShape(referenceData)}`);
    return { agree: false, fieldAgreement: 0, details };
  }

  if (tally.compared === 0) details.push('no non-empty values to compare');
  const fieldAgreement = tally.compared === 0 ? 0 : tally.agreed / tally.compared;
  const agree = complete && tally.compared > 0 && tally.agreed === tally.compared;
  const result: CompareResult = { agree, fieldAgreement, details };
  if (recordCountRatio !== undefined) result.recordCountRatio = recordCountRatio;
  return result;
}

function compareRecord(
  recipe: unknown,
  reference: unknown,
  fieldNames: string[],
  prefix: string,
  tally: { compared: number; agreed: number },
  details: string[],
): void {
  const a = isRecord(recipe) ? recipe : {};
  const b = isRecord(reference) ? reference : {};
  for (const name of fieldNames) {
    const x = ownValue(a, name);
    const y = ownValue(b, name);
    if (isEmptyValue(x) && isEmptyValue(y)) continue;
    tally.compared++;
    if (valuesMatch(x, y)) tally.agreed++;
    else if (details.length < MAX_DETAILS) details.push(`${prefix}/${name}: ${preview(x)} vs ${preview(y)}`);
  }
}

function ownValue(record: Record<string, unknown>, name: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, name) ? record[name] : undefined;
}

// ─────────────────────────────────────────────────────────────
// Value agreement
// ─────────────────────────────────────────────────────────────

const NUMBER_SPEC: FieldSpec = { name: 'value', type: 'number', required: false, nullable: true, derived: false, schema: { type: 'number' } };
const BOOLEAN_SPEC: FieldSpec = { name: 'value', type: 'boolean', required: false, nullable: true, derived: false, schema: { type: 'boolean' } };

/** Same value after normalization (numbers equal up to float noise). Used to trust a recipe. */
export function valuesMatch(a: unknown, b: unknown): boolean {
  return agreeWith(a, b, NUMBER_EPSILON, 0);
}

/** Loose agreement (numbers within 0.5%), for conflict warnings; never for trusting a recipe. */
export function valuesAgree(a: unknown, b: unknown, depth = 0): boolean {
  return agreeWith(a, b, NUMBER_TOLERANCE, depth);
}

function agreeWith(a: unknown, b: unknown, tolerance: number, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (isEmptyValue(a) || isEmptyValue(b)) return isEmptyValue(a) && isEmptyValue(b);
  if (typeof a === 'number' || typeof b === 'number') {
    const x = asNumber(a);
    const y = asNumber(b);
    return x !== null && y !== null && numbersAgree(x, y, tolerance);
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const x = asBoolean(a);
    const y = asBoolean(b);
    return x !== null && x === y;
  }
  if (typeof a === 'string' && typeof b === 'string') return normalizeText(a) === normalizeText(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    const x = a.filter((v) => !isEmptyValue(v));
    const y = b.filter((v) => !isEmptyValue(v));
    return x.length === y.length && x.every((v, i) => agreeWith(v, y[i], tolerance, depth + 1));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!agreeWith(ownValue(a, k), ownValue(b, k), tolerance, depth + 1)) return false;
    return true;
  }
  return false;
}

function numbersAgree(x: number, y: number, tolerance: number): boolean {
  if (x === y) return true;
  return Math.abs(x - y) <= tolerance * Math.max(Math.abs(x), Math.abs(y));
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const r = normalizeValue(v, NUMBER_SPEC, { baseUrl: 'http://localhost/' });
  return r.ok && typeof r.value === 'number' ? r.value : null;
}

function asBoolean(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return null;
  const r = normalizeValue(v, BOOLEAN_SPEC, { baseUrl: 'http://localhost/' });
  return r.ok && typeof r.value === 'boolean' ? r.value : null;
}

function normalizeText(s: string): string {
  const capped = s.length > MAX_TEXT_COMPARE_CHARS ? s.slice(0, MAX_TEXT_COMPARE_CHARS) : s;
  return capped.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** null, undefined, NaN, blank strings, empty arrays and empty objects carry no value. */
export function isEmptyValue(v: unknown, depth = 0): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'number') return Number.isNaN(v);
  if (Array.isArray(v)) return depth < MAX_DEPTH && v.every((item) => isEmptyValue(item, depth + 1));
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function describeShape(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

function preview(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

// ─────────────────────────────────────────────────────────────
// Invariants of an active recipe's output
// ─────────────────────────────────────────────────────────────

/**
 * Drift guard for an active recipe: each required field must be filled in
 * ≥ 90% of records (all of them for an object), and the record count must
 * stay within [0.5 × min, 2 × max] of the range seen during validation.
 */
export function checkInvariants(stored: StoredRecipe, output: { data: unknown; recordCount: number }): InvariantResult {
  const reasons: string[] = [];
  const required = stored.requiredFields;
  if (stored.recipe.shape === 'array') {
    if (!Array.isArray(output.data)) {
      reasons.push('expected an array of records');
      return { ok: false, reasons };
    }
    const records = output.data;
    const n = records.length;
    if (n === 0) reasons.push('no records extracted');
    for (const name of required) {
      if (n === 0) break;
      let filled = 0;
      for (const r of records) if (isRecord(r) && !isEmptyValue(ownValue(r, name))) filled++;
      if (filled / n < REQUIRED_FILL_RATE) reasons.push(`required field "${name}" filled in ${filled} of ${n} records`);
    }
    const range = stored.recordCount;
    const count = output.recordCount;
    if (range && n > 0 && (count < 0.5 * range.min || count > 2 * range.max)) {
      reasons.push(`record count ${count} outside the validated range ${range.min}-${range.max}`);
    }
  } else {
    if (!isRecord(output.data)) {
      reasons.push('expected an object');
      return { ok: false, reasons };
    }
    const record = output.data;
    for (const name of required) {
      if (isEmptyValue(ownValue(record, name))) reasons.push(`required field "${name}" is empty`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}
