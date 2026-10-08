import { createRequire } from 'node:module';
import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import type { OutputFormat } from '@scrapeforge/shared';

/**
 * Multi-strategy content extraction pipeline (CPU-bound).
 *
 * This module runs inside a Piscina worker thread — see ./pipeline-worker.ts
 * and ./pipeline.ts. Keeping it free of BullMQ / Redis / DB imports is what
 * lets it ship cleanly across the thread boundary.
 *
 * Cost model (500 KB page): the HTML is parsed once with cheerio (parse5, the
 * parser JSDOM uses) and that tree serves meta tags, JSON-LD, noise removal,
 * the density/largest-block strategies and the `html` format. Readability
 * mutates its document, so it gets its own linkedom copy, built from the
 * parse5 serialization so it sees the same html/head/body structure JSDOM
 * would. Markdown is generated straight from Readability's DOM node.
 */

export interface ExtractionResult {
  html?: string;
  markdown?: string;
  text?: string;
  json?: Record<string, unknown> | Array<Record<string, unknown>>;
  extractionMethod?: string;
  title?: string;
  description?: string;
  /**
   * Only the leading part of the input was extracted: it exceeded
   * EXTRACTION_MAX_INPUT_BYTES (cut by the pool, pipeline.ts) or
   * `limits.maxElements`.
   */
  truncated?: boolean;
}

export interface ExtractionLimits {
  /**
   * Elements parsed at most; the input is cut before the next start tag and
   * the result flagged `truncated`. Parse memory and time grow with the
   * element count, not the byte size: 1.2 MB of tiny divs has 100,000.
   */
  maxElements?: number;
}

export async function extractContent(
  rawHtml: string,
  url: string,
  formats: OutputFormat[],
  limits: ExtractionLimits = {},
): Promise<ExtractionResult> {
  const wantMarkdown = formats.includes('markdown');
  const wantText = formats.includes('text');
  const wantHtml = formats.includes('html');

  const budget = limits.maxElements === undefined
    ? { html: rawHtml, truncated: false }
    : truncateToElementBudget(rawHtml, limits.maxElements);
  const page = new ParsedPage(budget.html);

  // Always resolve the page title + description. They're cheap to derive
  // (a few lookups on the shared tree) and almost every downstream consumer
  // wants them — playground UI, webhook recipients, cached-tier listings, etc.
  const meta = guarded('meta', () => extractMetaTags(page.$));

  let extracted: ExtractedContent | undefined;
  let markdown: string | undefined;
  if (wantMarkdown || wantText) {
    extracted = runExtractionChain(page, url, meta);
    if (wantMarkdown) {
      const rawMd = cleanMarkdown(contentToMarkdown(extracted));

      // Readability (and JSON-LD) strip the article's H1 because they treat
      // it as metadata. Downstream consumers (RAG pipelines, doc importers,
      // our own markdown-fidelity tests) expect the title as a leading H1 —
      // match the de-facto convention Firecrawl / Reader / Mercury all use.
      const titleForHeading = extracted.title || meta?.title;
      const startsWithHeading = /^\s*#\s+/.test(rawMd);
      markdown = titleForHeading && !startsWithHeading
        ? `# ${titleForHeading.trim()}\n\n${rawMd}`
        : rawMd;
    }
  }

  // Requested formats come first: worker.ts streams the first key of the
  // result as the SSE `content` event.
  const result: ExtractionResult = {};
  if (wantHtml) result.html = page.cleanHtml();
  if (markdown !== undefined) result.markdown = markdown;
  if (wantText && extracted) result.text = extracted.text;
  if (extracted) result.extractionMethod = extracted.method;

  const resolvedTitle = extracted?.title || meta?.title;
  if (resolvedTitle) result.title = resolvedTitle.trim();
  if (meta?.description) result.description = meta.description.trim();
  if (budget.truncated) result.truncated = true;

  return result;
}

/** parse5 reads these elements' content as text (no elements inside). */
const NO_ELEMENT_CONTENT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);

function isAsciiAlpha(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function endsTagName(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13 || c === 47 || c === 62; // space \t \n \f \r / >
}

/**
 * Cuts `html` before its (maxElements + 1)-th start tag. Counts what an HTML
 * tokenizer would see as start tags: comments and the content of
 * NO_ELEMENT_CONTENT elements are skipped, and nothing after <plaintext>
 * is markup. Linear in the input.
 */
export function truncateToElementBudget(html: string, maxElements: number): { html: string; truncated: boolean } {
  let count = 0;
  let i = html.indexOf('<');
  while (i !== -1 && i + 1 < html.length) {
    const c = html.charCodeAt(i + 1);
    if (isAsciiAlpha(c)) {
      if (++count > maxElements) return { html: html.slice(0, i), truncated: true };
      let end = i + 2;
      while (end < html.length && !endsTagName(html.charCodeAt(end))) end++;
      const name = end - i - 1 <= 9 ? html.slice(i + 1, end).toLowerCase() : '';
      if (name === 'plaintext') break;
      if (NO_ELEMENT_CONTENT.has(name)) {
        const close = indexOfEndTag(html, name, end);
        if (close === -1) break;
        i = html.indexOf('<', close + 2);
      } else {
        i = html.indexOf('<', end);
      }
    } else if (c === 33 && html.startsWith('<!--', i)) {
      const close = html.indexOf('-->', i + 4);
      if (close === -1) break;
      i = html.indexOf('<', close + 3);
    } else {
      i = html.indexOf('<', i + 1);
    }
  }
  return { html, truncated: false };
}

/** Index of the next `</name` (any case) at or after `from`, or -1. */
function indexOfEndTag(html: string, name: string, from: number): number {
  for (let at = html.indexOf('</', from); at !== -1; at = html.indexOf('</', at + 2)) {
    if (html.slice(at + 2, at + 2 + name.length).toLowerCase() === name) return at;
  }
  return -1;
}

// ─────────────────────────────────────────────────────────────
// Shared parse
// ─────────────────────────────────────────────────────────────

/**
 * One cheerio (parse5) tree per call. Strategies that need the page as
 * served (meta tags, JSON-LD, Readability's input, the fallback text) read it
 * first; `withoutNoise()` then strips navigation, ads and scripts in place
 * for the strategies that work on the cleaned page.
 */
class ParsedPage {
  readonly $: cheerio.CheerioAPI;
  private noiseRemoved = false;
  private cleaned: string | undefined;
  private shapeOf: PageShape | undefined;

  constructor(readonly rawHtml: string) {
    this.$ = cheerio.load(rawHtml);
  }

  /** One pass over the parsed tree: nesting depth, element count, inert content. */
  shape(): PageShape {
    if (this.shapeOf === undefined) {
      let depth = 0;
      let elements = 0;
      let depthSum = 0;
      let textDepth = 0;
      let templates = 0;
      const rawText: DhElement[] = [];
      // [node, level, inside a <template>'s content]
      const stack: Array<[DhNode, number, boolean]> = [[this.$.root()[0] as unknown as DhNode, 0, false]];
      while (stack.length > 0) {
        const [node, level, inTemplate] = stack.pop()!;
        if (level > depth) depth = level;
        let childInTemplate = inTemplate;
        if (node.type === 'text') textDepth += (node as DhText).data.length * level;
        if (isElement(node)) {
          elements++;
          depthSum += level;
          if (!inTemplate && node.namespace === HTML_NS) {
            if (node.name === 'template') {
              templates++;
              childInTemplate = true;
            } else if (PARSE5_RAW_TEXT.has(node.name)) {
              rawText.push(node);
            }
          }
        }
        if (hasChildren(node)) {
          // Reversed so the pops (and `rawText`) follow document order.
          for (let i = node.children.length - 1; i >= 0; i--) stack.push([node.children[i]!, level + 1, childInTemplate]);
        }
      }
      this.shapeOf = { depth, elements, depthSum, textDepth, templates, rawText };
    }
    return this.shapeOf;
  }

  /** Serialization of the unmodified tree (Readability's input). */
  pristineHtml(): string {
    if (this.noiseRemoved) throw new Error('pristineHtml() after noise removal');
    return this.$.html();
  }

  withoutNoise(): cheerio.CheerioAPI {
    if (!this.noiseRemoved) {
      removeNoise(this.$);
      this.noiseRemoved = true;
    }
    return this.$;
  }

  /** The `html` format: the page without noise, as a full document. */
  cleanHtml(): string {
    if (this.cleaned === undefined) {
      try {
        this.cleaned = this.withoutNoise().html();
      } catch (err) {
        // parse5's serializer recurses once per nesting level; pathological
        // nesting overflows the stack. linkedom serializes iteratively.
        logStageFailure('clean-html', err);
        this.cleaned = cleanHtmlWithLinkedom(this.rawHtml);
      }
    }
    return this.cleaned;
  }
}

const NOISE_SELECTOR =
  'script, style, noscript, iframe, svg, nav, footer, header, aside, ' +
  '.ad, .ads, .advertisement, [class*="cookie"], [class*="banner"], ' +
  '[class*="popup"], [class*="modal"], [id*="cookie"], [id*="banner"], ' +
  '[id*="popup"], [id*="modal"], [aria-hidden="true"]';

function removeNoise($: cheerio.CheerioAPI): void {
  $(NOISE_SELECTOR).remove();
}

function cleanHtmlWithLinkedom(rawHtml: string): string {
  try {
    const { document } = parseHTML(rawHtml);
    for (const el of document.querySelectorAll(NOISE_SELECTOR)) el.remove();
    return document.toString();
  } catch (err) {
    logStageFailure('clean-html-fallback', err);
    return '';
  }
}

function guarded<T>(stage: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    logStageFailure(stage, err);
    return null;
  }
}

