import type { StructuredDataItem, StructuredSource } from '../types.js';
import {
  type DomElement,
  type DomNode,
  type DomRoot,
  collapseWhitespace,
  isElement,
  isText,
  resolveUrl,
} from './dom.js';
import { parseJsonSafely } from './json.js';
import { DOCUMENT_LIMITS } from './limits.js';

// Structured data is read from the raw DOM (hidden elements included: it is
// machine-readable data, not visible text) and parsed, never executed.

export interface StructuredResult {
  items: StructuredDataItem[];
  /** <title> text (outside svg/math), whitespace-collapsed. */
  title?: string;
  /** og:title, used as a title fallback. */
  ogTitle?: string;
  warnings: string[];
}

const OG_PREFIXES = ['og:', 'product:', 'article:', 'book:', 'profile:', 'music:', 'video:'];
const STANDARD_META = new Set(['description', 'author', 'keywords']);
const URL_PROPS_HREF = new Set(['a', 'area', 'link']);
const URL_PROPS_SRC = new Set(['audio', 'embed', 'iframe', 'img', 'source', 'track', 'video']);
const MAX_PROPS_PER_ITEM = 200;
const MAX_VALUES_PER_PROP = 100;
const MAX_PENDING_TEXT_PROPS = 64;

interface MicrodataItem {
  obj: Record<string, unknown>;
  props: number;
}

/** Per-element microdata state; only allocated for elements that need it. */
interface MicrodataFrame {
  /** This element opened a microdata item (or a suppressed placeholder). */
  pushedItem: boolean;
  /** Pending text-valued itemprop resolved when the element closes. */
  textProp?: { target: MicrodataItem; names: string[]; start: number };
}

/** enter() result: do not visit the element's children. */
const SKIP_CHILDREN = null;

