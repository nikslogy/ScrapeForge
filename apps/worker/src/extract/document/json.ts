// Lenient JSON parsing for page-embedded data. Never evaluates anything: the
// only interpreter involved is JSON.parse.

const enum Ch {
  Tab = 9,
  Lf = 10,
  Cr = 13,
  Space = 32,
  Quote = 34,
  Comma = 44,
  Lt = 60,
  OpenBracket = 91,
  Backslash = 92,
  CloseBracket = 93,
  OpenBrace = 123,
  CloseBrace = 125,
}

function isJsonWhitespace(c: number): boolean {
  return c === Ch.Space || c === Ch.Lf || c === Ch.Cr || c === Ch.Tab;
}

/**
 * True when brackets nest deeper than `maxDepth` (strings are skipped).
 * Deep values parse fine but later crash recursive consumers such as
 * JSON.stringify, so they are rejected up front in O(n).
 */
export function exceedsJsonDepth(s: string, maxDepth: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (inString) {
      if (c === Ch.Backslash) i++;
      else if (c === Ch.Quote) inString = false;
      continue;
    }
    if (c === Ch.Quote) inString = true;
    else if (c === Ch.OpenBrace || c === Ch.OpenBracket) {
      if (++depth > maxDepth) return true;
    } else if (c === Ch.CloseBrace || c === Ch.CloseBracket) depth--;
  }
  return false;
}

function escapeControl(c: number): string {
  if (c === Ch.Lf) return '\\n';
  if (c === Ch.Cr) return '\\r';
  if (c === Ch.Tab) return '\\t';
  return `\\u${c.toString(16).padStart(4, '0')}`;
}

const LEADING_WRAPPER = /^(?:\s*(?:\/\/)?\s*(?:<!--|<!\[CDATA\[))+/;
const TRAILING_WRAPPER = /(?:\s*(?:\/\/)?\s*(?:-->|\]\]>))+\s*$/;

/**
 * Light, string-aware cleanup of the mistakes hand-written JSON-LD commonly
 * contains: HTML comment / CDATA wrappers, HTML comments between tokens,
 * trailing commas before } or ], and raw control characters inside strings.
 */
export function cleanupJson(raw: string): string {
  const s = raw.trim().replace(LEADING_WRAPPER, '').replace(TRAILING_WRAPPER, '');
  const out: string[] = [];
  let segStart = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (inString) {
      if (c === Ch.Backslash) {
        i++;
      } else if (c === Ch.Quote) {
        inString = false;
      } else if (c < 0x20) {
        out.push(s.slice(segStart, i), escapeControl(c));
        segStart = i + 1;
      }
      continue;
    }
    if (c === Ch.Quote) {
      inString = true;
    } else if (c === Ch.Comma) {
      let j = i + 1;
      while (j < s.length && isJsonWhitespace(s.charCodeAt(j))) j++;
      const next = s.charCodeAt(j);
      if (next === Ch.CloseBrace || next === Ch.CloseBracket) {
        out.push(s.slice(segStart, i));
        segStart = i + 1;
      }
    } else if (c === Ch.Lt && s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      out.push(s.slice(segStart, i));
      i = end < 0 ? s.length : end + 2;
      segStart = i + 1;
    }
  }
  if (segStart < s.length) out.push(s.slice(segStart));
  return out.join('');
}

export type JsonParseResult = { ok: true; value: unknown } | { ok: false };

const FAILED: JsonParseResult = { ok: false };

/** Strict parse first; one cleanup + retry when `lenient`. */
export function parseJsonSafely(raw: string, maxDepth: number, lenient: boolean): JsonParseResult {
  const s = raw.trim();
  if (!s) return FAILED;
  if (exceedsJsonDepth(s, maxDepth)) return FAILED;
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    if (!lenient) return FAILED;
  }
  const cleaned = cleanupJson(s);
  if (!cleaned || cleaned === s) return FAILED;
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch {
    return FAILED;
  }
}
