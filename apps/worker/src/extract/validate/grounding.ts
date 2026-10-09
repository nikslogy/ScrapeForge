// Grounding: is a raw extracted value actually present in the source?
//
// Text on both sides is normalized the same way (NFKC, lowercase, unified
// quotes/dashes, no zero-width chars, collapsed whitespace). Then:
//   • numbers and numeric-looking strings ("£51.77", "1.024", "15%") match
//     whole numeric tokens of the source by value, in every plausible locale
//     reading, so "1" is never grounded by "10", "1.5" or "2021";
//   • short strings (≤ 120 chars) match as a substring that starts and ends on
//     word boundaries ("Red" is not found in "Bored");
//   • long strings use word-bigram overlap (≥ 0.6). Bigrams rather than single
//     words: a large page contains most common words, so single-word overlap
//     would ground fabricated paragraphs.
// Locations are searched block → attrs → record → document; 'document' means
// the value exists on the page but outside the cited block/record. 'record'
// covers the record's text and the evidence attributes of the blocks inside
// it (recordAttrs): an attribute-only value (class="star-rating Three", an
// href) cited from a sibling block of the same card is still verified. Numbers
// are looked up only in value-carrying attributes there (aria-label, content,
// value, title, alt, datetime, data-*), never in class names or URLs, so "4"
// is not "grounded" by class="col-4" or href="/p/4".
//
// Source texts are prepared once (prepareText, LRU-cached by string) with
// lazily built indexes, so checking many fields against one large document
// costs one normalization pass plus set lookups.

import { findNumericTokens, isCurrencyWord, localeNumberCandidates, stripCurrencySymbols } from './numbers.js';

export type GroundingLocation = 'block' | 'attrs' | 'record' | 'document' | 'none';

export interface GroundingResult {
  grounded: boolean;
  where: GroundingLocation;
  /** 1 for exact matches, the bigram overlap ratio for long text, 0.8 for digit-sequence matches. */
  score: number;
}

/** Raw text, or text already passed through prepareText (cheaper for large documents). */
export type GroundingText = string | PreparedText;

export interface GroundingContext {
  blockText?: GroundingText;
  attrs?: Record<string, string>;
  recordText?: GroundingText;
  /** Evidence attributes of the blocks of the cited block's record (see blockContext). */
  recordAttrs?: ReadonlyArray<Readonly<Record<string, string>>>;
  documentText?: GroundingText;
}

export interface GroundingOptions {
  /** Declared inference (x-derived): not checked, reported as not grounded. */
  derived?: boolean;
}

export const SHORT_TEXT_MAX_CHARS = 120;
export const LONG_TEXT_MIN_OVERLAP = 0.6;
const DIGIT_SEQUENCE_SCORE = 0.8;
const MAX_NESTING = 8;

const NOT_GROUNDED: GroundingResult = Object.freeze({ grounded: false, where: 'none', score: 0 }) as GroundingResult;
// Nothing to verify (null, "", []): nothing was claimed, so nothing is rejected.
const VACUOUS: GroundingResult = Object.freeze({ grounded: true, where: 'none', score: 1 }) as GroundingResult;

const LOCATION_RANK: Record<GroundingLocation, number> = { none: -1, block: 0, attrs: 1, record: 2, document: 3 };

/**
 * Checks whether `raw` (the value as reported by the model, before
 * normalization) occurs in the cited source. Arrays and objects are grounded
 * when every non-empty member is; their score is the grounded fraction.
 */
export function checkGrounding(raw: unknown, ctx: GroundingContext, opts: GroundingOptions = {}): GroundingResult {
  if (opts.derived) return { ...NOT_GROUNDED };
  return { ...checkValue(raw, new Locations(ctx), 0) };
}