/** The "tail" of a type IRI: "https://schema.org/Product" → "Product". */
export function typeTail(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value.find((v) => typeof v === 'string') : value;
  if (typeof first !== 'string') return undefined;
  const t = first.trim();
  if (!t) return undefined;
  const cut = Math.max(t.lastIndexOf('/'), t.lastIndexOf('#'), t.lastIndexOf(':'));
  const tail = cut >= 0 ? t.slice(cut + 1) : t;
  return tail || undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function scriptText(el: DomElement): string {
  let s = '';
  for (const child of el.children) {
    if (isText(child)) s += child.data;
  }
  return s;
}

function mimeOf(typeAttr: string | undefined): string {
  if (!typeAttr) return '';
  const semi = typeAttr.indexOf(';');
  return (semi >= 0 ? typeAttr.slice(0, semi) : typeAttr).trim().toLowerCase();
}

/**
 * Split one JSON-LD document into items: top-level arrays and @graph members
 * become separate items. A @graph container that also carries its own @type
 * is kept as an item too (without the @graph array).
 */
export function flattenJsonLd(value: unknown, limit: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const queue: unknown[] = [value];
  let visited = 0;
  for (let qi = 0; qi < queue.length && out.length < limit; qi++) {
    // Bound work on adversarial arrays-of-arrays.
    if (++visited > 10_000) break;
    const v = queue[qi];
    if (Array.isArray(v)) {
      for (const x of v) queue.push(x);
    } else if (isPlainObject(v)) {
      const graph = v['@graph'];
      if (Array.isArray(graph) || isPlainObject(graph)) {
        if (v['@type'] !== undefined) {
          // fromEntries defines own properties, so a "__proto__" key from
          // JSON.parse stays data instead of becoming the copy's prototype.
          out.push(Object.fromEntries(Object.entries(v).filter(([k]) => k !== '@graph')));
        }
        queue.push(graph);
      } else {
        out.push(v);
      }
    }
  }
  return out;
}

class StructuredCollector {
  readonly jsonLd: StructuredDataItem[] = [];
  readonly embedded: StructuredDataItem[] = [];
  readonly microdata: Record<string, unknown>[] = [];
  readonly og: Record<string, string> = {};
  readonly meta: Record<string, string> = {};
  readonly warnings: string[] = [];
  title?: string;

  private readonly itemStack: Array<MicrodataItem | null> = [];
  private readonly textPieces: string[] = [];
  private textWaiters = 0;
  private propCount = 0;
  private oversizedScripts = 0;
  private failedScripts = 0;
  private hasOg = false;
  private hasMeta = false;

  constructor(private readonly base: URL | undefined) {}

  run(root: DomRoot): void {
    // Parallel arrays rather than frame objects: this walk visits every
    // element of the page, hidden ones included.
    const nodes: Array<DomElement | DomRoot> = [root];
    const next: number[] = [0];
    const states: Array<MicrodataFrame | undefined> = [undefined];
    while (nodes.length > 0) {
      const top = nodes.length - 1;
      const kids = nodes[top].children;
      const i = next[top];
      if (i < kids.length) {
        next[top] = i + 1;
        const child = kids[i];
        if (isText(child)) {
          if (this.textWaiters > 0) this.textPieces.push(child.data);
        } else if (isElement(child)) {
          const state = this.enter(child);
          if (state !== SKIP_CHILDREN) {
            nodes.push(child);
            next.push(0);
            states.push(state);
          }
        }
        continue;
      }
      nodes.pop();
      next.pop();
      const state = states.pop();
      if (state) this.exit(state);
    }
    if (this.oversizedScripts > 0) {
      this.warnings.push(`script_too_large: skipped ${this.oversizedScripts} script(s) over ${DOCUMENT_LIMITS.maxScriptChars} chars`);
    }
    if (this.failedScripts > 0) {
      this.warnings.push(`json_parse_failed: ${this.failedScripts} script(s) could not be parsed`);
    }
  }

  get ogItem(): Record<string, string> | undefined {
    return this.hasOg ? this.og : undefined;
  }

  get metaItem(): Record<string, string> | undefined {
    return this.hasMeta ? this.meta : undefined;
  }

  /**
   * SKIP_CHILDREN when the subtree is not visited; otherwise the element's
   * microdata state (undefined when it has none).
   */
  private enter(el: DomElement): MicrodataFrame | undefined | typeof SKIP_CHILDREN {
    const name = el.name;
    if (name === 'script') {
      this.handleScript(el);
      return SKIP_CHILDREN;
    }
    // Inert or foreign content: template contents are not part of the DOM,
    // and svg/math <title> elements are not the page title.
    if (name === 'style' || name === 'template' || name === 'svg' || name === 'math') return SKIP_CHILDREN;
    if (name === 'title') {
      if (this.title === undefined) {
        const t = collapseWhitespace(scriptText(el));
        if (t) this.title = t;
      }
      return SKIP_CHILDREN;
    }
    if (name === 'meta') this.handleMeta(el);
    else if (name === 'link') this.handleLink(el);
    const a = el.attribs;
    if (a.itemscope === undefined && a.itemprop === undefined) return undefined;
    const state: MicrodataFrame = { pushedItem: false };
    this.handleMicrodata(el, state);
    return state;
  }

  private exit(state: MicrodataFrame): void {
    const tp = state.textProp;
    if (tp) {
      this.addProp(tp.target, tp.names, this.textSince(tp.start));
      if (--this.textWaiters === 0) this.textPieces.length = 0;
    }
    if (state.pushedItem) this.itemStack.pop();
  }

  private textSince(start: number): string {
    // Bounded join: nested text-valued properties must not turn into O(n²).
    const max = DOCUMENT_LIMITS.maxMicrodataTextChars;
    let s = '';
    for (let i = start; i < this.textPieces.length && s.length <= max * 2; i++) s += this.textPieces[i];
    const t = collapseWhitespace(s);
    return t.length > max ? t.slice(0, max) : t;
  }

  private handleScript(el: DomElement): void {
    const mime = mimeOf(el.attribs.type);
    const isLd = mime === 'application/ld+json';
    const isJson = !isLd && mime.endsWith('json') && mime.includes('/');
    if (!isLd && !isJson) return;
    const raw = scriptText(el);
    if (raw.length > DOCUMENT_LIMITS.maxScriptChars) {
      this.oversizedScripts++;
      return;
    }
    if (!raw.trim()) return;
    const parsed = parseJsonSafely(raw, DOCUMENT_LIMITS.maxJsonDepth, true);
    if (!parsed.ok) {
      this.failedScripts++;
      return;
    }
    if (isLd) {
      for (const obj of flattenJsonLd(parsed.value, DOCUMENT_LIMITS.maxStructuredItems)) {
        if (this.jsonLd.length >= DOCUMENT_LIMITS.maxStructuredItems) break;
        this.jsonLd.push(makeItem('json-ld', typeTail(obj['@type']), obj));
      }
    } else if (this.embedded.length < DOCUMENT_LIMITS.maxStructuredItems) {
      const v = parsed.value;
      this.embedded.push(makeItem('embedded-json', isPlainObject(v) ? typeTail(v['@type']) : undefined, v));
    }
  }

  private handleMeta(el: DomElement): void {
    const a = el.attribs;
    const content = a.content;
    if (content === undefined) return;
    const key = (a.property ?? a.name ?? '').trim().toLowerCase();
    if (!key || key === '__proto__') return;
    const value = collapseWhitespace(content).slice(0, DOCUMENT_LIMITS.maxMetaValueChars);
    if (!value) return;
    if (OG_PREFIXES.some((p) => key.startsWith(p))) {
      // First value wins (og:image repeats list alternates after the primary).
      if (!Object.hasOwn(this.og, key)) {
        this.og[key] = value;
        this.hasOg = true;
      }
    } else if (a.name !== undefined && STANDARD_META.has(key) && !Object.hasOwn(this.meta, key)) {
      this.meta[key] = value;
      this.hasMeta = true;
    }
  }

  private handleLink(el: DomElement): void {
    const rel = (el.attribs.rel ?? '').toLowerCase().split(/\s+/);
    if (!rel.includes('canonical') || Object.hasOwn(this.meta, 'canonical')) return;
    const href = resolveUrl(el.attribs.href ?? '', this.base, 'href');
    if (href) {
      this.meta.canonical = href;
      this.hasMeta = true;
    }
  }

  private handleMicrodata(el: DomElement, frame: MicrodataFrame): void {
    const a = el.attribs;
    const isScope = a.itemscope !== undefined;
    const propAttr = a.itemprop;
    const top = this.itemStack.length > 0 ? this.itemStack[this.itemStack.length - 1] : undefined;
    const names = propAttr !== undefined ? propNames(propAttr) : [];

    if (isScope) {
      // Beyond the depth cap a null placeholder swallows nested properties so
      // they cannot attach to the wrong (outer) item.
      if (top === null || this.itemStack.length >= DOCUMENT_LIMITS.maxMicrodataDepth) {
        this.itemStack.push(null);
        frame.pushedItem = true;
        return;
      }
      const obj: Record<string, unknown> = {};
      const type = typeTail(a.itemtype?.trim().split(/\s+/)[0]);
      if (type) obj['@type'] = type;
      if (a.itemid) obj['@id'] = a.itemid.trim().slice(0, DOCUMENT_LIMITS.maxUrlChars);
      const item: MicrodataItem = { obj, props: 0 };
      if (top && names.length > 0) this.addProp(top, names, obj);
      else if (this.microdata.length < DOCUMENT_LIMITS.maxStructuredItems) this.microdata.push(obj);
      this.itemStack.push(item);
      frame.pushedItem = true;
      return;
    }

    if (!top || names.length === 0) return;
    const value = this.attrValue(el);
    if (value !== undefined) {
      this.addProp(top, names, value);
      return;
    }
    // Text values cost a bounded join each. Nested text-valued properties are
    // only legitimate a few levels deep, so pending ones are capped too.
    if (this.textWaiters >= MAX_PENDING_TEXT_PROPS || !this.accepts(top, names)) return;
    frame.textProp = { target: top, names, start: this.textPieces.length };
    this.textWaiters++;
  }

  /** Value from attributes, or undefined when the text content is the value. */
  private attrValue(el: DomElement): string | undefined {
    const a = el.attribs;
    const name = el.name;
    if (name === 'meta') return collapseWhitespace(a.content ?? '');
    if (URL_PROPS_HREF.has(name)) return resolveUrl(a.href ?? '', this.base, 'href') ?? '';
    if (URL_PROPS_SRC.has(name)) return resolveUrl(a.src ?? '', this.base, 'src') ?? '';
    if (name === 'object') return resolveUrl(a.data ?? '', this.base, 'src') ?? '';
    if ((name === 'data' || name === 'meter') && a.value !== undefined) return collapseWhitespace(a.value);
    if (name === 'time' && a.datetime !== undefined) return collapseWhitespace(a.datetime);
    // Non-standard but ubiquitous: <span itemprop="price" content="12.99">.
    if (a.content !== undefined) return collapseWhitespace(a.content);
    return undefined;
  }

  private accepts(item: MicrodataItem, names: string[]): boolean {
    if (this.propCount >= DOCUMENT_LIMITS.maxMicrodataProps || item.props >= MAX_PROPS_PER_ITEM) return false;
    return names.some((n) => {
      const v = Object.hasOwn(item.obj, n) ? item.obj[n] : undefined;
      return !Array.isArray(v) || v.length < MAX_VALUES_PER_PROP;
    });
  }

  private addProp(item: MicrodataItem, names: string[], value: unknown): void {
    for (const name of names) {
      if (this.propCount >= DOCUMENT_LIMITS.maxMicrodataProps || item.props >= MAX_PROPS_PER_ITEM) return;
      // hasOwn: names like "toString" must not see inherited members.
      const existing = Object.hasOwn(item.obj, name) ? item.obj[name] : undefined;
      if (existing === undefined) item.obj[name] = value;
      else if (Array.isArray(existing)) {
        if (existing.length >= MAX_VALUES_PER_PROP) continue;
        existing.push(value);
      } else item.obj[name] = [existing, value];
      this.propCount++;
      item.props++;
    }
  }
}

function propNames(attr: string): string[] {
  const out: string[] = [];
  for (const n of attr.trim().split(/\s+/)) {
    if (n && n !== '__proto__' && n.length <= 100 && out.length < 5) out.push(n);
  }
  return out;
}

function makeItem(source: StructuredSource, type: string | undefined, data: unknown): StructuredDataItem {
  // ids are assigned once the final order is known.
  return type ? { id: '', source, type, data } : { id: '', source, data };
}

/**
 * Collect structured data in priority order (json-ld, embedded-json,
 * microdata, opengraph, meta), capped at maxStructuredItems in total. The
 * single opengraph and meta items are always kept: their slots are reserved
 * before the per-script lists are filled.
 */
export function extractStructured(root: DomRoot, base: URL | undefined): StructuredResult {
  const c = new StructuredCollector(base);
  c.run(root);

  const tail: StructuredDataItem[] = [];
  const ogItem = c.ogItem;
  const metaItem = c.metaItem;
  if (ogItem) tail.push(makeItem('opengraph', ogItem['og:type'], ogItem));
  if (metaItem) tail.push(makeItem('meta', undefined, metaItem));

  const budget = DOCUMENT_LIMITS.maxStructuredItems - tail.length;
  const microdata = c.microdata
    .filter((obj) => Object.keys(obj).length > 0)
    .map((obj) => makeItem('microdata', typeof obj['@type'] === 'string' ? obj['@type'] : undefined, obj));
  const head = [...c.jsonLd, ...c.embedded, ...microdata];
  const warnings = [...c.warnings];
  if (head.length > budget) warnings.push(`structured_items_capped: kept ${DOCUMENT_LIMITS.maxStructuredItems}`);
  const items = [...head.slice(0, Math.max(0, budget)), ...tail];
  items.forEach((item, i) => {
    item.id = `sd${i}`;
  });
  return { items, title: c.title, ogTitle: ogItem?.['og:title'], warnings };
}

/** Resolve the effective base URL: <base href> (http/https only) over the page URL. */
export function resolveBaseUrl(pageUrl: string, head: DomElement | undefined): URL | undefined {
  let page: URL | undefined;
  try {
    page = new URL(pageUrl);
  } catch {
    page = undefined;
  }
  let base = page;
  for (const child of (head?.children ?? []) as DomNode[]) {
    if (!isElement(child) || child.name !== 'base' || child.attribs.href === undefined) continue;
    const href = resolveUrl(child.attribs.href, page, 'src');
    if (href) base = new URL(href);
    break;
  }
  // Credentials in the page URL must not be copied into every resolved link.
  if (base && (base.username || base.password)) {
    base = new URL(base.href);
    base.username = '';
    base.password = '';
  }
  return base;
}