// Page content is never logged (it can carry tokens or personal data).
function logStageFailure(stage: string, err: unknown): void {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.warn(`[extraction] ${stage} failed, falling back: ${message.slice(0, 200)}`);
}

// ─────────────────────────────────────────────────────────────
// Extraction chain
// ─────────────────────────────────────────────────────────────

interface ExtractedContent {
  title?: string;
  text: string;
  /** HTML to convert to markdown (JSON-LD, density, largest-block, fallback). */
  html?: string;
  /** Readability's article element (linkedom); converted without re-parsing. */
  node?: MdNode;
  method: string;
}

/**
 * Readability's cost grows with elements x nesting depth: scoring and
 * cleanup re-read each candidate's text and links, and it re-parses the
 * page for each of up to four passes. Measured on linkedom, Readability
 * alone: 20-290 us per element (flat paragraphs to inline links nested 50
 * deep), ~4 us per unit of `depthSum` and ~6 ns per unit of `textDepth`.
 * These limits keep it under ~10 s; larger pages take the linear
 * strategies. Real pages are far below them: a 500 KB article has ~2,700
 * elements, a 10 MB one ~55,000.
 */
const READABILITY_LIMITS = {
  /** Browsers' HTML parsers stop nesting at 512 levels; deeper trees are not real layouts. */
  depth: 512,
  elements: 30_000,
  depthSum: 1_500_000,
  textDepth: 800_000_000,
};

function readabilityAffordable(shape: PageShape): boolean {
  return shape.depth <= READABILITY_LIMITS.depth
    && shape.elements <= READABILITY_LIMITS.elements
    && shape.depthSum <= READABILITY_LIMITS.depthSum
    && shape.textDepth <= READABILITY_LIMITS.textDepth;
}

interface PageMeta {
  title: string;
  description: string;
}

function runExtractionChain(page: ParsedPage, url: string, meta: PageMeta | null): ExtractedContent {
  const jsonLd = guarded('json-ld', () => extractJsonLd(page.$));
  if (jsonLd && jsonLd.text.length > 200) return jsonLd;

  // Pages Readability cannot finish in reasonable time (see
  // READABILITY_LIMITS: 9 s at 5,000 nested levels, minutes for 100,000
  // paragraphs 500 levels deep) go to the linear strategies below.
  if (readabilityAffordable(page.shape())) {
    const readable = guarded('readability', () => extractReadability(page, url));
    if (readable && readable.text.length > 200) return readable;
  }

  // Taken before noise removal, which deletes part of what it reads. Only
  // the last-resort fallback uses it.
  const bodyText = guarded('plain-text', () => plainBodyText(page.$)) ?? '';

  const tree = guarded('noise-removal', () => {
    const $ = page.withoutNoise();
    return { $, stats: computeSubtreeStats($.root()[0] as unknown as DhParent) };
  });
  if (tree) {
    const dense = guarded('paragraph-density', () => extractByParagraphDensity(tree.$, tree.stats));
    if (dense && dense.text.length > 200) return dense;

    const largest = guarded('largest-block', () => extractLargestBlock(tree.$, tree.stats));
    if (largest && largest.text.length > 100) return largest;
  }

  const fallbackText = [meta?.title, meta?.description, bodyText]
    .filter(Boolean)
    .join('\n\n');

  return {
    text: fallbackText,
    html: page.cleanHtml(),
    method: 'fallback',
  };
}

// "WebPage" is deliberately excluded: homepages use it with a tiny
// description that tricks the extractor into returning boilerplate.
const ARTICLE_TYPES = [
  'NewsArticle',
  'Article',
  'BlogPosting',
  'Report',
  'TechArticle',
  'SocialMediaPosting',
  'AnalysisNewsArticle',
  'BackgroundNewsArticle',
  'OpinionNewsArticle',
  'ReportageNewsArticle',
  'ReviewNewsArticle',
];

