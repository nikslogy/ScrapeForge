import * as cheerio from 'cheerio';
import { DOCUMENT_LIMITS } from './limits.js';

// Minimal structural view of the domhandler nodes cheerio produces. Declaring
// it locally keeps this module independent of cheerio's transitive type
// packages and documents exactly which node fields the builder relies on.
export interface DomNode {
  type: string;
  parent: DomNode | null;
}

export interface DomText extends DomNode {
  type: 'text';
  data: string;
}

export interface DomElement extends DomNode {
  type: 'tag' | 'script' | 'style';
  name: string;
  attribs: Record<string, string>;
  children: DomNode[];
}

export interface DomRoot extends DomNode {
  type: 'root';
  children: DomNode[];
}

/**
 * Parse exactly the way `cheerio.load(rawHtml)` does (parse5, full document),
 * so nth-child selectors computed here re-select the same elements there.
 */
export function parseHtml(html: string): DomRoot {
  return cheerio.load(html).root()[0] as unknown as DomRoot;
}

export function isElement(node: DomNode): node is DomElement {
  const t = node.type;
  return t === 'tag' || t === 'script' || t === 'style';
}

export function isText(node: DomNode): node is DomText {
  return node.type === 'text';
}

export function findChildElement(
  parent: { children: DomNode[] },
  name: string,
): DomElement | undefined {
  for (const child of parent.children) {
    if (isElement(child) && child.name === name) return child;
  }
  return undefined;
}

/** Elements whose content is never visible page text. */
export const SKIP_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object',
  'head', 'title', 'meta', 'link', 'base', 'datalist', 'audio', 'video', 'embed',
  'noframes', 'param', 'source', 'track',
]);

/** Phrasing elements: no line break around them, so no separator is inserted. */
export const INLINE_TAGS: ReadonlySet<string> = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'del',
  'dfn', 'em', 'font', 'i', 'ins', 'kbd', 'label', 'mark', 'nobr', 'q', 'rp', 'rt',
  'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time',
  'tt', 'u', 'var',
]);

export const HEADING_LEVEL: Readonly<Record<string, number>> = {
  h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6,
};

export function isHeadingTag(name: string): boolean {
  return name.length === 2 && name.charCodeAt(0) === 104 && HEADING_LEVEL[name] !== undefined;
}

/** Elements that break text flow (and count as structure inside a field). */
export function isBlockish(name: string): boolean {
  return !INLINE_TAGS.has(name) && name !== 'br' && name !== 'wbr';
}

// Inline-style hiding. Anchored on a declaration boundary so custom
// properties such as `--x-display:none` do not match.
const HIDDEN_STYLE =
  /(?:^|[;\s])(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!\s*important\s*)?(?:;|$)/i;

/**
 * Hidden content never reaches blocks: it is a common prompt-injection
 * carrier. Covered: the `hidden` attribute (including until-found),
 * aria-hidden="true", inline display:none / visibility:hidden|collapse,
 * <input type=hidden> and closed <dialog>. Class-based hiding (d-none,
 * sr-only, ...) is NOT detected: responsive utility classes make it ambiguous
 * without the stylesheet. aria-hidden subtrees are dropped even when they hold
 * the only copy of some text; that trade-off favours injection safety.
 */
export function isHiddenElement(el: DomElement): boolean {
  const a = el.attribs;
  if (a.hidden !== undefined) return true;
  const ariaHidden = a['aria-hidden'];
  if (ariaHidden !== undefined && ariaHidden.trim().toLowerCase() === 'true') return true;
  const style = a.style;
  if (style !== undefined && style.length > 0 && HIDDEN_STYLE.test(style)) return true;
  if (el.name === 'input' && (a.type ?? '').trim().toLowerCase() === 'hidden') return true;
  if (el.name === 'dialog' && a.open === undefined) return true;
  return false;
}

// Characters that render as nothing; removed (not turned into spaces) so
// "Hel\u00adlo" stays one word.
const INVISIBLE_CHARS = /[\u00ad\u200b\u2060\ufeff]/g;
const HAS_INVISIBLE = /[\u00ad\u200b\u2060\ufeff]/;
const WHITESPACE_RUN = /\s+/g;

// Code points matched by \s beyond ASCII, plus the invisible characters.
function isSpecialSpace(c: number): boolean {
  return c === 0xa0 || c === 0xad || c === 0x1680 || (c >= 0x2000 && c <= 0x200b) || c === 0x2028
    || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x2060 || c === 0x3000 || c === 0xfeff;
}

/** One scan: does the string need collapsing (most short texts do not)? */
function needsCollapse(s: string): boolean {
  let prevSpace = true; // a leading space needs trimming
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32) {
      if (prevSpace) return true;
      prevSpace = true;
    } else if (c < 32 || (c >= 0xa0 && isSpecialSpace(c))) {
      return true;
    } else {
      prevSpace = false;
    }
  }
  return prevSpace && s.length > 0;
}