function checkValue(raw: unknown, locations: Locations, depth: number): GroundingResult {
  if (raw === null || raw === undefined) return VACUOUS;
  if (typeof raw === 'string') return checkString(raw, locations);
  if (typeof raw === 'number') return Number.isFinite(raw) ? locations.firstHit((p) => numericScore(p, [raw]), true) : NOT_GROUNDED;
  // A boolean has no printed form to look for; the page said "In stock".
  if (depth >= MAX_NESTING || !(Array.isArray(raw) || isPlainObject(raw))) return NOT_GROUNDED;
  const entries: Array<[string | null, unknown]> = Array.isArray(raw) ? raw.map((v) => [null, v]) : Object.entries(raw);
  let counted = 0;
  let grounded = 0;
  // Farthest location any member needed; stays 'none' if every member was vacuous.
  let where: GroundingLocation = 'none';
  for (const [key, member] of entries) {
    if (member === null || member === undefined || member === '') continue;
    let result: GroundingResult;
    if (typeof member === 'boolean') {
      // A boolean leaf (the response schema asks for a real boolean inside
      // objects) is checked by the property it answers ("Wireless: Yes" for
      // wireless); when the page does not name it, it neither grounds nor
      // rejects the value: the other members decide.
      const named = key === null ? null : keyPhrase(key);
      result = named ? checkString(named, locations) : VACUOUS;
      if (!result.grounded || result.where === 'none') continue;
    } else {
      result = checkValue(member, locations, depth + 1);
    }
    counted++;
    if (!result.grounded) continue;
    grounded++;
    if (LOCATION_RANK[result.where] > LOCATION_RANK[where]) where = result.where;
  }
  if (counted === 0) return VACUOUS;
  const all = grounded === counted;
  return { grounded: all, where: all ? where : 'none', score: grounded / counted };
}

/** "freeShipping" / "free_shipping" → "free shipping"; null for keys with no words. */
function keyPhrase(key: string): string | null {
  const phrase = key
    .slice(0, SHORT_TEXT_MAX_CHARS)
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim();
  return /\p{L}/u.test(phrase) ? phrase : null;
}

function checkString(raw: string, locations: Locations): GroundingResult {
  const needle = normalizeForMatch(raw);
  if (needle === '') return VACUOUS;
  const numbers = numericCandidates(needle);
  if (numbers) return locations.firstHit((p) => numericScore(p, numbers), true);
  if (needle.length <= SHORT_TEXT_MAX_CHARS) return locations.firstHit((p) => (containsBounded(p, needle) ? 1 : 0));
  return checkLongText(needle, locations);
}

function checkLongText(needle: string, locations: Locations): GroundingResult {
  const tokens = wordTokens(needle);
  const bigrams = new Set<number>();
  for (let i = 1; i < tokens.length; i++) bigrams.add(bigramKey(tokens[i - 1], tokens[i]));
  let best = 0;
  for (const { where, prepared } of locations.each()) {
    if (containsBounded(prepared, needle)) return { grounded: true, where, score: 1 };
    if (bigrams.size === 0) continue;
    const index = prepared.bigrams();
    let hits = 0;
    for (const key of bigrams) if (index.has(key)) hits++;
    const ratio = hits / bigrams.size;
    if (ratio >= LONG_TEXT_MIN_OVERLAP) return { grounded: true, where, score: round3(ratio) };
    best = Math.max(best, ratio);
  }
  return { grounded: false, where: 'none', score: round3(best) };
}

// ─────────────────────────────────────────────────────────────
// Prepared source text
// ─────────────────────────────────────────────────────────────

/**
 * Normalized source text with lazily built lookup indexes. Create with
 * prepareText(); the constructor expects already-normalized text.
 */
export class PreparedText {
  private numberIndex?: Set<string>;
  private digitRunIndex?: Set<string>;
  private wordIndex?: Set<string>;
  private bigramIndex?: Set<number>;

  constructor(readonly text: string) {}

  /** Absolute values of every number in the text, in every plausible reading. */
  numbers(): Set<string> {
    if (!this.numberIndex) this.buildNumberIndexes();
    return this.numberIndex!;
  }

  /** Separator-free digit runs ("1299" from superscript cents "12⁹⁹"). */
  digitRuns(): Set<string> {
    if (!this.digitRunIndex) this.buildNumberIndexes();
    return this.digitRunIndex!;
  }

  words(): Set<string> {
    this.wordIndex ??= new Set(wordTokens(this.text));
    return this.wordIndex;
  }

  bigrams(): Set<number> {
    if (!this.bigramIndex) {
      const tokens = wordTokens(this.text);
      const index = new Set<number>();
      for (let i = 1; i < tokens.length; i++) index.add(bigramKey(tokens[i - 1], tokens[i]));
      this.bigramIndex = index;
    }
    return this.bigramIndex;
  }

