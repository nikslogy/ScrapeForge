// Is a structured-data value something a reader of the page actually sees?
//
// JSON-LD and embedded JSON can be stale or differ from the rendered page
// (a price changed, a variant was selected), so every mapped value carries a
// visibility flag and the engine decides what to trust.
//
// Text is compared as sequences of normalized word tokens (the same
// normalization as grounding: NFKC, case, quotes, dashes), looked up through
// an inverted index so thousands of records cost thousands of hash lookups,
// not thousands of scans of a large page. Numbers go through the grounding
// module's numeric index ("1,299.00" matches 1299). Long text uses word-bigram
// overlap. URLs are looked up among the page's link/image attributes, ISO
// dates and durations also in their common display forms.

import type { SourceDocument } from '../types.js';
import { checkGrounding, normalizeForMatch, prepareText, type PreparedText } from '../validate/grounding.js';
import { findNumericTokens, isCurrencyWord, stripCurrencySymbols } from '../validate/numbers.js';
import type { ValueKind } from './concepts.js';
import { STRUCTURED_LIMITS } from './limits.js';
import { looksLikeUrl, stripMarkup, urlKey, urlPathKey } from './text.js';

// Scripts written without spaces: every character is its own token.
const UNSPACED = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}';
const WORD = new RegExp(`[${UNSPACED}]|(?:(?![${UNSPACED}])[\\p{L}\\p{N}\\p{M}])+`, 'gu');

const MEMO_MAX_VALUE_CHARS = 512;
const MEMO_MAX_ENTRIES = 50_000;

/** Up to 24 tokens are matched as an exact sequence; longer text by bigram overlap. */
const SEQUENCE_MAX_TOKENS = 24;
const LONG_TEXT_MIN_OVERLAP = 0.6;

// Runs of ASCII letters/digits are words as they stand (the text is already
// lowercased); only runs containing other characters need the Unicode-aware
// WORD pattern. Most page text is ASCII, and WORD is several times slower.
const SEPARATORS = /[^a-z0-9\u0080-\uffff]+/;
const NON_ASCII = /[\u0080-\uffff]/;

function tokensOfNormalized(normalized: string, max: number): string[] {
  const runs = normalized.split(SEPARATORS);
  const ascii = !NON_ASCII.test(normalized);
  const out: string[] = [];
  for (const run of runs) {
    if (!run) continue;
    if (ascii || !NON_ASCII.test(run)) out.push(run);
    else for (const w of run.matchAll(WORD)) out.push(w[0]);
    if (out.length >= max) break;
  }
  return out.length > max ? out.slice(0, max) : out;
}

const ASCII_ONLY = /^[\x00-\x7f]*$/;

/**
 * Tokens of a value, normalized like the page text. For ASCII input,
 * lowercasing is all normalizeForMatch would change inside [a-z0-9] runs.
 */
export function wordTokens(text: string, max = Infinity): string[] {
  const clean = stripMarkup(text);
  return tokensOfNormalized(ASCII_ONLY.test(clean) ? clean.toLowerCase() : normalizeForMatch(clean), max);
}

