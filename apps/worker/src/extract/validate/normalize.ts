// Raw extracted value → typed value, entirely in code.
//
// The model (or a recipe, or structured data) reports values as printed on the
// page: "£51.77", "In stock (22 available)", "/catalogue/x.html". This module
// performs every conversion and reports the steps it applied, so evidence can
// say exactly how a value was produced. It never guesses: two different
// numbers in one price ("$10 - $20") are 'ambiguous', "Free" is
// 'unparseable', and an object where a number belongs is a 'type_mismatch'.

import type { FieldSpec, FieldType, JsonSchema } from '../types.js';
import { readAvailability, readWorkplace, workplaceTopic } from './booleans.js';
import {
  findNumericTokens,
  hasCurrencyMarker,
  isCurrencyWord,
  parseLocaleNumber,
  stripCurrencySymbols,
  type NumericToken,
} from './numbers.js';

export { findNumericTokens, localeNumberCandidates, parseLocaleNumber } from './numbers.js';
export type { LocaleNumberOptions, NumericToken } from './numbers.js';

export interface NormalizeContext {
  /** Page URL; relative URLs in URL-like fields resolve against it. */
  baseUrl: string;
  /**
   * Decimal separator of the page, when known (e.g. from <html lang>). Only
   * consulted for the ambiguous "1,234" / "1.234" shape.
   */
  decimalSeparator?: '.' | ',';
}

export type NormalizeFailureReason = 'ambiguous' | 'unparseable' | 'type_mismatch';

export type NormalizeResult =
  | { ok: true; value: unknown; steps: string[] }
  | { ok: false; reason: NormalizeFailureReason; detail: string };

// A single number, boolean or URL never needs more text than this; longer
// input is a mis-extraction, and the limits keep every regex below cheap.
const MAX_NUMBER_TEXT = 200;
const MAX_BOOLEAN_TEXT = 100;
const MAX_URL_LENGTH = 8_192;
/** Object/array levels whose leaves are normalized by their sub-schema types. */
const MAX_NESTED_DEPTH = 8;

export function normalizeValue(raw: unknown, field: FieldSpec, ctx: NormalizeContext): NormalizeResult {
  return normalizeAt(raw, field, ctx, 0);
}

function normalizeAt(raw: unknown, field: FieldSpec, ctx: NormalizeContext, depth: number): NormalizeResult {
  if (isEmpty(raw)) return ok(null, ['empty']);
  switch (field.type) {
    case 'number':
    case 'integer':
      return normalizeNumber(raw, field.type === 'integer', ctx);
    case 'boolean':
      return normalizeBoolean(raw, field);
    case 'string':
      return normalizeString(raw, field, ctx);
    case 'array':
      return normalizeArray(raw, field, ctx, depth);
    case 'object':
      return normalizeObject(raw, field, ctx, depth);
    default:
      // Untyped fields pass through; the validator judges them.
      return ok(raw, []);
  }
}

function isEmpty(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
}

// ─────────────────────────────────────────────────────────────
// Numbers
// ─────────────────────────────────────────────────────────────

const NUMBER_WORDS = new Map([
  ['zero', 0], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
]);

/** Words allowed around a spelled-out number ("Three stars", "rated four out of five"). */
const RATING_WORDS = new Set(['star', 'stars', 'rating', 'rated', 'out', 'of', 'score', 'points', 'point']);

// Lower-case "m" is left out on purpose: "5m" is metres or minutes as often
// as millions.
const LETTER_SCALE = /^([kKMB])(?!\p{L})/u;
const WORD_SCALE = /^ ?(thousand|million|billion|mn|bn|mio|mrd|tsd|lakh|lac|crore)(?!\p{L})/iu;
// "mil" is a thousand in Spanish/Portuguese and a million in English shorthand.
const AMBIGUOUS_SCALE = /^ ?mil(?!\p{L})/iu;
const SCALE: Record<string, number> = {
  k: 1e3, K: 1e3, M: 1e6, B: 1e9, thousand: 1e3, million: 1e6, mn: 1e6, billion: 1e9, bn: 1e9,
  mio: 1e6, mrd: 1e9, tsd: 1e3, lakh: 1e5, lac: 1e5, crore: 1e7,
};
const SCALE_WORDS = new Set(['k', 'm', 'b', 'mil', ...Object.keys(SCALE).map((k) => k.toLowerCase())]);