function extractJsonLd($: cheerio.CheerioAPI): ExtractedContent | null {
  const blocks: unknown[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html();
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) for (const item of parsed) blocks.push(item);
      else blocks.push(parsed);
    } catch { /* skip malformed */ }
  });

  // One level of @graph, as before. Spreading a non-array @graph threw and
  // failed the whole extraction; a single object is now taken as one node.
  for (const block of [...blocks]) {
    if (block && typeof block === 'object' && '@graph' in block) {
      const graph = (block as Record<string, unknown>)['@graph'];
      if (Array.isArray(graph)) for (const item of graph) blocks.push(item);
      else if (graph && typeof graph === 'object') blocks.push(graph);
    }
  }

  let best: { body: string; title: string } | null = null;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const obj = block as Record<string, unknown>;

    const type = String(obj['@type'] || '');
    if (!ARTICLE_TYPES.some((t) => type.includes(t))) continue;

    // Non-string values (arrays, objects) used to crash the conversion below.
    const body = firstString(obj.articleBody, obj.text, obj.description);
    if (body.length < 200) continue;
    if (!best || body.length > best.body.length) {
      best = { body, title: firstString(obj.headline, obj.name) };
    }
  }

  if (!best) return null;

  const fullText = best.title ? `${best.title}\n\n${best.body}` : best.body;
  const fullHtml = best.title
    ? `<h1>${escapeHtml(best.title)}</h1>${bodyToHtml(best.body)}`
    : bodyToHtml(best.body);

  return {
    title: best.title,
    text: fullText,
    html: fullHtml,
    method: 'json-ld',
  };
}

/** First truthy string, like `a || b || ''` over string-typed values. */
function firstString(...values: unknown[]): string {
  for (const v of values) if (typeof v === 'string' && v) return v;
  return '';
}

function bodyToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim())}</p>`)
    .join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function extractMetaTags($: cheerio.CheerioAPI): PageMeta | null {
  const get = (selectors: string[]): string => {
    for (const sel of selectors) {
      const val = $(sel).attr('content')?.trim();
      if (val && val.length > 5) return val;
    }
    return '';
  };

  const title =
    get(['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
    $('title').text().trim();

  const description = get([
    'meta[property="og:description"]',
    'meta[name="description"]',
    'meta[name="twitter:description"]',
  ]);

  if (!title && !description) return null;
  return { title, description };
}

// ── Readability over linkedom ────────────────────────────────

interface LkElement {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  className?: unknown;
}

interface ReadabilityInternals {
  _isProbablyVisible(node: LkElement): boolean;
}

function extractReadability(page: ParsedPage, url: string): ExtractedContent | null {
  // parse5's serialization always has html/head/body, so linkedom (whose
  // htmlparser2 does not synthesize omitted tags) builds the tree JSDOM
  // would. Pathologically deep pages overflow the serializer; parse the raw
  // HTML directly then.
  let source: string;
  try {
    source = page.pristineHtml();
  } catch (err) {
    logStageFailure('readability-input', err);
    source = page.rawHtml;
  }
  const { document } = parseHTML(source);
  const shape = page.shape();
  if (shape.templates > 0 || shape.rawText.length > 0) {
    matchParse5InertContent(document.documentElement as unknown as LkNode | null, shape.rawText);
  }
  // htmlparser2 emits a separate text node on each side of every character
  // reference ("a &gt; b" → "a ", ">", " b"); parse5 merges them. Text-node
  // boundaries matter: turndown's escapes are anchored to them (`^>`, `^-`,
  // `^1. `...) and Readability walks sibling text nodes.
  document.normalize();
  emulateJsdomDocument(document, page.$, url);

  const reader = new Readability<unknown>(document as unknown as Document, {
    serializer: (el) => el,
  });
  (reader as unknown as ReadabilityInternals)._isProbablyVisible = isProbablyVisible;
  const article = reader.parse();
  if (!article) return null;

  const node = article.content as MdNode;
  return {
    title: article.title,
    text: article.textContent.trim(),
    // An empty article converts to markdown from its text, as before.
    ...(node.firstChild ? { node } : { html: '' }),
    method: 'readability',
  };
}

/**
 * Readability reads `document.title`, `baseURI` and `documentURI`. linkedom
 * neither resolves `<base href>` against the page URL nor knows the URL, so
 * relative links would stay relative; its title getter skips JSDOM's
 * whitespace collapsing. Both are set from the parse5 tree with JSDOM's rules.
 */
function emulateJsdomDocument(document: object, $: cheerio.CheerioAPI, url: string): void {
  let documentUrl: string | null = null;
  try {
    documentUrl = new URL(url).href;
  } catch { /* relative links then stay relative */ }

  const root = $.root()[0] as unknown as DhParent;
  let baseUrl = documentUrl;
  const base = findFirstElement(root, (el) => el.name === 'base' && el.attribs.href !== undefined);
  if (base) {
    try {
      baseUrl = new URL(base.attribs.href!, documentUrl ?? undefined).href;
    } catch { /* invalid href: the document URL stays the base */ }
  }

  const titleEl = findFirstElement(root, (el) => el.name === 'title' && el.namespace === HTML_NS);
  let title = '';
  if (titleEl) {
    for (const child of titleEl.children) if (child.type === 'text') title += (child as DhText).data;
  }
  title = title.replace(/[ \t\n\f\r]+/g, ' ').replace(/^ | $/g, '');

  Object.defineProperties(document, {
    title: { value: title, configurable: true },
    baseURI: { value: baseUrl, configurable: true },
    documentURI: { value: documentUrl, configurable: true },
  });
}

const HTML_NS = 'http://www.w3.org/1999/xhtml';

/**
 * Elements whose content parse5 (and so JSDOM) reads as plain text but
 * htmlparser2 parses as markup. parse5 serializes that text verbatim, so
 * linkedom would turn `<noembed><b>x</b></noembed>` into a <b> element.
 * <noscript> is left out on purpose: JSDOM parsed it with scripting
 * disabled, as markup, which is also what linkedom does.
 */
const PARSE5_RAW_TEXT = new Set(['iframe', 'noembed', 'noframes', 'plaintext', 'xmp']);

interface PageShape {
  depth: number;
  elements: number;
  /** Sum of the elements' nesting levels. */
  depthSum: number;
  /** Sum of each text node's length times its nesting level. */
  textDepth: number;
  /** HTML <template> elements outside other templates' content. */
  templates: number;
  /** PARSE5_RAW_TEXT elements outside template content, in document order. */
  rawText: DhElement[];
}

/** The linkedom node surface used to repair its tree. */
interface LkNode {
  nodeType: number;
  localName?: string;
  namespaceURI?: string | null;
  firstChild: LkNode | null;
  nextSibling: LkNode | null;
  parentNode: LkNode | null;
  textContent: string | null;
  removeChild(child: LkNode): unknown;
}

/**
 * Makes the linkedom copy hold what JSDOM's tree held: template contents
 * live in an inert fragment (not in the element's children, where linkedom
 * puts them) and PARSE5_RAW_TEXT elements hold one text node. `rawText`
 * are the parse5 elements in document order; the two trees list the same
 * elements unless the markup is too broken to pair them, in which case
 * only the templates are repaired.
 */
function matchParse5InertContent(root: LkNode | null, rawText: DhElement[]): void {
  const templates: LkNode[] = [];
  const rawTargets: LkNode[] = [];
  // Document order without recursion; neither kind is descended into. The
  // walk starts at <html>: linkedom keeps the doctype out of the sibling
  // chain, and parse5's serialization has nothing else outside <html>.
  let node: LkNode | null = root;
  while (node !== null) {
    let descend = true;
    if (node.nodeType === ELEMENT_NODE && (node.namespaceURI ?? HTML_NS) === HTML_NS) {
      if (node.localName === 'template') {
        templates.push(node);
        descend = false;
      } else if (node.localName !== undefined && PARSE5_RAW_TEXT.has(node.localName)) {
        rawTargets.push(node);
        descend = false;
      }
    }
    if (descend && node.firstChild !== null) {
      node = node.firstChild;
      continue;
    }
    while (node !== null && node !== root && node.nextSibling === null) node = node.parentNode;
    node = node === null || node === root ? null : node.nextSibling;
  }

  for (const template of templates) {
    while (template.firstChild !== null) template.removeChild(template.firstChild);
  }
  const paired = rawTargets.length === rawText.length
    && rawTargets.every((target, i) => target.localName === rawText[i]!.name);
  if (paired) {
    rawTargets.forEach((target, i) => {
      target.textContent = textOf(rawText[i]!);
    });
  }
}

/**
 * Readability's visibility test, reading the inline style the way JSDOM's
 * CSSStyleDeclaration does (case-insensitive property names, `!important`
 * stripped). linkedom's `style.display` returns "none !important" and
 * ignores "DISPLAY: none", which would let hidden text into the article.
 */
function isProbablyVisible(node: LkElement): boolean {
  const style = node.getAttribute('style');
  const declared = style ? inlineStyle(style) : null;
  const className = node.className;
  // Keywords compare case-insensitively, as in browsers. JSDOM kept
  // "DISPLAY: NONE" as "NONE", which Readability's `!= "none"` let through.
  return (declared?.get('display') ?? '').toLowerCase() !== 'none'
    && (declared?.get('visibility') ?? '').toLowerCase() !== 'hidden'
    && !node.hasAttribute('hidden')
    && (!node.hasAttribute('aria-hidden') || node.getAttribute('aria-hidden') !== 'true'
      || (typeof className === 'string' && className.indexOf('fallback-image') !== -1));
}

/** Declarations of a style attribute; later declarations win. */
function inlineStyle(style: string): Map<string, string> {
  const out = new Map<string, string>();
  const css = style.replace(/\/\*[\s\S]*?\*\//g, '');
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let i = 0; i <= css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if ((ch === ';' && depth === 0) || i === css.length) {
      const decl = css.slice(start, i);
      start = i + 1;
      const colon = decl.indexOf(':');
      if (colon < 0) continue;
      const name = decl.slice(0, colon).trim().toLowerCase();
      const value = decl.slice(colon + 1).replace(/!\s*important\s*$/i, '').trim();
      if (name) out.set(name, value);
    }
  }
  return out;
}

// ── Density and largest-block over the cleaned tree ──────────

// Minimal structural view of the domhandler nodes cheerio produces.
interface DhNode {
  type: string;
  parent: DhNode | null;
}
interface DhText extends DhNode {
  data: string;
}
interface DhParent extends DhNode {
  children: DhNode[];
}
interface DhElement extends DhParent {
  name: string;
  attribs: Record<string, string | undefined>;
  namespace?: string;
}

function hasChildren(node: DhNode): node is DhParent {
  return Object.prototype.hasOwnProperty.call(node, 'children');
}

/** domutils' isTag: what cheerio's `.children()` and selectors treat as elements. */
function isElement(node: DhNode): node is DhElement {
  return node.type === 'tag' || node.type === 'script' || node.type === 'style';
}

/** Descendants of `root` in document order (iterative: no stack limit). */
function descendants(root: DhParent): DhNode[] {
  const out: DhNode[] = [];
  const stack: DhNode[] = [];
  for (let i = root.children.length - 1; i >= 0; i--) stack.push(root.children[i]!);
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    if (hasChildren(node)) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return out;
}

/** First element in tree order passing `test`, outside <template> content (not in a DOM's tree). */
function findFirstElement(root: DhParent, test: (el: DhElement) => boolean): DhElement | null {
  const stack: DhNode[] = [];
  for (let i = root.children.length - 1; i >= 0; i--) stack.push(root.children[i]!);
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isElement(node)) {
      if (test(node)) return node;
      if (node.name === 'template' && node.namespace === HTML_NS) continue;
    }
    if (hasChildren(node)) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return null;
}

/**
 * cheerio's `.text()` (domutils textContent) without recursion: the data of
 * every text node below `root`, in document order. Elements for which `skip`
 * returns true are left out with their subtrees.
 */
function textOf(root: DhNode, skip?: (el: DhElement) => boolean): string {
  if (root.type === 'text') return (root as DhText).data;
  if (!hasChildren(root)) return '';
  let out = '';
  const stack: DhNode[] = [];
  for (let i = root.children.length - 1; i >= 0; i--) stack.push(root.children[i]!);
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'text') {
      out += (node as DhText).data;
    } else if (hasChildren(node) && !(skip && isElement(node) && skip(node))) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
    }
  }
  return out;
}

/** `$('body').text()` after removing script/style/noscript, normalized. */
function plainBodyText($: cheerio.CheerioAPI): string {
  const root = $.root()[0] as unknown as DhParent;
  const skip = (el: DhElement) => el.name === 'script' || el.name === 'style' || el.name === 'noscript';
  let text = '';
  for (const node of descendants(root)) {
    // Nested <body> cannot come out of parse5; any body below another is skipped.
    if (isElement(node) && node.name === 'body' && !hasAncestorNamed(node, 'body')) text += textOf(node, skip);
  }
  return text.replace(/\s+/g, ' ').trim();
}

function hasAncestorNamed(node: DhNode, name: string): boolean {
  for (let p = node.parent; p; p = p.parent) if (isElement(p) && p.name === name) return true;
  return false;
}

/**
 * Per-node text measures, computed bottom-up in one pass so the density and
 * largest-block strategies stay linear (they used to re-read every
 * candidate's subtree: quadratic in nesting depth, and recursive).
 *
 * - `len`/`lead`/`trail`: length of the subtree's text and of its leading /
 *   trailing whitespace (`lead === len` for whitespace-only text), enough for
 *   `text().trim().length`.
 * - `norm`/`normStartsWs`/`normEndsWs`: length after collapsing each
 *   whitespace run to one space, enough for
 *   `text().replace(/\s+/g, ' ').trim().length`.
 * - `pCount`/`pTrimmedLen`: number of `<p>` descendants and the sum of their
 *   trimmed text lengths (`$(el).find('p')`).
 */
interface SubtreeStats {
  len: number;
  lead: number;
  trail: number;
  norm: number;
  normStartsWs: boolean;
  normEndsWs: boolean;
  pCount: number;
  pTrimmedLen: number;
}

function textStats(data: string): SubtreeStats {
  const len = data.length;
  let lead = 0;
  while (lead < len && isWhitespaceCode(data.charCodeAt(lead))) lead++;
  let trail = 0;
  if (lead < len) while (trail < len && isWhitespaceCode(data.charCodeAt(len - 1 - trail))) trail++;
  else trail = len;
  let norm = 0;
  let inWs = false;
  for (let i = 0; i < len; i++) {
    const ws = isWhitespaceCode(data.charCodeAt(i));
    if (!ws || !inWs) norm++;
    inWs = ws;
  }
  return {
    len,
    lead,
    trail,
    norm,
    normStartsWs: len > 0 && lead > 0,
    normEndsWs: len > 0 && trail > 0,
    pCount: 0,
    pTrimmedLen: 0,
  };
}

const EMPTY_STATS: SubtreeStats = {
  len: 0, lead: 0, trail: 0, norm: 0, normStartsWs: false, normEndsWs: false, pCount: 0, pTrimmedLen: 0,
};

function trimmedLength(s: SubtreeStats): number {
  return s.lead === s.len ? 0 : s.len - s.lead - s.trail;
}

function normalizedTrimmedLength(s: SubtreeStats): number {
  return Math.max(0, s.norm - (s.normStartsWs ? 1 : 0) - (s.normEndsWs ? 1 : 0));
}

function computeSubtreeStats(root: DhParent): Map<DhNode, SubtreeStats> {
  const stats = new Map<DhNode, SubtreeStats>();
  const order = descendants(root);
  order.unshift(root);
  // Reverse document order visits every child before its parent.
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i]!;
    if (node.type === 'text') {
      stats.set(node, textStats((node as DhText).data));
      continue;
    }
    if (!hasChildren(node)) {
      stats.set(node, EMPTY_STATS);
      continue;
    }
    const acc = { ...EMPTY_STATS };
    for (const child of node.children) {
      const c = stats.get(child)!;
      // Text: concatenate.
      acc.lead = acc.lead === acc.len ? acc.len + c.lead : acc.lead;
      acc.trail = c.trail === c.len ? acc.trail + c.len : c.trail;
      acc.len += c.len;
      if (c.norm > 0) {
        if (acc.norm === 0) acc.normStartsWs = c.normStartsWs;
        acc.norm += c.norm - (acc.normEndsWs && c.normStartsWs ? 1 : 0);
        acc.normEndsWs = c.normEndsWs;
      }
      // <p> descendants: the child itself, then its own descendants.
      if (isElement(child) && child.name === 'p') {
        acc.pCount += 1;
        acc.pTrimmedLen += trimmedLength(c);
      }
      acc.pCount += c.pCount;
      acc.pTrimmedLen += c.pTrimmedLen;
    }
    stats.set(node, acc);
  }
  return stats;
}

function extractByParagraphDensity(
  $: cheerio.CheerioAPI,
  stats: Map<DhNode, SubtreeStats>,
): ExtractedContent | null {
  const root = $.root()[0] as unknown as DhParent;
  const candidate = (el: DhElement) =>
    el.name === 'div' || el.name === 'section' || el.name === 'article' || el.name === 'main'
    || el.attribs.role === 'main';

  let best: DhElement | null = null;
  let bestScore = 0;

  for (const node of descendants(root)) {
    if (!isElement(node) || !candidate(node)) continue;
    const s = stats.get(node)!;
    if (s.pCount < 2) continue;

    let elementChildren = 0;
    for (const child of node.children) if (isElement(child)) elementChildren++;
    const childCount = elementChildren || 1;
    const density = s.pTrimmedLen / childCount;
    const score = density * Math.log2(s.pCount + 1);

    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }

  if (!best || bestScore < 50) return null;

  return {
    text: textOf(best).replace(/\s+/g, ' ').trim(),
    ...innerHtml($, best),
    method: 'paragraph-density',
  };
}

/**
 * `$(el).html()`, or nothing when parse5's recursive serializer overflows on
 * pathological nesting: markdown then falls back to the block's text.
 */
function innerHtml($: cheerio.CheerioAPI, el: DhElement): { html?: string } {
  const html = guarded('serialize-block', () => $(el as unknown as Parameters<typeof $>[0]).html() || '');
  return html === null ? {} : { html };
}

const LARGEST_BLOCK_CLASSES = ['post-content', 'article-body', 'entry-content', 'story-body', 'content-body'];

/**
 * `article, [role="main"], main, .post-content, .article-body,
 * .entry-content, .story-body, #article-body, .content-body,
 * [data-shadow-flattened]`
 */
function isContentContainer(el: DhElement): boolean {
  if (el.name === 'article' || el.name === 'main') return true;
  const a = el.attribs;
  if (a.role === 'main' || a.id === 'article-body' || a['data-shadow-flattened'] !== undefined) return true;
  const cls = a.class;
  if (!cls) return false;
  // css-select's `.x` is `[class~="x"]`: whitespace-separated tokens.
  const tokens = cls.split(/\s+/);
  return LARGEST_BLOCK_CLASSES.some((c) => tokens.includes(c));
}

function extractLargestBlock(
  $: cheerio.CheerioAPI,
  stats: Map<DhNode, SubtreeStats>,
): ExtractedContent | null {
  const nodes = descendants($.root()[0] as unknown as DhParent);

  let best: DhElement | null = null;
  let bestLen = 0;
  const consider = (el: DhElement) => {
    const len = normalizedTrimmedLength(stats.get(el)!);
    if (len > bestLen) {
      bestLen = len;
      best = el;
    }
  };

  for (const node of nodes) if (isElement(node) && isContentContainer(node)) consider(node);

  if (bestLen < 100) {
    for (const node of nodes) {
      if (isElement(node) && (node.name === 'div' || node.name === 'section')) consider(node);
    }
  }

  if (!best || bestLen < 100) return null;
  return {
    text: textOf(best).replace(/\s+/g, ' ').trim(),
    ...innerHtml($, best),
    method: 'largest-block',
  };
}

// ─────────────────────────────────────────────────────────────
// Markdown
// ─────────────────────────────────────────────────────────────

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

turndown.addRule('skip-placeholder-images', {
  filter: (node) => {
    if (node.nodeName !== 'IMG') return false;
    const src = node.getAttribute('src') || '';
    return src.startsWith('data:image') && src.length < 200;
  },
  replacement: () => '',
});

// Same output as turndown's built-in listItem rule; the built-in looks the
// item's index up with indexOf over `parent.children` (quadratic for long
// ordered lists: 9 s for 20,000 items).
const olIndexes = new WeakMap<object, Map<object, number>>();
turndown.addRule('listItem', {
  filter: 'li',
  replacement: (content, node, options) => {
    let prefix = options.bulletListMarker + '   ';
    const parent = node.parentNode as unknown as MdNode;
    if (parent.nodeName === 'OL') {
      const start = (parent as unknown as LkElement).getAttribute('start');
      const index = elementIndex(parent, node as unknown as MdNode);
      prefix = (start ? Number(start) + index : index + 1) + '.  ';
    }
    const isParagraph = /\n$/.test(content);
    content = trimNewlines(content) + (isParagraph ? '\n' : '');
    content = content.replace(/\n/gm, '\n' + ' '.repeat(prefix.length)); // indent
    return prefix + content + (node.nextSibling ? '\n' : '');
  },
});

function elementIndex(parent: MdNode, child: MdNode): number {
  let indexes = olIndexes.get(parent);
  if (!indexes) {
    indexes = new Map();
    let i = 0;
    for (let n = parent.firstChild; n !== null; n = n.nextSibling) {
      if (n.nodeType === ELEMENT_NODE) indexes.set(n, i++);
    }
    olIndexes.set(parent, indexes);
  }
  return indexes.get(child) ?? -1;
}

// Turndown parses HTML strings with domino. Loading domino through
// turndown's own resolution gets exactly the copy turndown uses, so string
// input is parsed as before.
const requireFromHere = createRequire(import.meta.url);
const domino = createRequire(requireFromHere.resolve('turndown'))('@mixmark-io/domino') as {
  createDocument(html: string): { getElementById(id: string): MdNode | null };
};

function contentToMarkdown(extracted: ExtractedContent): string {
  try {
    if (extracted.node) return markdownFromNode(extracted.node);
    if (extracted.html) return markdownFromHtml(extracted.html);
  } catch (err) {
    logStageFailure('markdown', err);
  }
  return extracted.text || '';
}

/** Same result as `turndown.turndown(html)` (domino parse, then convert). */
export function markdownFromHtml(html: string): string {
  if (html === '') return '';
  const root = domino
    .createDocument(`<x-turndown id="turndown-root">${html}</x-turndown>`)
    .getElementById('turndown-root')!;
  return convertRoot(root);
}

/**
 * Same result as `turndown.turndown(node)`, but converts `node` in place:
 * turndown clones its input first because it collapses whitespace in the
 * tree it walks. Callers pass a tree they no longer need.
 */
export function markdownFromNode(node: MdNode): string {
  return convertRoot(node);
}

/** The configured service (rules, options); exported for differential tests. */
export const turndownService = turndown;

// The loop below is a port of turndown 7.2.4's RootNode / process / join /
// replacementForNode / postProcess and collapse-whitespace (turndown: MIT,
// Dom Christie; collapse-whitespace: MIT, Luc Thevenard). Rule selection and
// replacements still come from the TurndownService instance; markdown.test.ts
// compares the output with stock turndown. Differences from the original:
// - `join` kept the output in one string and trimmed its trailing newlines on
//   every child; V8 flattens the string each time, so an element with k
//   children cost O(k × output) — 60% of the time on a 500 KB article. Output
//   is now kept as parts with a separate count of trailing newlines.
// - The tree is walked with an explicit stack (any nesting depth).
// - Blank / void / flanking-whitespace checks read only the text they need
//   instead of each element's full textContent and up to 27
//   getElementsByTagName scans per blank element.

/** The DOM subset the converter and turndown's rules use (linkedom or domino). */
export interface MdNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  data?: string;
  parentNode: MdNode | null;
  firstChild: MdNode | null;
  lastChild: MdNode | null;
  nextSibling: MdNode | null;
  previousSibling: MdNode | null;
  removeChild(child: MdNode): unknown;
  // Annotations turndown's rules read (set by annotate()).
  isBlock?: boolean;
  isCode?: boolean;
  isBlank?: boolean;
  flankingWhitespace?: { leading: string; trailing: string };
}

interface TurndownRule {
  replacement(content: string, node: unknown, options: TurndownService.Options): string;
  append?(options: TurndownService.Options): string;
}

interface TurndownInternals {
  options: TurndownService.Options;
  rules: {
    /** Elements no rule matches (div, section, span, ...). */
    defaultRule: TurndownRule;
    forNode(node: unknown): TurndownRule;
    forEach(fn: (rule: TurndownRule) => void): void;
  };
  escape(text: string): string;
}

/**
 * Whether the default rule is turndown's own (`isBlock ? '\n\n' + content +
 * '\n\n' : content`), which MarkdownJoiner.appendJoined reproduces.
 */
const STOCK_DEFAULT_RULE = (() => {
  const service = turndown as unknown as TurndownInternals;
  try {
    const rule = service.rules.defaultRule;
    return rule.replacement('\nx\n', { isBlock: true }, service.options) === '\n\n\nx\n\n\n'
      && rule.replacement('\nx\n', { isBlock: false }, service.options) === '\nx\n';
  } catch {
    return false;
  }
})();

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

const BLOCK_ELEMENTS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'AUDIO', 'BLOCKQUOTE', 'BODY', 'CANVAS',
  'CENTER', 'DD', 'DIR', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'FORM', 'FRAMESET', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
  'HGROUP', 'HR', 'HTML', 'ISINDEX', 'LI', 'MAIN', 'MENU', 'NAV', 'NOFRAMES',
  'NOSCRIPT', 'OL', 'OUTPUT', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD',
  'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);
const VOID_ELEMENTS = new Set([
  'AREA', 'BASE', 'BR', 'COL', 'COMMAND', 'EMBED', 'HR', 'IMG', 'INPUT',
  'KEYGEN', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR',
]);
const MEANINGFUL_WHEN_BLANK = new Set([
  'A', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TH', 'TD', 'IFRAME', 'SCRIPT', 'AUDIO', 'VIDEO',
]);

function convertRoot(root: MdNode): string {
  const service = turndown as unknown as TurndownInternals;
  if (service.options.preformattedCode) {
    // Not ported (isPreOrCode handling); never enabled here.
    throw new Error('preformattedCode is not supported by the markdown converter');
  }
  collapseWhitespace(root);
  let output = processTree(service, root, computeTextFacts(root));
  service.rules.forEach((rule) => {
    if (typeof rule.append === 'function') output = joinOnce(output, rule.append(service.options));
  });
  // `.replace(/[\t\r\n\s]+$/, '')` is trimEnd(), minus the regex's
  // quadratic scan over long whitespace runs.
  return output.replace(/^[\t\r\n]+/, '').trimEnd();
}

type Parts = Array<string | Parts>;

/**
 * Turndown's `join(output, replacement)` folded over the children: trailing
 * newlines of the output and leading newlines of the replacement merge into
 * min(max(a, b), 2) newlines. The output is `leading` newlines, the parts
 * (content and separators; content never starts or ends with a newline, and
 * nested arrays are other joiners' parts), then `trailingNewlines` newlines.
 */
class MarkdownJoiner {
  private leading = 0;
  private parts: Parts = [];
  private trailingNewlines = 0;

  append(replacement: string): void {
    let lead = 0;
    while (lead < replacement.length && replacement.charCodeAt(lead) === 10) lead++;
    const separator = Math.min(Math.max(this.trailingNewlines, lead), 2);
    if (lead === replacement.length) {
      this.trailingNewlines = separator;
      return;
    }
    let end = replacement.length;
    while (replacement.charCodeAt(end - 1) === 10) end--;
    this.pushContent(separator, lead === 0 && end === replacement.length ? replacement : replacement.slice(lead, end));
    this.trailingNewlines = replacement.length - end;
  }

  /**
   * `append('\n'.repeat(wrap) + child.toString() + '\n'.repeat(wrap))`
   * without building the child's string: its parts are adopted by
   * reference, so nested wrappers cost O(1) each instead of a copy of
   * everything inside them.
   */
  appendJoined(child: MarkdownJoiner, wrap: number): void {
    if (child.parts.length === 0) {
      // The child is only newlines (`leading` is set with the first content).
      this.trailingNewlines = Math.min(Math.max(this.trailingNewlines, 2 * wrap + child.trailingNewlines), 2);
      return;
    }
    this.pushContent(Math.min(Math.max(this.trailingNewlines, wrap + child.leading), 2), child.parts);
    this.trailingNewlines = child.trailingNewlines + wrap;
  }

  private pushContent(separator: number, content: string | Parts): void {
    if (this.parts.length === 0) this.leading = separator;
    else if (separator > 0) this.parts.push(separator === 1 ? '\n' : '\n\n');
    this.parts.push(content);
  }

  toString(): string {
    const out: string[] = [];
    if (this.leading > 0) out.push('\n'.repeat(this.leading));
    // Iterative flatten: nesting follows the page's element nesting.
    const stack: Array<{ parts: Parts; i: number }> = [{ parts: this.parts, i: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (top.i === top.parts.length) {
        stack.pop();
        continue;
      }
      const part = top.parts[top.i++]!;
      if (typeof part === 'string') out.push(part);
      else stack.push({ parts: part, i: 0 });
    }
    if (this.trailingNewlines > 0) out.push('\n'.repeat(this.trailingNewlines));
    return out.join('');
  }
}

function joinOnce(output: string, replacement: string): string {
  const joiner = new MarkdownJoiner();
  joiner.append(output);
  joiner.append(replacement);
  return joiner.toString();
}

interface Frame {
  node: MdNode;
  rule: TurndownRule | null;
  next: MdNode | null;
  out: MarkdownJoiner;
}

function processTree(service: TurndownInternals, root: MdNode, facts: Map<MdNode, TextFacts>): string {
  const stack: Frame[] = [{ node: root, rule: null, next: root.firstChild, out: new MarkdownJoiner() }];
  for (;;) {
    const frame = stack[stack.length - 1]!;
    const child = frame.next;
    if (child === null) {
      stack.pop();
      if (stack.length === 0) return frame.out.toString();
      const parent = stack[stack.length - 1]!.out;
      const whitespace = frame.node.flankingWhitespace!;
      if (frame.rule === service.rules.defaultRule && STOCK_DEFAULT_RULE && !whitespace.leading && !whitespace.trailing) {
        // isBlock ? '\n\n' + content + '\n\n' : content
        parent.appendJoined(frame.out, frame.node.isBlock ? 2 : 0);
      } else {
        parent.append(finishElement(service, frame, frame.out.toString()));
      }
      continue;
    }
    frame.next = child.nextSibling;
    if (child.nodeType === TEXT_NODE) {
      child.isCode = frame.node.isCode === true;
      frame.out.append(child.isCode ? child.nodeValue ?? '' : service.escape(child.nodeValue ?? ''));
    } else if (child.nodeType === ELEMENT_NODE) {
      annotate(child, facts);
      stack.push({ node: child, rule: service.rules.forNode(child), next: child.firstChild, out: new MarkdownJoiner() });
    } else {
      frame.out.append('');
    }
  }
}

function finishElement(service: TurndownInternals, frame: Frame, content: string): string {
  const whitespace = frame.node.flankingWhitespace!;
  if (whitespace.leading || whitespace.trailing) content = content.trim();
  return whitespace.leading + frame.rule!.replacement(content, frame.node, service.options) + whitespace.trailing;
}

function annotate(node: MdNode, facts: Map<MdNode, TextFacts>): void {
  const name = node.nodeName;
  const f = facts.get(node)!;
  node.isBlock = BLOCK_ELEMENTS.has(name);
  node.isCode = name === 'CODE' || node.parentNode?.isCode === true;
  // turndown: !isVoid && !isMeaningfulWhenBlank && /^\s*$/.test(textContent)
  //           && !hasVoid && !hasMeaningfulWhenBlank
  node.isBlank = !VOID_ELEMENTS.has(name) && !MEANINGFUL_WHEN_BLANK.has(name) && f.allWs && !f.hasVoidOrMeaningful;
  node.flankingWhitespace = node.isBlock ? { leading: '', trailing: '' } : flankingWhitespace(node, f, facts);
}

/**
 * What turndown reads from an element's textContent and descendants,
 * computed bottom-up once per conversion: it re-read each element's whole
 * textContent (and ran up to 27 getElementsByTagName scans per blank
 * element), so nested elements cost O(depth × text).
 */
interface TextFacts {
  /** No non-whitespace text (also true for no text). */
  allWs: boolean;
  /** Leading whitespace of the text; the whole text when `allWs`. */
  lead: string;
  /** Trailing whitespace of the text; the whole text when `allWs`. */
  trail: string;
  /** Char codes of the first / last character of the text, -1 when empty. */
  first: number;
  last: number;
  /** Some descendant element is void or meaningful when blank. */
  hasVoidOrMeaningful: boolean;
}

function isTextLike(node: MdNode): boolean {
  return node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE;
}

function textFactsOf(data: string): TextFacts {
  const n = data.length;
  const first = n > 0 ? data.charCodeAt(0) : -1;
  const last = n > 0 ? data.charCodeAt(n - 1) : -1;
  let a = 0;
  while (a < n && isWhitespaceCode(data.charCodeAt(a))) a++;
  if (a === n) return { allWs: true, lead: data, trail: data, first, last, hasVoidOrMeaningful: false };
  let b = n;
  while (isWhitespaceCode(data.charCodeAt(b - 1))) b--;
  return { allWs: false, lead: data.slice(0, a), trail: data.slice(b), first, last, hasVoidOrMeaningful: false };
}

function computeTextFacts(root: MdNode): Map<MdNode, TextFacts> {
  // Root and its element descendants in document order; walked backwards,
  // every element comes after its children.
  const order: MdNode[] = [];
  const stack: MdNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    order.push(node);
    for (let c = node.lastChild; c !== null; c = c.previousSibling) if (c.nodeType === ELEMENT_NODE) stack.push(c);
  }
  const facts = new Map<MdNode, TextFacts>();
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i]!;
    let allWs = true;
    let lead = '';
    let leadOpen = true;
    let trail = '';
    let first = -1;
    let last = -1;
    let hasVoidOrMeaningful = false;
    for (let c = node.firstChild; c !== null; c = c.nextSibling) {
      let f: TextFacts;
      if (c.nodeType === ELEMENT_NODE) {
        f = facts.get(c)!;
        if (VOID_ELEMENTS.has(c.nodeName) || MEANINGFUL_WHEN_BLANK.has(c.nodeName)) hasVoidOrMeaningful = true;
      } else if (isTextLike(c)) {
        f = textFactsOf(c.data ?? '');
      } else {
        continue; // comments and the like are not part of textContent
      }
      if (f.hasVoidOrMeaningful) hasVoidOrMeaningful = true;
      if (leadOpen) {
        lead += f.lead;
        leadOpen = f.allWs;
      }
      trail = f.allWs ? trail + f.trail : f.trail;
      if (!f.allWs) allWs = false;
      if (f.first !== -1) {
        if (first === -1) first = f.first;
        last = f.last;
      }
    }
    facts.set(node, { allWs, lead, trail, first, last, hasVoidOrMeaningful });
  }
  return facts;
}

/** `/\s/` for one UTF-16 code unit (ECMAScript WhiteSpace + LineTerminator). */
function isWhitespaceCode(c: number): boolean {
  if (c <= 32) return c === 32 || (c >= 9 && c <= 13);
  if (c < 0xa0) return false;
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029
    || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

function isAsciiWhitespaceCode(c: number): boolean {
  return c === 32 || c === 9 || c === 13 || c === 10;
}

/**
 * turndown's flankingWhitespace over edgeWhitespace(node.textContent):
 * /^(([ \t\r\n]*)(\s*))(?:(?=\S)[\s\S]*\S)?((\s*?)([ \t\r\n]*))$/
 * leading = the leading whitespace run (the whole text when it is all
 * whitespace), trailing = the trailing run (empty then); the "ASCII" parts
 * are the outermost runs of [ \t\r\n], dropped when a neighbour already
 * supplies a space.
 */
function flankingWhitespace(node: MdNode, f: TextFacts, facts: Map<MdNode, TextFacts>): { leading: string; trailing: string } {
  let leading = f.lead;
  let trailing = f.allWs ? '' : f.trail;
  let a = 0;
  while (a < leading.length && isAsciiWhitespaceCode(leading.charCodeAt(a))) a++;
  let b = trailing.length;
  while (b > 0 && isAsciiWhitespaceCode(trailing.charCodeAt(b - 1))) b--;
  // abandon leading ASCII WS if left-flanked by ASCII WS
  if (a > 0 && isFlankedByWhitespace('left', node, facts)) leading = leading.slice(a);
  // abandon trailing ASCII WS if right-flanked by ASCII WS
  if (b < trailing.length && isFlankedByWhitespace('right', node, facts)) trailing = trailing.slice(0, b);
  return { leading, trailing };
}

function isFlankedByWhitespace(side: 'left' | 'right', node: MdNode, facts: Map<MdNode, TextFacts>): boolean {
  const sibling = side === 'left' ? node.previousSibling : node.nextSibling;
  if (!sibling) return false;
  if (sibling.nodeType === TEXT_NODE) {
    const value = sibling.nodeValue ?? '';
    return side === 'left' ? value.endsWith(' ') : value.startsWith(' ');
  }
  if (sibling.nodeType === ELEMENT_NODE && !BLOCK_ELEMENTS.has(sibling.nodeName)) {
    // `/ $/` or `/^ /` against the sibling's textContent.
    const f = facts.get(sibling)!;
    return (side === 'left' ? f.last : f.first) === 32;
  }
  return false;
}

/** turndown's collapseWhitespace(element) with isPre = nodeName === 'PRE'. */
function collapseWhitespace(element: MdNode): void {
  if (!element.firstChild || element.nodeName === 'PRE') return;

  let prevText: MdNode | null = null;
  let keepLeadingWs = false;
  let prev: MdNode | null = null;
  let node: MdNode = nextNode(prev, element);

  while (node !== element) {
    if (isTextLike(node)) {
      let text = (node.data ?? '').replace(/[ \r\n\t]+/g, ' ');
      if ((!prevText || / $/.test(prevText.data ?? '')) && !keepLeadingWs && text[0] === ' ') {
        text = text.slice(1);
      }
      // `text` might be empty at this point.
      if (!text) {
        node = removeNode(node);
        continue;
      }
      node.data = text;
      prevText = node;
    } else if (node.nodeType === ELEMENT_NODE) {
      if (BLOCK_ELEMENTS.has(node.nodeName) || node.nodeName === 'BR') {
        if (prevText) prevText.data = (prevText.data ?? '').replace(/ $/, '');
        prevText = null;
        keepLeadingWs = false;
      } else if (VOID_ELEMENTS.has(node.nodeName) || node.nodeName === 'PRE') {
        // Avoid trimming space around non-block, non-BR void elements and inline PRE.
        prevText = null;
        keepLeadingWs = true;
      } else if (prevText) {
        // Drop protection if set previously.
        keepLeadingWs = false;
      }
    } else {
      node = removeNode(node);
      continue;
    }
    const following = nextNode(prev, node);
    prev = node;
    node = following;
  }

  if (prevText) {
    prevText.data = (prevText.data ?? '').replace(/ $/, '');
    if (!prevText.data) removeNode(prevText);
  }
}

function removeNode(node: MdNode): MdNode {
  const next = node.nextSibling || node.parentNode!;
  node.parentNode!.removeChild(node);
  return next;
}

function nextNode(prev: MdNode | null, current: MdNode): MdNode {
  if ((prev && prev.parentNode === current) || current.nodeName === 'PRE') {
    return current.nextSibling || current.parentNode!;
  }
  return current.firstChild || current.nextSibling || current.parentNode!;
}

function trimNewlines(s: string): string {
  let start = 0;
  while (s.charCodeAt(start) === 10) start++;
  let end = s.length;
  while (end > start && s.charCodeAt(end - 1) === 10) end--;
  return s.slice(start, end);
}

// ─────────────────────────────────────────────────────────────
// Markdown cleanup
// ─────────────────────────────────────────────────────────────

export function cleanMarkdown(md: string): string {
  return stripJavascriptLinks(md.replace(/!\[\]\(data:image[^)]{0,200}\)/g, ''))
    .replace(/^[\s;]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * `md.replace(/\[([^\]]*)\]\(javascript:[^)]*\)/g, '$1')` in linear time.
 * The regex rescans to the next `]` from every `[` that does not start a
 * match: quadratic on text with many `[` (2.3 s for 40,000).
 *
 * For a `[` at i the group can only end at the first `]` after it (j), so
 * every `[` before j shares its outcome; after a missing `]` or `)` nothing
 * later can match either.
 */
export function stripJavascriptLinks(md: string): string {
  if (!md.includes('](javascript:')) return md;
  const TARGET = '(javascript:';
  let out = '';
  let copied = 0;
  let from = 0;
  for (;;) {
    const open = md.indexOf('[', from);
    if (open < 0) break;
    const close = md.indexOf(']', open + 1);
    if (close < 0) break;
    if (!md.startsWith(TARGET, close + 1)) {
      from = close + 1;
      continue;
    }
    const end = md.indexOf(')', close + 1 + TARGET.length);
    if (end < 0) break;
    out += md.slice(copied, open) + md.slice(open + 1, close);
    copied = end + 1;
    from = end + 1;
  }
  return copied === 0 ? md : out + md.slice(copied);
}

/** Internals exposed for the equivalence tests in test/extraction/. */
export const internals = {
  isWhitespaceCode,
  removeNoise,
  plainBodyText,
  inlineStyle,
  /** Both cleaned-page strategies over `$` (noise already removed). */
  cleanedPageStrategies($: cheerio.CheerioAPI) {
    const stats = computeSubtreeStats($.root()[0] as unknown as DhParent);
    return { density: extractByParagraphDensity($, stats), largest: extractLargestBlock($, stats) };
  },
};
