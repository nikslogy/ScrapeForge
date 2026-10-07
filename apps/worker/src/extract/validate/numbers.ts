// Locale-aware number parsing shared by value normalization and grounding.
//
// Pages print numbers in many conventions: "1,299.00" (US/UK), "1.299,00"
// (DE/ES/IT), "1 299,00" (FR, after NBSP/thin space → space), "1'299.00" (CH),
// "1,23,456.00" (IN). Only one shape is genuinely ambiguous: a single "," or
// "." followed by exactly three digits ("1,234", "1.234"). For that shape the
// default is the US/UK reading (comma = thousands, dot = decimal) unless the
// caller supplies a decimal-separator hint or asks for an integer. Grounding
// asks for every plausible reading via localeNumberCandidates.

export interface LocaleNumberOptions {
  /** Decimal separator used by the page, when known. */
  decimal?: '.' | ',';
  /** Prefer the reading that yields an integer ("1.024 reviews" → 1024). */
  integer?: boolean;
}

type Interpretation =
  | { kind: 'exact'; value: number }
  | { kind: 'ambiguous'; separator: '.' | ','; grouping: number; decimal: number; fraction: string };

const MAX_NUMBER_CHARS = 64;

/**
 * Parses one number written in any common locale convention. The text must be
 * the number alone (optional sign and surrounding whitespace allowed); use
 * findNumericTokens to locate numbers inside longer text. Returns null when
 * the text is not a well-formed number.
 */
export function parseLocaleNumber(text: string, opts: LocaleNumberOptions = {}): number | null {
  const parsed = interpret(text);
  if (!parsed) return null;
  if (parsed.kind === 'exact') return parsed.value;
  if (opts.decimal !== undefined) return opts.decimal === parsed.separator ? parsed.decimal : parsed.grouping;
  if (opts.integer || parsed.separator === ',') return parsed.grouping;
  // "1.000" is a thousand: nobody prints one with three zero decimals.
  return parsed.fraction === '000' ? parsed.grouping : parsed.decimal;
}

/**
 * Every plausible reading of a number token: one, or two for the ambiguous
 * shape. Implausible decimal readings are left out so "1,000" cannot stand
 * for 1 and "2,500" cannot stand for 2.5 (a comma decimal is not written
 * with three places ending in zero).
 */
export function localeNumberCandidates(text: string): number[] {
  const parsed = interpret(text);
  if (!parsed) return [];
  if (parsed.kind === 'exact') return [parsed.value];
  if (parsed.fraction === '000') return [parsed.grouping];
  if (parsed.separator === ',') return parsed.fraction.endsWith('0') ? [parsed.grouping] : [parsed.grouping, parsed.decimal];
  return [parsed.decimal, parsed.grouping];
}