function normalizeNumber(raw: unknown, integer: boolean, ctx: NormalizeContext): NormalizeResult {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return fail('unparseable', 'number is not finite');
    if (integer && !Number.isInteger(raw)) return fail('type_mismatch', `${raw} is not an integer`);
    return ok(raw, []);
  }
  if (typeof raw !== 'string') return fail('type_mismatch', `expected a number, got ${describe(raw)}`);
  // Length is checked before and after cleaning so huge inputs never reach NFKC.
  const text = raw.length > MAX_NUMBER_TEXT * 4 ? raw : cleanText(raw);
  if (text.length > MAX_NUMBER_TEXT) return fail('unparseable', 'text is too long to be a single number');

  const steps: string[] = [];
  if (hasCurrencyMarker(text)) steps.push('strip-currency');
  const tokens = findNumericTokens(text, 8);

  if (tokens.length === 0) {
    const spelled = parseNumberWords(text);
    if (spelled === null) return fail('unparseable', `no number in ${quote(text)}`);
    steps.push('number-word');
    return finishNumber(spelled, steps, integer);
  }

  if (tokens.length === 2 && isRatingScale(text, tokens)) {
    const rating = readToken(text, tokens[0], integer, ctx);
    if (rating === 'ambiguous') return fail('ambiguous', `unclear scale word in ${quote(text)}`);
    if (!rating) return fail('unparseable', `malformed number ${quote(tokens[0].text)}`);
    steps.push('rating-scale');
    return finishNumber(rating.value, steps, integer);
  }

  const readings: Reading[] = [];
  for (const token of tokens) {
    const reading = readToken(text, token, integer, ctx);
    if (reading === 'ambiguous') return fail('ambiguous', `unclear scale word in ${quote(text)}`);
    if (!reading) return fail('unparseable', `malformed number ${quote(token.text)}`);
    readings.push(reading);
  }
  const distinct = [...new Set(readings.map((r) => r.value))];
  if (distinct.length > 1) {
    return fail('ambiguous', `several numbers in ${quote(text)}: ${distinct.slice(0, 3).join(', ')}`);
  }
  if (hasExtraWords(text, tokens)) steps.push('extract-number');
  steps.push(...readings[0].steps);
  return finishNumber(readings[0].value, steps, integer);
}

interface Reading {
  value: number;
  steps: string[];
}

function readToken(text: string, token: NumericToken, integer: boolean, ctx: NormalizeContext): Reading | null | 'ambiguous' {
  const after = text.slice(token.end, token.end + 12);
  if (AMBIGUOUS_SCALE.test(after)) return 'ambiguous';
  const scale = LETTER_SCALE.exec(after) ?? WORD_SCALE.exec(after);
  // "1.2K": the separator is a decimal point whatever the field type.
  const parsed = parseLocaleNumber(token.text, { integer: integer && !scale, decimal: ctx.decimalSeparator });
  if (parsed === null) return null;
  let value = token.negative ? -parsed : parsed;
  const steps: string[] = [];
  if (scale) {
    const multiplier = SCALE[scale[1]] ?? SCALE[scale[1].toLowerCase()];
    value = Number((value * multiplier).toPrecision(15));
    steps.push('scale-suffix');
  } else if (/^ ?%/.test(after)) {
    steps.push('percent');
  }
  return { value: value === 0 ? 0 : value, steps };
}

/** "4.5 out of 5", "4/5", "3 of 5 stars": the first number is the value. */
function isRatingScale(text: string, [value, scale]: NumericToken[]): boolean {
  const between = text.slice(value.end, scale.start).trim().toLowerCase();
  if (between !== 'out of' && between !== 'of' && between !== '/') return false;
  const a = parseLocaleNumber(value.text);
  const b = parseLocaleNumber(scale.text);
  return a !== null && b !== null && b > 0 && a <= b && !value.negative && !scale.negative;
}