// Cheap shape test before the locale-aware parse: one digit run with at most
// a short currency marker on either side.
const NUMERIC_SHAPE = /^[^\d]{0,12}\d[\d\s.,'\u2019]*[^\d]{0,12}$/u;

const numericCache = new Map<string, boolean>();
const NUMERIC_CACHE_MAX = 10_000;

/**
 * A single number with only currency/sign decoration: "51.77", "£1,299.00",
 * "USD 12", "12,99 €". Ranges, model numbers and prose are not numeric.
 */
export function isNumericLike(s: string): boolean {
  if (s.length > 64 || !NUMERIC_SHAPE.test(s)) return false;
  const cached = numericCache.get(s);
  if (cached !== undefined) return cached;
  const result = parsesAsSingleNumber(s);
  if (numericCache.size >= NUMERIC_CACHE_MAX) numericCache.clear();
  numericCache.set(s, result);
  return result;
}

function parsesAsSingleNumber(s: string): boolean {
  const t = s.normalize('NFKC').trim();
  if (!t) return false;
  const tokens = findNumericTokens(t, 2);
  if (tokens.length !== 1) return false;
  const [token] = tokens;
  const rest = stripCurrencySymbols(`${t.slice(0, token.start)} ${t.slice(token.end)}`);
  for (const m of rest.matchAll(/\p{L}+/gu)) if (!isCurrencyWord(m[0])) return false;
  return /^[\s+\-−.,:]*$/u.test(rest.replace(/\p{L}+/gu, ''));
}

// FNV-1a over "a b": compact numeric keys for the page bigram set.
function bigramKey(a: string, b: string): number {
  let hash = 0x811c9dc5;
  const text = `${a} ${b}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const MONTHS = [
  ['january', 'jan'],
  ['february', 'feb'],
  ['march', 'mar'],
  ['april', 'apr'],
  ['may', 'may'],
  ['june', 'jun'],
  ['july', 'jul'],
  ['august', 'aug'],
  ['september', 'sep', 'sept'],
  ['october', 'oct'],
  ['november', 'nov'],
  ['december', 'dec'],
];

function ordinal(d: number): string {
  if (d % 100 >= 11 && d % 100 <= 13) return `${d}th`;
  return `${d}${['th', 'st', 'nd', 'rd'][d % 10] ?? 'th'}`;
}

/** Display forms of an ISO date as token sequences ("March 1, 2024", "01/03/2024", ...). */
function dateSequences(y: string, mo: number, d: number): string[][] {
  const mm = String(mo).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  const days = [String(d), dd, ordinal(d)];
  const out: string[][] = [[y, mm, dd], [dd, mm, y], [mm, dd, y], [String(d), String(mo), y], [String(mo), String(d), y]];
  for (const name of MONTHS[mo - 1] ?? []) {
    for (const day of days) out.push([name, day, y], [day, name, y]);
  }
  return out;
}

// Pages print the symbol, structured data the ISO code.
const CURRENCY_SYMBOLS: Record<string, readonly string[]> = {
  USD: ['$'],
  CAD: ['$'],
  AUD: ['$'],
  NZD: ['$'],
  SGD: ['$'],
  HKD: ['$'],
  MXN: ['$'],
  GBP: ['£'],
  EUR: ['€'],
  JPY: ['¥', '円'],
  CNY: ['¥', '元'],
  INR: ['₹'],
  KRW: ['₩'],
  RUB: ['₽'],
  UAH: ['₴'],
  TRY: ['₺'],
  ILS: ['₪'],
  NGN: ['₦'],
  PHP: ['₱'],
  VND: ['₫'],
  THB: ['฿'],
  PLN: ['zł'],
  BRL: ['R$'],
  CHF: ['CHF', 'Fr.'],
};

const HOUR_UNITS = ['h', 'hr', 'hrs', 'hour', 'hours'];
const MINUTE_UNITS = ['m', 'min', 'mins', 'minute', 'minutes'];

/** Display forms of an ISO 8601 duration ("PT1H30M" → "1 hr 30 min", "90 minutes", "1h 30m"). */
function durationSequences(raw: string): string[][] {
  const m = /^P(?:(\d{1,4})D)?(?:T(?:(\d{1,4})H)?(?:(\d{1,5})M)?(?:(\d{1,6})S)?)?$/i.exec(raw.trim());
  if (!m || (!m[2] && !m[3] && !m[1])) return [];
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0) + days * 24;
  const minutes = Number(m[3] ?? 0);
  const out: string[][] = [];
  if (hours > 0 && minutes > 0) {
    for (const hu of HOUR_UNITS) for (const mu of MINUTE_UNITS) out.push([String(hours), hu, String(minutes), mu]);
    out.push([`${hours}h`, `${minutes}m`], [`${hours}h`, `${minutes}min`], [`${hours}hr`, `${minutes}min`]);
  } else if (hours > 0) {
    for (const hu of HOUR_UNITS) out.push([String(hours), hu]);
    out.push([`${hours}h`], [`${hours}hr`], [`${hours}hrs`]);
  }
  const total = hours * 60 + minutes;
  if (total > 0) {
    for (const mu of MINUTE_UNITS) out.push([String(total), mu]);
    out.push([`${total}m`], [`${total}min`], [`${total}mins`]);
  }
  return out;
}

/** "https://schema.org/InStock" → "in stock"; "FULL_TIME" → "full time"; "NewCondition" → also "new". */
function enumPhrases(raw: string): string[] {
  const t = raw.trim();
  const cut = Math.max(t.lastIndexOf('/'), t.lastIndexOf('#'), t.lastIndexOf(':'));
  const tail = cut >= 0 ? t.slice(cut + 1) : t;
  const words = tail
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .replace(/[_\-]+/g, ' ')
    .toLowerCase()
    .trim();
  if (!words) return [];
  const out = [words];
  const trimmed = words.replace(/^(?:event )|(?: condition| event)$/g, '').trim();
  if (trimmed && trimmed !== words) out.push(trimmed);
  return out;
}

export class PageIndex {
  /** False for script shells: too little visible text to verify anything. */
  readonly substantial: boolean;
  private readonly text: string;
  private prepared?: PreparedText;
  private words?: string[];
  /** token → its position, or positions when it occurs more than once. */
  private positions?: Map<string, number | number[]>;
  private bigrams?: Set<number>;
  private attrs?: { urls: Set<string>; paths: Set<string>; dates: Set<string> };
  private readonly memo = new Map<string, boolean>();

  constructor(private readonly doc: SourceDocument) {
    this.text = typeof doc.text === 'string' ? doc.text : '';
    this.substantial = this.text.trim().length >= STRUCTURED_LIMITS.minSubstantialTextChars;
  }

  /** Visibility of a raw value read as `kind`. Arrays: every checked member must be visible. */
  visible(raw: unknown, kind: ValueKind): boolean {
    // Listings repeat values (currency, availability, brand) across records.
    const key = typeof raw === 'string' && raw.length <= MEMO_MAX_VALUE_CHARS ? `${kind}\u0001${raw}` : typeof raw === 'number' ? `${kind}\u0001#${raw}` : undefined;
    if (key === undefined) return this.computeVisible(raw, kind);
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    const visible = this.computeVisible(raw, kind);
    if (this.memo.size < MEMO_MAX_ENTRIES) this.memo.set(key, visible);
    return visible;
  }

  private computeVisible(raw: unknown, kind: ValueKind): boolean {
    if (Array.isArray(raw)) {
      const members = raw.slice(0, STRUCTURED_LIMITS.maxVisibleArrayMembers * 2).filter((v) => v !== null && v !== undefined && v !== '');
      const checked = members.slice(0, STRUCTURED_LIMITS.maxVisibleArrayMembers);
      // Mapped values are flat arrays of scalars; a nested array is not visible text.
      return checked.length > 0 && checked.every((v) => !Array.isArray(v) && this.visible(v, kind));
    }
    if (typeof raw === 'number') return Number.isFinite(raw) && this.hasNumber(raw);
    if (typeof raw !== 'string') return false;
    const s = raw.trim();
    if (!s) return false;
    // Enumerations are URLs too ("https://schema.org/InStock"): read them as their label first.
    if (kind === 'enum') return enumPhrases(s).some((p) => this.hasText(p)) || this.hasText(s);
    if (kind === 'url' || (looksLikeUrl(s) && !/\s/.test(s))) return this.hasUrl(s) || this.hasText(s);
    if (/^[A-Z]{3}$/.test(s) && Object.hasOwn(CURRENCY_SYMBOLS, s)) return this.hasText(s) || CURRENCY_SYMBOLS[s].some((sym) => this.text.includes(sym));
    if (kind === 'date') return this.hasDate(s);
    if (kind === 'duration') return this.hasDuration(s);
    if (kind === 'number' || isNumericLike(s)) return this.hasNumber(s) || this.hasText(s);
    return this.hasText(s);
  }

  /** Word-sequence (short) or bigram-overlap (long) match against the page text. */
  hasText(s: string): boolean {
    const tokens = wordTokens(s, STRUCTURED_LIMITS.maxVisibilityTokens);
    if (tokens.length === 0) return false;
    if (tokens.length <= SEQUENCE_MAX_TOKENS) return this.hasSequence(tokens);
    if (this.hasSequence(tokens.slice(0, SEQUENCE_MAX_TOKENS)) && this.hasSequence(tokens.slice(-SEQUENCE_MAX_TOKENS))) return true;
    return this.bigramOverlap(tokens) >= LONG_TEXT_MIN_OVERLAP;
  }

  hasNumber(raw: string | number): boolean {
    this.prepared ??= prepareText(this.text);
    return checkGrounding(raw, { documentText: this.prepared }).grounded;
  }

  hasUrl(s: string): boolean {
    const attrs = this.attrIndex();
    const key = urlKey(s, this.doc.url);
    if (key && attrs.urls.has(key)) return true;
    const path = urlPathKey(s, this.doc.url);
    return path !== undefined && attrs.paths.has(path);
  }

  hasDate(s: string): boolean {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
    if (!m) return this.hasText(s);
    const datePart = m[0];
    if (this.hasText(s) || this.hasText(datePart) || this.attrIndex().dates.has(datePart)) return true;
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    return dateSequences(m[1], mo, d).some((seq) => this.hasSequence(seq));
  }

  hasDuration(s: string): boolean {
    return this.hasText(s) || durationSequences(s).some((seq) => this.hasSequence(seq));
  }

  /** Exact token sequence, anchored on its rarest token. */
  hasSequence(tokens: readonly string[]): boolean {
    if (tokens.length === 0) return false;
    const { words, positions } = this.index();
    let anchor = 0;
    let anchorHits: number | number[] | undefined;
    let anchorCount = Infinity;
    for (let i = 0; i < tokens.length; i++) {
      const hits = positions.get(tokens[i]);
      if (hits === undefined) return false;
      const count = typeof hits === 'number' ? 1 : hits.length;
      if (count < anchorCount) {
        anchor = i;
        anchorHits = hits;
        anchorCount = count;
      }
    }
    const starts = typeof anchorHits === 'number' ? [anchorHits] : anchorHits!;
    outer: for (const p of starts) {
      const start = p - anchor;
      if (start < 0 || start + tokens.length > words.length) continue;
      for (let j = 0; j < tokens.length; j++) if (words[start + j] !== tokens[j]) continue outer;
      return true;
    }
    return false;
  }

  private bigramOverlap(tokens: readonly string[]): number {
    if (!this.bigrams) {
      const { words } = this.index();
      const set = new Set<number>();
      for (let i = 1; i < words.length; i++) set.add(bigramKey(words[i - 1], words[i]));
      this.bigrams = set;
    }
    const keys = new Set<number>();
    for (let i = 1; i < tokens.length; i++) keys.add(bigramKey(tokens[i - 1], tokens[i]));
    if (keys.size === 0) return 0;
    let hits = 0;
    for (const k of keys) if (this.bigrams.has(k)) hits++;
    return hits / keys.size;
  }

  private index(): { words: string[]; positions: Map<string, number | number[]> } {
    if (!this.words || !this.positions) {
      this.prepared ??= prepareText(this.text);
      // The grounding module already normalized (and cached) the page text.
      const words = tokensOfNormalized(this.prepared.text, Infinity);
      // Most tokens occur once: keep a bare number until a second occurrence.
      const positions = new Map<string, number | number[]>();
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const cur = positions.get(w);
        if (cur === undefined) positions.set(w, i);
        else if (typeof cur === 'number') positions.set(w, [cur, i]);
        else cur.push(i);
      }
      this.words = words;
      this.positions = positions;
    }
    return { words: this.words, positions: this.positions };
  }

  private attrIndex(): { urls: Set<string>; paths: Set<string>; dates: Set<string> } {
    if (this.attrs) return this.attrs;
    const urls = new Set<string>();
    const paths = new Set<string>();
    const dates = new Set<string>();
    const blocks = Array.isArray(this.doc.blocks) ? this.doc.blocks : [];
    for (const block of blocks) {
      const attrs = block?.attrs;
      if (!attrs || typeof attrs !== 'object') continue;
      for (const [k, v] of Object.entries(attrs)) {
        if (typeof v !== 'string' || !v) continue;
        if (k === 'datetime') {
          const m = /^\d{4}-\d{2}-\d{2}/.exec(v.trim());
          if (m) dates.add(m[0]);
          continue;
        }
        if (k !== 'href' && k !== 'src' && k !== 'content' && !k.startsWith('data-')) continue;
        if (!looksLikeUrl(v)) continue;
        const key = urlKey(v, this.doc.url);
        if (key) urls.add(key);
        const path = urlPathKey(v, this.doc.url);
        if (path) paths.add(path);
      }
    }
    this.attrs = { urls, paths, dates };
    return this.attrs;
  }
}
