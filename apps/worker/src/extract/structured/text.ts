// Small helpers shared by the structured-data mapper: safe property access on
// parsed page data, JSON pointers, identifier tokenization and URL keys.

import { normalizeForMatch } from '../validate/grounding.js';

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Own property value only: "__proto__" or "toString" never reach a prototype. */
export function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

export function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

// Identifier tokenization runs for every customer field and every key of
// embedded page JSON (where the same keys repeat thousands of times).
const tokenCache = new Map<string, readonly string[]>();
const TOKEN_CACHE_MAX = 20_000;
const MAX_IDENTIFIER_CHARS = 200;

/**
 * Lowercase word tokens of an identifier or short phrase:
 * "productName", "product_name", "Product-Name", "PRODUCT NAME" → ["product", "name"];
 * "productID" → ["product", "id"]; "gtin13" stays one token.
 */
export function identifierTokens(name: string): readonly string[] {
  const hit = tokenCache.get(name);
  if (hit) return hit;
  const tokens = name
    .slice(0, MAX_IDENTIFIER_CHARS)
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
  tokenCache.set(name, tokens);
  return tokens;
}

/** "https://schema.org/Product" → "Product"; "schema:Offer" → "Offer". */
export function typeTail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  if (!t || t.length > 200) return undefined;
  const cut = Math.max(t.lastIndexOf('/'), t.lastIndexOf('#'), t.lastIndexOf(':'));
  const tail = cut >= 0 ? t.slice(cut + 1) : t;
  return tail || undefined;
}

/** Every @type of a node (string or array), as type tails. */
export function typesOf(node: Record<string, unknown>): string[] {
  const raw = own(node, '@type');
  const list = Array.isArray(raw) ? raw.slice(0, 10) : [raw];
  const out: string[] = [];
  for (const v of list) {
    const tail = typeTail(v);
    if (tail && !out.includes(tail)) out.push(tail);
  }
  return out;
}

const URLISH = /^(?:(?:https?:)?\/\/[^\s]+|\/(?!\/)[^\s]*|www\.[^\s]+)$/i;
// Document-relative paths are only taken when they name an image file.
const RELATIVE_IMAGE = /^[^\s:?#]+\.(?:jpe?g|png|gif|webp|avif|svg|bmp|tiff?)(?:[?#][^\s]*)?$/i;

/**
 * Absolute, protocol-relative, root-relative or www. URL, or a relative image
 * path ("img/a.jpg"). Never data:/javascript: or other schemes.
 */
export function looksLikeUrl(s: string): boolean {
  const t = s.trim();
  return t.length > 0 && t.length <= 4096 && (URLISH.test(t) || RELATIVE_IMAGE.test(t));
}

/**
 * Comparison key for a URL: host + path (no trailing slash) + query, scheme
 * and fragment ignored. undefined for non-http(s) or unparsable values.
 */
export function urlKey(value: string, base?: string): string | undefined {
  const t = value.trim();
  if (!t || t.length > 4096) return undefined;
  let u: URL;
  try {
    u = new URL(t.startsWith('www.') ? `https://${t}` : t, base);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
}

/** Path-only key ("/media/a.jpg"), used when CDNs vary host or query. */
export function urlPathKey(value: string, base?: string): string | undefined {
  try {
    const u = new URL(value.trim(), base);
    const path = u.pathname.replace(/\/+$/, '');
    // Short paths ("/", "/p") would match unrelated URLs.
    return path.length >= 5 ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Name comparison key: case/punctuation/whitespace-insensitive. */
export function nameKey(value: string): string {
  return normalizeForMatch(value.slice(0, 1000))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** True when `needle` occurs in `hay` on word boundaries (both already nameKey()-normalized). */
export function containsWords(hay: string, needle: string): boolean {
  if (!needle || needle.length > hay.length) return false;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const before = i === 0 || hay[i - 1] === ' ';
    const end = i + needle.length;
    const after = end === hay.length || hay[end] === ' ';
    if (before && after) return true;
  }
  return false;
}

const ENTITY_DECODE: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/**
 * Removes markup that page JSON often carries inside text values ("<p>",
 * "&amp;") so visibility compares what a reader sees. Only for matching:
 * returned raw values are never rewritten.
 */
export function stripMarkup(s: string): string {
  if (!s.includes('<') && !s.includes('&')) return s;
  return s
    .replace(/<[^<>]{0,2000}>/g, ' ')
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6}|#39);/gi, (m, code: string) => {
      const lower = code.toLowerCase();
      if (lower.startsWith('#x')) return safeFromCodePoint(parseInt(lower.slice(2), 16)) ?? m;
      if (lower.startsWith('#') && lower !== '#39') return safeFromCodePoint(parseInt(lower.slice(1), 10)) ?? m;
      return ENTITY_DECODE[lower] ?? m;
    });
}

function safeFromCodePoint(cp: number): string | undefined {
  return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : undefined;
}

/** Unrendered template placeholders ("{{ product.title }}", "${price}") are not data. */
export function isTemplatePlaceholder(s: string): boolean {
  return /\{\{[^}]*\}\}|\$\{[^}]*\}/.test(s);
}