  private buildNumberIndexes(): void {
    const numbers = new Set<string>();
    const digitRuns = new Set<string>();
    for (const token of findNumericTokens(this.text)) {
      const readings = localeNumberCandidates(token.text);
      if (readings.length === 0 || /[ ']/.test(token.text)) {
        // Malformed lists ("10,20,30") and space-grouped numbers that may be
        // two numbers ("2 100") also index their parts.
        for (const part of token.text.split(/[.,' ]/)) if (part !== '') numbers.add(numberKey(Number(part)));
      }
      const multiplier = scaleAfter(this.text, token.end);
      for (const value of readings) {
        numbers.add(numberKey(value));
        if (multiplier !== 1) numbers.add(numberKey(value * multiplier));
      }
      if (/^\d+$/.test(token.text)) digitRuns.add(token.text);
    }
    this.numberIndex = numbers;
    this.digitRunIndex = digitRuns;
  }
}

// Budget counts raw + normalized chars (~2 bytes each). A single text may use
// half of it, so documents up to ~4M chars stay cached; larger ones should be
// prepared once by the caller and passed in as PreparedText.
const PREPARED_CACHE_MAX_ENTRIES = 64;
const PREPARED_CACHE_MAX_CHARS = 16_000_000;
const preparedCache = new Map<string, PreparedText>();
let preparedChars = 0;
// One slot for a text too large for the LRU: the common case is a single huge
// document checked field after field, which must not be re-normalized each time.
let oversized: { text: string; prepared: PreparedText } | null = null;
const preparedAttrs = new WeakMap<Record<string, string>, PreparedText>();
const preparedRecordAttrs = new WeakMap<object, { all: PreparedText; values: PreparedText }>();

/** Attributes whose values are data rather than styling or links. */
function isValueAttr(name: string): boolean {
  return VALUE_ATTRS.has(name) || name.startsWith('data-');
}
const VALUE_ATTRS = new Set(['aria-label', 'content', 'value', 'title', 'alt', 'datetime']);

/**
 * Normalizes `text` for matching. Results are cached by the raw string (LRU,
 * bounded by entries and total size), so passing the same documentText to
 * many checkGrounding calls normalizes it once.
 */
export function prepareText(text: GroundingText): PreparedText {
  if (text instanceof PreparedText) return text;
  const hit = preparedCache.get(text);
  if (hit) {
    preparedCache.delete(text);
    preparedCache.set(text, hit);
    return hit;
  }
  if (oversized && oversized.text === text) return oversized.prepared;
  const prepared = new PreparedText(normalizeForMatch(text));
  const cost = text.length + prepared.text.length;
  if (cost > PREPARED_CACHE_MAX_CHARS / 2) {
    oversized = { text, prepared };
  } else {
    preparedCache.set(text, prepared);
    preparedChars += cost;
    while (preparedCache.size > PREPARED_CACHE_MAX_ENTRIES || preparedChars > PREPARED_CACHE_MAX_CHARS) {
      const [oldText, old] = preparedCache.entries().next().value as [string, PreparedText];
      preparedCache.delete(oldText);
      preparedChars -= oldText.length + old.text.length;
    }
  }
  return prepared;
}

function prepareAttrs(attrs: Record<string, string>): PreparedText {
  let prepared = preparedAttrs.get(attrs);
  if (!prepared) {
    // Joined with a control char (removed from needles by normalization) so a
    // match can never span two attribute values.
    const values = Object.values(attrs).filter((v): v is string => typeof v === 'string');
    prepared = new PreparedText(values.map(normalizeForMatch).join('\u0001'));
    preparedAttrs.set(attrs, prepared);
  }
  return prepared;
}

function prepareRecordAttrs(list: ReadonlyArray<Readonly<Record<string, string>>>, numeric: boolean): PreparedText {
  let prepared = preparedRecordAttrs.get(list);
  if (!prepared) {
    const all: string[] = [];
    const values: string[] = [];
    for (const attrs of list) {
      if (!attrs || typeof attrs !== 'object') continue;
      for (const [name, v] of Object.entries(attrs)) {
        if (typeof v !== 'string' || v === '') continue;
        const text = normalizeForMatch(v);
        all.push(text);
        if (isValueAttr(name)) values.push(text);
      }
    }
    prepared = { all: new PreparedText(all.join('\u0001')), values: new PreparedText(values.join('\u0001')) };
    preparedRecordAttrs.set(list, prepared);
  }
  return numeric ? prepared.values : prepared.all;
}

/** Drops cached prepared texts (tests and memory-pressure hooks). */
export function clearPreparedTextCache(): void {
  preparedCache.clear();
  preparedChars = 0;
  oversized = null;
}

type Source = 'block' | 'attrs' | 'record' | 'recordAttrs' | 'recordAttrValues' | 'document';

const REPORTED_AS: Record<Source, Exclude<GroundingLocation, 'none'>> = {
  block: 'block',
  attrs: 'attrs',
  record: 'record',
  recordAttrs: 'record',
  recordAttrValues: 'record',
  document: 'document',
};

class Locations {
  private readonly prepared = new Map<Source, PreparedText | null>();

  constructor(private readonly ctx: GroundingContext) {}

  /** `numeric`: record attributes are limited to value-carrying ones. */
  *each(numeric = false): Generator<{ where: Exclude<GroundingLocation, 'none'>; prepared: PreparedText }> {
    for (const source of ['block', 'attrs', 'record', numeric ? 'recordAttrValues' : 'recordAttrs', 'document'] as const) {
      const prepared = this.get(source);
      if (prepared) yield { where: REPORTED_AS[source], prepared };
    }
  }

  firstHit(score: (p: PreparedText) => number, numeric = false): GroundingResult {
    for (const { where, prepared } of this.each(numeric)) {
      const s = score(prepared);
      if (s > 0) return { grounded: true, where, score: s };
    }
    return NOT_GROUNDED;
  }

  /** Prepared lazily: the document is only normalized if earlier locations miss. */
  private get(source: Source): PreparedText | null {
    if (this.prepared.has(source)) return this.prepared.get(source)!;
    let prepared: PreparedText | null = null;
    if (source === 'attrs') {
      if (this.ctx.attrs && typeof this.ctx.attrs === 'object') prepared = prepareAttrs(this.ctx.attrs);
    } else if (source === 'recordAttrs' || source === 'recordAttrValues') {
      if (Array.isArray(this.ctx.recordAttrs) && this.ctx.recordAttrs.length > 0) {
        prepared = prepareRecordAttrs(this.ctx.recordAttrs, source === 'recordAttrValues');
      }
    } else {
      const text = source === 'block' ? this.ctx.blockText : source === 'record' ? this.ctx.recordText : this.ctx.documentText;
      if (typeof text === 'string' || text instanceof PreparedText) prepared = prepareText(text);
    }
    this.prepared.set(source, prepared);
    return prepared;
  }
}

// ─────────────────────────────────────────────────────────────
// Text normalization and tokens
// ─────────────────────────────────────────────────────────────

const SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b\u2032\u00b4`\u2039\u203a]/g;
const DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g;
const DASHES = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g;
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]+/g;

/** The normalization applied to both values and source text before matching. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .replace(INVISIBLE, '')
    .replace(WHITESPACE_OR_CONTROL, ' ')
    .trim();
}

// Scripts written without spaces between words: every character is a token
// and imposes no word boundary.
const UNSPACED = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}';
const UNSPACED_CHAR = new RegExp(`[${UNSPACED}]`, 'u');
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const WORD_TOKEN = new RegExp(`[${UNSPACED}]|(?:(?![${UNSPACED}])[\\p{L}\\p{N}\\p{M}])+`, 'gu');

function wordTokens(text: string): string[] {
  return text.match(WORD_TOKEN) ?? [];
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch) && !UNSPACED_CHAR.test(ch);
}

function charBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const code = text.charCodeAt(index - 1);
  // Step over a surrogate pair so the full code point is classified.
  if (code >= 0xdc00 && code <= 0xdfff && index >= 2) return text.slice(index - 2, index);
  return text[index - 1];
}

function charAt(text: string, index: number): string | undefined {
  if (index >= text.length) return undefined;
  return String.fromCodePoint(text.codePointAt(index)!);
}

const PREFILTER_MIN_CHARS = 2_000;

/**
 * Substring match whose edges fall on word boundaries. Digits extend through
 * a "." or "," followed by another digit, so "4.5" does not end a match at "4".
 */
function containsBounded(prepared: PreparedText, needle: string): boolean {
  const hay = prepared.text;
  if (needle.length > hay.length) return false;
  // Every word of the needle must be a whole word of the source; checking the
  // word set first makes misses on large documents O(words in needle).
  if (hay.length >= PREFILTER_MIN_CHARS) {
    const words = prepared.words();
    for (const word of wordTokens(needle)) if (!words.has(word)) return false;
  }
  const first = charAt(needle, 0);
  const last = charBefore(needle, needle.length);
  const checkStart = isWordChar(first);
  const checkEnd = isWordChar(last);
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const end = i + needle.length;
    if (checkStart && !startBoundary(hay, i, first!)) continue;
    if (checkEnd && !endBoundary(hay, end, last!)) continue;
    return true;
  }
  return false;
}

function startBoundary(hay: string, start: number, first: string): boolean {
  const prev = charBefore(hay, start);
  if (isWordChar(prev)) return false;
  if (/\d/.test(first) && (prev === '.' || prev === ',') && /\d/.test(hay[start - 2] ?? '')) return false;
  return true;
}

function endBoundary(hay: string, end: number, last: string): boolean {
  const next = charAt(hay, end);
  if (isWordChar(next)) return false;
  if (/\d/.test(last) && (next === '.' || next === ',') && /\d/.test(hay[end + 1] ?? '')) return false;
  return true;
}

// FNV-1a over "a b"; 32-bit keys keep the bigram index of a large page small.
function bigramKey(a: string, b: string): number {
  let hash = 0x811c9dc5;
  const text = `${a} ${b}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ─────────────────────────────────────────────────────────────
// Numbers
// ─────────────────────────────────────────────────────────────

const SCALE_SUFFIX = /^(?:(k)(?!\p{L})| ?(thousand|million|billion|mn|bn|mio|mrd|tsd|lakh|lac|crore)(?!\p{L}))/u;
const SCALE_MULTIPLIER: Record<string, number> = {
  k: 1e3, thousand: 1e3, million: 1e6, mn: 1e6, billion: 1e9, bn: 1e9, mio: 1e6, mrd: 1e9, tsd: 1e3, lakh: 1e5, lac: 1e5, crore: 1e7,
};
// Characters allowed around the single number of a numeric-looking value.
const NUMERIC_DECORATION = /^[\s%()+\-\u2212.,:;'"/*~≈]*$/u;

/**
 * Candidate values when the needle is a single number with only currency,
 * sign, percent or scale decoration ("£51.77", "usd 12", "15%", "1.2k");
 * null when it is text that merely contains numbers.
 */
function numericCandidates(needle: string): number[] | null {
  const tokens = findNumericTokens(needle, 2);
  if (tokens.length !== 1) return null;
  const [token] = tokens;
  const residual = stripCurrencySymbols(`${needle.slice(0, token.start)} ${needle.slice(token.end)}`);
  for (const m of residual.matchAll(/\p{L}+/gu)) {
    if (!isCurrencyWord(m[0]) && !Object.hasOwn(SCALE_MULTIPLIER, m[0])) return null;
  }
  const decoration = residual.replace(/\p{L}+/gu, '');
  if (!NUMERIC_DECORATION.test(decoration)) return null;
  const readings = localeNumberCandidates(token.text);
  if (readings.length === 0) return null;
  const multiplier = scaleAfter(needle, token.end);
  return multiplier === 1 ? readings : [...readings, ...readings.map((v) => v * multiplier)];
}

function scaleAfter(text: string, end: number): number {
  const m = SCALE_SUFFIX.exec(text.slice(end, end + 10));
  if (!m) return 1;
  return SCALE_MULTIPLIER[m[1] ?? m[2]] ?? 1;
}

function numericScore(prepared: PreparedText, candidates: number[]): number {
  const index = prepared.numbers();
  for (const value of candidates) if (index.has(numberKey(value))) return 1;
  // Digit sequence: 12.99 printed as "12⁹⁹" (NFKC → "1299"). Only for values
  // with a fractional part and at least three digits, against separator-free
  // runs, so 1 is never matched by "10" and 0.1 never by "01".
  const runs = prepared.digitRuns();
  for (const value of candidates) {
    const digits = decimalDigits(value);
    if (digits !== null && runs.has(digits)) return DIGIT_SEQUENCE_SCORE;
  }
  return 0;
}

function decimalDigits(value: number): string | null {
  if (Number.isInteger(value)) return null;
  const text = String(Math.abs(value));
  if (/e/i.test(text)) return null;
  const [int, frac] = text.split('.');
  if (int === '0' || frac === undefined) return null;
  const digits = int + frac;
  return digits.length >= 3 ? digits : null;
}

/** Sign-insensitive key: "-20%" on the page grounds a discount reported as 20. */
function numberKey(value: number): string {
  return String(Math.round(Math.abs(value) * 1e6) / 1e6);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