function interpret(raw: string): Interpretation | null {
  let s = raw.normalize('NFKC').trim();
  if (s.length === 0 || s.length > MAX_NUMBER_CHARS) return null;
  let sign = 1;
  if (/^[-\u2212\u2012\u2013]/.test(s)) {
    sign = -1;
    s = s.slice(1).trimStart();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trimStart();
  }
  s = s.replace(/’/g, "'");
  if (!/^\d(?:[\d.,' ]*\d)?$/.test(s)) return null;

  const separators: string[] = s.match(/[.,' ]/g) ?? [];
  if (separators.length === 0) return exact(sign, s, '');
  const groups = s.split(/[.,' ]/);
  if (groups.some((g) => g === '')) return null;

  const kinds = new Set(separators);
  const last = separators[separators.length - 1];

  if (kinds.size === 1) {
    if (last === ' ' || last === "'" || separators.length > 1) {
      // Only grouping: "1 299", "1'299", "1,234,567", "1.234.567".
      return validGrouping(groups, last) ? exact(sign, groups.join(''), '') : null;
    }
    const [before, after] = groups;
    if (after.length === 3 && before.length <= 3 && !before.startsWith('0')) {
      const grouping = exact(sign, before + after, '');
      const decimal = exact(sign, before, after);
      if (!grouping || !decimal) return null;
      return { kind: 'ambiguous', separator: last as '.' | ',', grouping: grouping.value, decimal: decimal.value, fraction: after };
    }
    return exact(sign, before, after);
  }

  // Mixed separators: the last one is the decimal mark and occurs once; the
  // rest are a single grouping character ("1,299.00", "1.299,00", "1 299,00").
  if (last !== '.' && last !== ',') return null;
  if (separators.indexOf(last) !== separators.length - 1) return null;
  const groupingKinds = new Set(separators.slice(0, -1));
  if (groupingKinds.size !== 1) return null;
  const intGroups = groups.slice(0, -1);
  if (!validGrouping(intGroups, separators[0])) return null;
  return exact(sign, intGroups.join(''), groups[groups.length - 1]);
}

/**
 * Groups after the first must be three digits; with "," the Indian lakh
 * system is also accepted (2-digit groups, then a final 3-digit group).
 */
function validGrouping(groups: string[], separator: string): boolean {
  if (groups.length < 2) return true;
  if (groups[0].length > 3) return false;
  const rest = groups.slice(1);
  if (rest.every((g) => g.length === 3)) return true;
  if (separator !== ',' || groups[0].length > 2) return false;
  return rest[rest.length - 1].length === 3 && rest.slice(0, -1).every((g) => g.length === 2);
}

function exact(sign: number, intDigits: string, fracDigits: string): { kind: 'exact'; value: number } | null {
  const value = sign * Number(fracDigits ? `${intDigits}.${fracDigits}` : intDigits);
  // Normalize -0 to 0 so callers can compare with ===.
  return Number.isFinite(value) ? { kind: 'exact', value: value === 0 ? 0 : value } : null;
}

// ─────────────────────────────────────────────────────────────
// Locating numbers inside text
// ─────────────────────────────────────────────────────────────

export interface NumericToken {
  /** The number as written, without sign ("1,299.00"). */
  text: string;
  start: number;
  end: number;
  negative: boolean;
}

// Alternatives, tried in order at each digit:
//   1. space/apostrophe grouping, groups of exactly three digits: "1 299,00"
//   2. "."/"," grouping with 2–3 digit groups (Indian lakh, "1,299.00", "12,99")
//   3. plain digits with an optional decimal part: "1234,567", "3.14159"
// Every repetition is anchored on a separator, so matching stays linear.
const NUMBER_PATTERN =
  /\d{1,3}(?:[ '’]\d{3}(?!\d))+(?:[.,]\d+)?|\d{1,3}(?:[.,]\d{2,3}(?!\d))+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g;

/** Letter runs that may directly precede an amount without being a model number ("EUR12", "Rs12"). */
const LETTER_PREFIXES = new Set(['rs', 'kr', 'zl', 'zł']);

/**
 * Finds numbers in (NFKC-normalized) text. Digits glued to a preceding Latin,
 * Greek or Cyrillic letter ("A1B2", "v2", "COVID19") are not numbers, except
 * after a currency code ("USD12"). A leading "-" or "−" makes the number negative unless it
 * follows a digit ("10-20" is a range, not 10 and -20).
 */
export function findNumericTokens(text: string, maxTokens = Infinity): NumericToken[] {
  const tokens: NumericToken[] = [];
  for (const m of text.matchAll(NUMBER_PATTERN)) {
    const start = m.index;
    if (start > 0 && gluedToWord(text, start)) continue;
    tokens.push({ text: m[0], start, end: start + m[0].length, negative: hasMinusSign(text, start) });
    if (tokens.length >= maxTokens) break;
  }
  return tokens;
}

// Only scripts that separate words with spaces: in Chinese or Japanese text a
// number directly after a letter ("价格100元") is normal.
const SPACED_LETTER = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u;

function gluedToWord(text: string, start: number): boolean {
  let i = start;
  while (i > 0 && SPACED_LETTER.test(text[i - 1])) i--;
  if (i === start) return false;
  const word = text.slice(i, start).toLowerCase();
  return !(isCurrencyCode(word) || LETTER_PREFIXES.has(word));
}

function hasMinusSign(text: string, start: number): boolean {
  const prev = text[start - 1];
  if (prev !== '-' && prev !== '\u2212') return false;
  const before = text[start - 2];
  return before === undefined || !/[\p{L}\p{N}.,]/u.test(before);
}

// ─────────────────────────────────────────────────────────────
// Currency markers
// ─────────────────────────────────────────────────────────────

// ISO 4217 codes seen on retail pages. Codes that are also common English
// words (TRY, COP, PEN, RON) are left out: matching is case-insensitive.
const CURRENCY_CODES = new Set([
  'usd', 'eur', 'gbp', 'jpy', 'cny', 'rmb', 'inr', 'aud', 'cad', 'chf', 'sek', 'nok', 'dkk', 'pln', 'czk', 'huf',
  'bgn', 'rub', 'uah', 'brl', 'mxn', 'ars', 'clp', 'zar', 'ngn', 'kes', 'egp', 'aed',
  'sar', 'qar', 'kwd', 'bhd', 'omr', 'jod', 'ils', 'krw', 'twd', 'hkd', 'sgd', 'myr', 'thb', 'idr', 'php', 'vnd',
  'pkr', 'bdt', 'lkr', 'nzd', 'isk',
]);

/** Currency words that are not ISO codes but are printed next to amounts. */
const CURRENCY_WORDS = new Set(['rs', 'kr', 'zł', 'zl', 'kč', 'ft', 'lei', 'лв', 'руб', 'грн', '円', '元', 'yen', 'yuan', 'euro', 'euros', 'dollar', 'dollars', 'pound', 'pounds', 'rupee', 'rupees']);

export function isCurrencyCode(word: string): boolean {
  return CURRENCY_CODES.has(word.toLowerCase());
}

/** True for a currency symbol (\p{Sc}), ISO code or common currency word. */
export function isCurrencyWord(word: string): boolean {
  const lower = word.toLowerCase();
  return CURRENCY_CODES.has(lower) || CURRENCY_WORDS.has(lower) || /^\p{Sc}+$/u.test(word);
}

/**
 * Removes currency symbols together with letters glued to them ("US$",
 * "HK$", "R$", "NT$"), which would otherwise read as ordinary words.
 */
export function stripCurrencySymbols(text: string): string {
  return text.replace(/\p{L}{0,3}\p{Sc}+/gu, ' ');
}

/** True when the text contains any currency symbol, code or word. */
export function hasCurrencyMarker(text: string): boolean {
  if (/\p{Sc}/u.test(text)) return true;
  for (const m of text.matchAll(/[\p{L}]+/gu)) {
    if (isCurrencyWord(m[0])) return true;
  }
  return false;
}