export function collapseWhitespace(s: string): string {
  if (!needsCollapse(s)) return s;
  const visible = HAS_INVISIBLE.test(s) ? s.replace(INVISIBLE_CHARS, '') : s;
  return visible.replace(WHITESPACE_RUN, ' ').trim();
}

/** Approximate count of visible (non-whitespace) characters. */
export function countVisibleChars(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 32 && c !== 160 && c !== 0x200b && c !== 0xfeff && c !== 0xad && c !== 0x3000) n++;
  }
  return n;
}

// UI state classes vary between pages of one template, so they are skipped
// when picking the "stable" class used in skeletons and record keys.
const STATE_CLASSES = new Set([
  'active', 'current', 'selected', 'open', 'opened', 'show', 'shown', 'hidden',
  'visible', 'collapsed', 'expanded', 'disabled', 'focus', 'focused', 'hover',
  'first', 'last', 'odd', 'even', 'clearfix', 'loaded', 'lazyloaded', 'lazyload',
]);

/**
 * First class token that is not a UI-state class, lowercased with digits
 * stripped. Callers memoize per attribute value (see analyzeClass).
 */
export function firstStableClass(classAttr: string | undefined): string {
  if (!classAttr) return '';
  for (const token of classAttr.split(/\s+/)) {
    if (!token) continue;
    const lower = token.toLowerCase();
    if (STATE_CLASSES.has(lower) || lower.startsWith('is-') || lower.startsWith('has-')) continue;
    const stripped = lower.replace(/\d+/g, '');
    if (stripped && stripped !== '-' && stripped !== '_') return stripped;
  }
  return '';
}

const SIMPLE_IDENT = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/;
const SIMPLE_TAG = /^[a-z][a-z0-9-]*$/;

/** True when the token can be used in a CSS selector without escaping. */
export function isSimpleIdent(token: string): boolean {
  return SIMPLE_IDENT.test(token);
}

/** Tag part of a selector step; '*' when the name would need escaping. */
export function tagSelector(name: string): string {
  return SIMPLE_TAG.test(name) ? name : '*';
}

const HREF_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const SRC_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Resolve an attribute URL against the page base. Returns undefined for
 * javascript:, data: and other non-web schemes, and for oversized values
 * (a truncated URL would be wrong evidence).
 */
export function resolveUrl(value: string, base: URL | undefined, kind: 'href' | 'src'): string | undefined {
  const v = value.trim();
  if (!v || v.length > DOCUMENT_LIMITS.maxUrlChars) return undefined;
  let u: URL;
  try {
    u = base ? new URL(v, base) : new URL(v);
  } catch {
    return undefined;
  }
  const allowed = kind === 'href' ? HREF_PROTOCOLS : SRC_PROTOCOLS;
  if (!allowed.has(u.protocol)) return undefined;
  const href = u.href;
  return href.length > DOCUMENT_LIMITS.maxUrlChars ? undefined : href;
}

export function tryParseUrl(value: string, base?: URL): URL | undefined {
  try {
    return base ? new URL(value, base) : new URL(value);
  } catch {
    return undefined;
  }
}

const TEXT_ATTRS = ['alt', 'title', 'content', 'datetime', 'value', 'aria-label', 'itemprop'];

/**
 * Evidence attributes kept on field/record/heading blocks: href and src
 * (absolute), alt, title, content, datetime, value, aria-label, itemprop,
 * class (≤ 200 chars) and up to 10 data-* attributes (values ≤ 200 chars;
 * longer ones are dropped rather than truncated). Other text attributes are
 * truncated at 500 chars.
 */
export function collectAttrs(el: DomElement, base: URL | undefined): Record<string, string> | undefined {
  const a = el.attribs;
  const out: Record<string, string> = {};
  let n = 0;
  if (a.href !== undefined) {
    const href = resolveUrl(a.href, base, 'href');
    if (href) {
      out.href = href;
      n++;
    }
  }
  if (a.src !== undefined) {
    const src = resolveUrl(a.src, base, 'src');
    if (src) {
      out.src = src;
      n++;
    }
  }
  for (const k of TEXT_ATTRS) {
    const v = a[k];
    if (v === undefined) continue;
    const t = collapseWhitespace(v);
    if (!t) continue;
    out[k] = t.length > DOCUMENT_LIMITS.maxAttrChars ? t.slice(0, DOCUMENT_LIMITS.maxAttrChars) : t;
    n++;
  }
  if (a.class !== undefined) {
    const t = collapseWhitespace(a.class);
    if (t) {
      out.class = t.slice(0, DOCUMENT_LIMITS.maxClassChars);
      n++;
    }
  }
  let dataCount = 0;
  for (const k in a) {
    if (dataCount >= DOCUMENT_LIMITS.maxDataAttrs) break;
    if (!k.startsWith('data-') || k.length > 64) continue;
    const t = a[k].trim();
    if (!t || t.length > DOCUMENT_LIMITS.maxDataAttrChars) continue;
    out[k] = t;
    dataCount++;
    n++;
  }
  return n > 0 ? out : undefined;
}
