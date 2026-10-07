// Agreement checks between recipe output and grounded reference results, and
// output invariants for an active recipe.
//
// A candidate recipe is promoted only after it reproduces grounded LLM results
// on several snapshots (compareOutputs), and an active recipe's output is
// accepted only while it still looks like what was validated
// (checkInvariants). Values are compared after normalization: strings ignore
// case and whitespace, numbers agree within 0.5% (relative), and a string is
// compared with a number or boolean through the same parser the engine uses
// to normalize values.

import type { FieldSpec, StoredRecipe } from '../types.js';
import { normalizeValue } from '../validate/normalize.js';

export interface CompareResult {
  agree: boolean;
  /** Agreeing (field, record) pairs / compared pairs; pairs empty on both sides are not compared. */
  fieldAgreement: number;
  /** Recipe record count / reference record count (array data only). */
  recordCountRatio?: number;
  details: string[];
}

export interface InvariantResult {
  ok: boolean;
  reasons: string[];
}

export const AGREEMENT_THRESHOLD = 0.9;
const NUMBER_TOLERANCE = 0.005;
const RECORD_COUNT_TOLERANCE = 0.1;
const MAX_COMPARED_RECORDS = 20;
const REQUIRED_FILL_RATE = 0.9;
const MAX_DETAILS = 20;
const MAX_TEXT_COMPARE_CHARS = 20_000;
/** Nesting followed when comparing arrays/objects (data comes from model output). */
const MAX_DEPTH = 32;

export function compareOutputs(recipeData: unknown, referenceData: unknown, fieldNames: string[]): CompareResult {
  const details: string[] = [];
  const tally = { compared: 0, agreed: 0 };
  let recordCountRatio: number | undefined;
  let countOk = true;

  if (Array.isArray(recipeData) && Array.isArray(referenceData)) {
    const rc = recipeData.length;
    const ref = referenceData.length;
    recordCountRatio = ref === 0 ? (rc === 0 ? 1 : Number.POSITIVE_INFINITY) : rc / ref;
    countOk = Math.abs(rc - ref) <= RECORD_COUNT_TOLERANCE * ref;
    if (!countOk) details.push(`record count ${rc} vs reference ${ref}`);
    const n = Math.min(rc, ref, MAX_COMPARED_RECORDS);
    for (let i = 0; i < n; i++) compareRecord(recipeData[i], referenceData[i], fieldNames, `/${i}`, tally, details);
  } else if (isRecord(recipeData) && isRecord(referenceData)) {
    compareRecord(recipeData, referenceData, fieldNames, '', tally, details);
  } else {
    details.push(`shape mismatch: recipe ${describeShape(recipeData)}, reference ${describeShape(referenceData)}`);
    return { agree: false, fieldAgreement: 0, details };
  }

  if (tally.compared === 0) details.push('no non-empty values to compare');
  const fieldAgreement = tally.compared === 0 ? 0 : tally.agreed / tally.compared;
  const agree = countOk && tally.compared > 0 && fieldAgreement >= AGREEMENT_THRESHOLD;
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
    if (valuesAgree(x, y)) tally.agreed++;
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

export function valuesAgree(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (isEmptyValue(a) || isEmptyValue(b)) return isEmptyValue(a) && isEmptyValue(b);
  if (typeof a === 'number' || typeof b === 'number') {
    const x = asNumber(a);
    const y = asNumber(b);
    return x !== null && y !== null && numbersAgree(x, y);
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
    return x.length === y.length && x.every((v, i) => valuesAgree(v, y[i], depth + 1));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!valuesAgree(ownValue(a, k), ownValue(b, k), depth + 1)) return false;
    return true;
  }
  return false;
}

function numbersAgree(x: number, y: number): boolean {
  if (x === y) return true;
  return Math.abs(x - y) <= NUMBER_TOLERANCE * Math.max(Math.abs(x), Math.abs(y));
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