function parseNumberWords(text: string): number | null {
  const words: string[] = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length === 0 || words.length > 6) return null;
  const numbers = words.filter((w) => NUMBER_WORDS.has(w));
  if (numbers.length === 0 || !words.every((w) => NUMBER_WORDS.has(w) || RATING_WORDS.has(w))) return null;
  if (numbers.length === 1) return NUMBER_WORDS.get(numbers[0])!;
  // "four out of five"
  if (numbers.length === 2 && words.includes('of')) return NUMBER_WORDS.get(numbers[0])!;
  return null;
}

/** True when text other than currency, scale and sign remains around the numbers. */
function hasExtraWords(text: string, tokens: NumericToken[]): boolean {
  let residual = '';
  let from = 0;
  for (const token of tokens) {
    residual += `${text.slice(from, token.start)} `;
    from = token.end;
  }
  residual += text.slice(from);
  for (const m of stripCurrencySymbols(residual).matchAll(/\p{L}+/gu)) {
    const word = m[0];
    if (!isCurrencyWord(word) && !SCALE_WORDS.has(word.toLowerCase())) return true;
  }
  return false;
}

function finishNumber(value: number, steps: string[], integer: boolean): NormalizeResult {
  if (integer && !Number.isInteger(value)) return fail('type_mismatch', `${value} is not an integer`);
  steps.push(integer ? 'parse-integer' : 'parse-number');
  return ok(value, steps);
}

// ─────────────────────────────────────────────────────────────
// Booleans
// ─────────────────────────────────────────────────────────────

// The lexicons live in booleans.ts: availability for any boolean field, the
// remote/on-site lexicon only for fields about remote work.

function normalizeBoolean(raw: unknown, field: FieldSpec): NormalizeResult {
  if (typeof raw === 'boolean') return ok(raw, []);
  if (typeof raw === 'number') {
    if (raw === 1 || raw === 0) return ok(raw === 1, ['parse-boolean']);
    return fail('unparseable', `${raw} is not a yes/no value`);
  }
  if (typeof raw !== 'string') return fail('type_mismatch', `expected a boolean, got ${describe(raw)}`);
  const text = raw.length > MAX_BOOLEAN_TEXT * 4 ? raw : cleanText(raw).toLowerCase();
  if (text.length > MAX_BOOLEAN_TEXT) return fail('unparseable', 'text is too long for a yes/no value');
  const workplace = workplaceTopic(field);
  const parsed = workplace ? readWorkplace(text, workplace) : readAvailability(text);
  if (parsed === 'ambiguous') {
    return fail('ambiguous', workplace ? `no clear remote/on-site answer in ${quote(text)}` : `both available and unavailable in ${quote(text)}`);
  }
  if (parsed === null) return fail('unparseable', `not a yes/no value: ${quote(text)}`);
  return ok(parsed, ['parse-boolean']);
}

// ─────────────────────────────────────────────────────────────
// Strings and URLs
// ─────────────────────────────────────────────────────────────

const URL_FORMATS = new Set(['uri', 'url', 'uri-reference', 'iri', 'iri-reference']);
const URL_NAME_WORDS = new Set([
  'url', 'urls', 'uri', 'link', 'links', 'href', 'src', 'image', 'images', 'img', 'thumbnail', 'thumb',
  'photo', 'photos', 'picture', 'logo', 'avatar', 'icon', 'website', 'homepage', 'permalink',
]);
// "imageAlt", "linkText", "imageCount" are about a URL-ish thing but are not URLs.
const NON_URL_NAME_WORDS = new Set([
  'text', 'alt', 'title', 'caption', 'label', 'name', 'count', 'number', 'width', 'height', 'size', 'type', 'description', 'desc',
]);

function normalizeString(raw: unknown, field: FieldSpec, ctx: NormalizeContext): NormalizeResult {
  const steps: string[] = [];
  let value: string;
  if (typeof raw === 'string') {
    value = raw;
  } else if ((typeof raw === 'number' && Number.isFinite(raw)) || typeof raw === 'boolean') {
    value = String(raw);
    steps.push('to-string');
  } else {
    return fail('type_mismatch', `expected a string, got ${describe(raw)}`);
  }
  const trimmed = value.trim();
  if (trimmed !== value) steps.push('trim');
  const collapsed = trimmed.replace(/\s+/g, ' ');
  if (collapsed !== trimmed) steps.push('collapse-whitespace');
  value = collapsed;

  if (isUrlField(field)) {
    const absolute = absoluteUrl(value, ctx.baseUrl);
    if (absolute !== null && absolute !== value) {
      value = absolute;
      steps.push('absolute-url');
    }
  }
  const matched = matchEnum(value, field.schema);
  if (matched !== undefined && matched !== value) {
    value = matched;
    steps.push('enum-match');
  }
  return ok(value, steps);
}

