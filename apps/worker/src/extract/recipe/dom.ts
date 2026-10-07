// DOM reading helpers shared by the recipe interpreter and recipe induction.
//
// Minimal structural view of the domhandler nodes cheerio produces, declared
// locally (like document/dom.ts) so this module does not depend on cheerio's
// transitive type packages.

export interface DomNode {
  type: string;
  parent: DomNode | null;
}

export interface DomElement extends DomNode {
  type: 'tag' | 'script' | 'style';
  name: string;
  attribs: Record<string, string>;
  children: DomNode[];
}

interface DomText extends DomNode {
  type: 'text';
  data: string;
}

export function isElement(node: DomNode | null | undefined): node is DomElement {
  if (!node) return false;
  const t = node.type;
  return t === 'tag' || t === 'script' || t === 'style';
}

function isText(node: DomNode): node is DomText {
  return node.type === 'text';
}

/** Descendants whose content is never page text (the element itself may still be read). */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg']);

/** Phrasing elements: text flows across them without a separator. */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'del', 'dfn', 'em',
  'font', 'i', 'ins', 'kbd', 'label', 'mark', 'nobr', 'q', 'rp', 'rt', 'ruby', 's', 'samp',
  'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'img', 'wbr',
]);

// Render as nothing; removed (not turned into spaces) so "Hel\u00adlo" stays
// one word. ZWJ/ZWNJ are kept: they carry meaning in emoji and some scripts.
const INVISIBLE_CHARS = /[\u00ad\u200b\u2060\ufeff]/g;
const WHITESPACE_RUN = /\s+/g;

/** Trim and collapse whitespace runs (NBSP and Unicode spaces included) to one space. */
export function collapseWhitespace(s: string): string {
  return s.replace(INVISIBLE_CHARS, '').replace(WHITESPACE_RUN, ' ').trim();
}

const BLOCK_END = Symbol('block-end');

export interface TextResult {
  text: string;
  truncated: boolean;
}

/**
 * Visible text of an element with collapsed whitespace. Block boundaries and
 * <br> become spaces ("<p>A</p><p>B</p>" → "A B"), inline elements do not
 * ("<b>A</b>B" → "AB"). Iterative, so hostile nesting depth cannot overflow
 * the stack, and it stops early once `maxChars` of raw text are collected.
 */
export function elementText(el: DomElement, maxChars: number): TextResult {
  let out = '';
  let truncated = false;
  // Collapsing can shrink the text, so collect some slack before stopping.
  const rawLimit = maxChars * 2 + 64;
  const stack: Array<DomNode | typeof BLOCK_END> = [];
  for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]);
  while (stack.length > 0) {
    const node = stack.pop() as DomNode | typeof BLOCK_END;
    if (node === BLOCK_END) {
      out += ' ';
      continue;
    }
    if (isText(node)) {
      out += node.data;
      if (out.length > rawLimit) {
        truncated = true;
        break;
      }
      continue;
    }
    if (!isElement(node)) continue;
    const name = node.name;
    if (SKIP_TAGS.has(name) || isHidden(node)) continue;
    if (name === 'br') {
      out += ' ';
      continue;
    }
    const block = !INLINE_TAGS.has(name);
    if (block) {
      out += ' ';
      stack.push(BLOCK_END);
    }
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  let text = collapseWhitespace(out);
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return { text, truncated };
}

// Inline-style hiding, anchored on a declaration boundary so custom
// properties such as `--x-display:none` do not match.
const HIDDEN_STYLE = /(?:^|[;\s])(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!\s*important\s*)?(?:;|$)/i;

/**
 * Hidden descendants are left out of element text, with the rules the
 * document builder uses for blocks (hidden attribute, aria-hidden="true",
 * inline display:none / visibility:hidden), so recipe text matches the text
 * grounded values were read from: "$12.99" stays "$12.99" when a site adds an
 * aria-hidden "$12<sup>99</sup>" next to it.
 */
export function isHidden(el: DomElement): boolean {
  const hidden = ownAttribute(el, 'hidden');
  if (hidden !== undefined) return true;
  const aria = ownAttribute(el, 'aria-hidden');
  if (aria !== undefined && aria.trim().toLowerCase() === 'true') return true;
  const style = ownAttribute(el, 'style');
  return style !== undefined && style.length > 0 && style.length < 2_000 && HIDDEN_STYLE.test(style);
}

function ownAttribute(el: DomElement, name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(el.attribs, name) ? el.attribs[name] : undefined;
}

/**
 * Own attribute value; attribute names are lower-cased by the HTML parser.
 * Own-property checks keep names like "constructor" from reaching the
 * prototype.
 */
export function readAttribute(el: DomElement, name: string): string | null {
  const attribs = el.attribs;
  if (Object.prototype.hasOwnProperty.call(attribs, name)) return attribs[name];
  const lower = name.toLowerCase();
  if (lower !== name && Object.prototype.hasOwnProperty.call(attribs, lower)) return attribs[lower];
  return null;
}

/**
 * Base URL for resolving relative links: the page's <base href> (resolved
 * against the page URL) when present and http(s), else the page URL. null
 * when neither is a valid absolute URL.
 */
export function effectiveBase(baseHref: string | undefined, pageUrl: string): URL | null {
  let page: URL | null = null;
  try {
    page = new URL(pageUrl);
  } catch {
    page = null;
  }
  if (baseHref !== undefined && baseHref.trim() !== '') {
    try {
      const base = page ? new URL(baseHref.trim(), page) : new URL(baseHref.trim());
      if (base.protocol === 'http:' || base.protocol === 'https:') return base;
    } catch {
      // fall through to the page URL
    }
  }
  return page;
}

const URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
export const MAX_URL_CHARS = 8_192;

/** Absolute URL for a link value; null for javascript:/data: and other schemes, or unparseable input. */
export function resolveUrl(value: string, base: URL | null): string | null {
  const v = value.trim();
  if (v === '' || v.length > MAX_URL_CHARS) return null;
  try {
    const url = base ? new URL(v, base) : new URL(v);
    if (!URL_PROTOCOLS.has(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}