export function isUrlField(field: Pick<FieldSpec, 'name' | 'description' | 'schema'>): boolean {
  const format = field.schema?.format;
  if (typeof format === 'string' && URL_FORMATS.has(format.toLowerCase())) return true;
  const words = field.name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((w) => NON_URL_NAME_WORDS.has(w))) return false;
  if (words.some((w) => URL_NAME_WORDS.has(w))) return true;
  return typeof field.description === 'string' && /\b(?:url|uri|href|link|hyperlink)s?\b/i.test(field.description);
}

/**
 * Resolves a relative reference against the page URL. Values that already
 * have a scheme (https:, mailto:, data:) are left alone, as is anything that
 * does not look like a URL reference (contains whitespace, plain words) so a
 * mis-labelled text field is never turned into a fake link. "www.x.com" is
 * left alone too: resolving it as a path would invent a URL.
 */
function absoluteUrl(value: string, baseUrl: string): string | null {
  if (value.length > MAX_URL_LENGTH || /\s/.test(value)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || /^www\./i.test(value)) return null;
  const pathLike =
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('?') ||
    value.startsWith('#') ||
    value.includes('/') ||
    /\.[a-z0-9]{2,5}(?:[?#]|$)/i.test(value);
  if (!pathLike) return null;
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Maps "In Stock" onto an enum value "in_stock" when exactly one value matches loosely. */
function matchEnum(value: string, schema: JsonSchema | undefined): string | undefined {
  const values = schema?.enum;
  if (!Array.isArray(values) || values.includes(value)) return undefined;
  const key = looseKey(value);
  const hits = values.filter((v): v is string => typeof v === 'string' && looseKey(v) === key);
  return hits.length === 1 ? hits[0] : undefined;
}

function looseKey(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────
// Arrays
// ─────────────────────────────────────────────────────────────

const SCALAR_TYPES: ReadonlySet<FieldType> = new Set(['string', 'number', 'integer', 'boolean', 'unknown']);

function normalizeArray(raw: unknown, field: FieldSpec, ctx: NormalizeContext, depth: number): NormalizeResult {
  const itemType = field.itemType ?? 'unknown';
  const itemField: FieldSpec = {
    name: field.name,
    type: itemType,
    required: false,
    nullable: false,
    derived: field.derived,
    schema: itemSchema(field.schema),
  };
  if (field.description !== undefined) itemField.description = field.description;

  const steps: string[] = [];
  let items: unknown[];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string') {
    if (!SCALAR_TYPES.has(itemType)) {
      return fail('type_mismatch', `expected an array of ${itemType} values, got a string`);
    }
    const split = splitList(raw, itemType, ctx);
    items = split.parts;
    steps.push(split.split ? 'split-list' : 'wrap-array');
  } else if (typeof raw === 'number' || typeof raw === 'boolean') {
    items = [raw];
    steps.push('wrap-array');
  } else {
    return fail('type_mismatch', `expected an array, got ${describe(raw)}`);
  }

  const out: unknown[] = [];
  let dropped = false;
  for (let i = 0; i < items.length; i++) {
    const result = normalizeAt(items[i], itemField, ctx, depth + 1);
    if (!result.ok) return fail(result.reason, `item ${i}: ${result.detail}`);
    if (result.value === null) {
      dropped = true;
      continue;
    }
    out.push(result.value);
    for (const step of result.steps) if (!steps.includes(step)) steps.push(step);
  }
  if (dropped) steps.push('drop-empty-items');
  return ok(out, steps);
}

// ─────────────────────────────────────────────────────────────
// Objects
// ─────────────────────────────────────────────────────────────

/**
 * Normalizes the leaves of an object by the types its schema declares for
 * them ("Yes" for a nested boolean, "$1,299.00" for a nested number). Keys
 * without a declared type, and non-object values, pass through for the
 * validator to judge. Empty leaves are left as they are (a nested null is
 * not introduced where the sub-schema may not allow it).
 */
function normalizeObject(raw: unknown, field: FieldSpec, ctx: NormalizeContext, depth: number): NormalizeResult {
  if (!isPlainObject(raw) || depth >= MAX_NESTED_DEPTH) return ok(raw, []);
  const properties = field.schema?.properties;
  if (!isPlainObject(properties)) return ok(raw, []);
  const steps: string[] = [];
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(raw)) {
    const sub = Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : undefined;
    const type = isPlainObject(sub) ? declaredType(sub) : 'unknown';
    if (type === 'unknown' || isEmpty(value)) {
      entries.push([key, value]);
      continue;
    }
    const subField: FieldSpec = { name: key, type, required: false, nullable: true, derived: field.derived, schema: sub as JsonSchema };
    if (type === 'array') subField.itemType = declaredType(itemSchema(sub as JsonSchema));
    const description = (sub as JsonSchema).description;
    if (typeof description === 'string') subField.description = description;
    const result = normalizeAt(value, subField, ctx, depth + 1);
    if (!result.ok) return fail(result.reason, `property ${quote(key)}: ${result.detail}`);
    entries.push([key, result.value]);
    for (const step of result.steps) if (!steps.includes(step)) steps.push(step);
  }
  // fromEntries defines own properties: a key named "__proto__" stays data.
  return ok(Object.fromEntries(entries), steps);
}

const DECLARED_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

/** The one non-null type a sub-schema declares (or implies by properties/items); 'unknown' otherwise. */
function declaredType(schema: JsonSchema): FieldType {
  const t = schema.type;
  const types = (typeof t === 'string' ? [t] : Array.isArray(t) ? t : []).filter((x): x is string => typeof x === 'string' && x !== 'null');
  if (types.length === 1) return DECLARED_TYPES.has(types[0]) ? (types[0] as FieldType) : 'unknown';
  if (types.length > 1) return 'unknown';
  if (isPlainObject(schema.properties)) return 'object';
  if (isPlainObject(schema.items)) return 'array';
  return 'unknown';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function itemSchema(schema: JsonSchema | undefined): JsonSchema {
  const items = schema?.items;
  if (items && typeof items === 'object' && !Array.isArray(items)) return items as JsonSchema;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema?.[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const inner = (branch as JsonSchema | null)?.items;
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as JsonSchema;
    }
  }
  return {};
}

/**
 * Splits a string into list items on the strongest separator present:
 * newline, then ";", then "|", then ",". For numbers a comma followed by
 * exactly three digits is a thousands separator, not a list separator.
 */
function splitList(raw: string, itemType: FieldType, ctx: NormalizeContext): { parts: string[]; split: boolean } {
  const text = raw.trim();
  let parts: string[];
  if (/[\r\n]/.test(text)) parts = text.split(/[\r\n]+/);
  else if (text.includes(';')) parts = text.split(';');
  else if (text.includes('|')) parts = text.split('|');
  else if (text.includes(',')) parts = isNumeric(itemType) ? splitNumberList(text, ctx) : text.split(',');
  else parts = [text];
  return { parts: parts.map((p) => p.trim()).filter((p) => p !== ''), split: parts.length > 1 };
}

function splitNumberList(text: string, ctx: NormalizeContext): string[] {
  // With a comma decimal separator only ", " can separate items ("1,5, 2,5").
  if (ctx.decimalSeparator === ',') return text.split(/, +/);
  return text.split(/,(?!\d{3}(?!\d))/);
}

function isNumeric(type: FieldType): boolean {
  return type === 'number' || type === 'integer';
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** NFKC (fullwidth digits, NBSP and thin spaces → ASCII), collapsed whitespace. */
function cleanText(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function ok(value: unknown, steps: string[]): NormalizeResult {
  return { ok: true, value, steps };
}

function fail(reason: NormalizeFailureReason, detail: string): NormalizeResult {
  return { ok: false, reason, detail };
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

function quote(text: string): string {
  return JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text);
}
