// Deterministic recipe induction from grounded sample values (no model call).
//
// Input: the page, the record selector (listing pages) and the raw values a
// grounded extraction found for the first records. For every field the
// element holding the value is located inside the sample record (or the page)
// by its collapsed text or an evidence attribute (href, src, content, title,
// data-*, class tokens such as "star-rating Three"), a stable relative
// selector is derived for it, and the candidate (selector, attribute,
// transforms) that reproduces the value on ALL sample records wins. Values
// that are only part of an element's text get a regex transform anchored on
// the neighbouring words ("Price: £51.77" → "Price:\s*(£\d[\d.,]*)").
//
// The induced recipe is validated and run on the same page; coverage is the
// fraction of non-null sample values it reproduces. Below 90% no recipe is
// returned.

import * as cheerio from 'cheerio';
import type { ExtractionRecipe, RecipeField, RecipeTransform } from '../types.js';
import { classTokenRegexes, regexCandidates, selectorCandidates, stableClasses, stepVariants, tagOf } from './derive.js';
import { type DomElement, type DomNode, collapseWhitespace, effectiveBase, elementText, isElement, readAttribute, resolveUrl } from './dom.js';
import { runRecipe } from './run.js';
import { checkSelector } from './selector.js';
import { applyTransforms, compileTransforms, type RecipeValue, type TransformContext } from './transforms.js';
import { compileFastSelector } from './fast-select.js';
import { isReservedFieldName, validateRecipe } from './validate.js';

export interface InduceArgs {
  html: string;
  baseUrl: string;
  shape: 'object' | 'array';
  /** Record selector for listing pages (e.g. a RecordGroup selector); inferred from the samples when absent. */
  recordSelector?: string;
  /** Raw values per record, in record order (first N records for arrays; one record for objects). */
  samples: Array<Record<string, string | null>>;
  fieldNames: string[];
  /** Absolute deadline (epoch ms); induction stops trying candidates after it. */
  deadlineMs?: number;
}

export interface InduceResult {
  recipe: ExtractionRecipe | null;
  /** Fraction of non-null sample values the induced recipe reproduces on this page. */
  coverage: number;
  notes: string[];
}

export const MIN_INDUCTION_COVERAGE = 0.9;

/** Elements examined per scope. */
const MAX_SCAN_ELEMENTS = 20_000;
/** Longer element texts are never a field source (and are not computed). */
const MAX_SOURCE_TEXT = 5_000;
/** Raw (uncollapsed) subtree text above which an element's text is not computed. */
const MAX_RAW_TEXT = 4 * MAX_SOURCE_TEXT;
/**
 * Elements with more descendants than this are containers, never a value's
 * source; skipping their text keeps a scan linear on hostile, very deep DOMs.
 */
const MAX_SOURCE_SUBTREE = 500;
const MAX_SOURCES_PER_FIELD = 24;
const MAX_EVALUATIONS_PER_FIELD = 600;
/** Candidate evaluations across all fields of one induction. */
const MAX_TOTAL_EVALUATIONS = 6_000;
const MAX_SAMPLES = 20;
const MAX_ATTR_SOURCE_CHARS = 2_000;

const URL_ATTRS = new Set(['href', 'src', 'data-src', 'data-original', 'data-lazy-src', 'poster', 'action']);
const VALUE_ATTRS = new Set(['href', 'src', 'content', 'alt', 'title', 'datetime', 'value', 'aria-label', 'poster', 'label']);
const SKIP_SUBTREES = new Set(['script', 'style', 'template', 'noscript']);

export function induceRecipe(args: InduceArgs): InduceResult {
  const notes: string[] = [];
  const fieldNames = [...new Set(args.fieldNames)].filter((name) => {
    const reserved = isReservedFieldName(name);
    if (reserved) notes.push(`field "${name}": reserved name`);
    return !reserved;
  });
  const samples = args.samples.slice(0, MAX_SAMPLES);
  if (args.samples.length > MAX_SAMPLES) notes.push(`only the first ${MAX_SAMPLES} samples were used`);
  if (fieldNames.length === 0 || samples.length === 0) return fail(notes, 'no fields or no samples');

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(args.html);
  } catch (err) {
    return fail(notes, `html could not be parsed: ${(err as Error).message}`);
  }
  const ctx: TransformContext = { baseUrl: args.baseUrl, base: effectiveBase($('base[href]').first().attr('href'), args.baseUrl) };

  let scopes: DomNode[];
  let recordSelector: string | undefined;
  if (args.shape === 'array') {
    const records = resolveRecords($, args.recordSelector, samples, ctx, notes);
    if (!records) return fail(notes, 'no record elements found');
    recordSelector = records.selector;
    scopes = records.elements.slice(0, samples.length);
    if (scopes.length < samples.length) notes.push(`${samples.length} samples but only ${scopes.length} records on the page`);
  } else {
    if (samples.length > 1) notes.push('object shape: only the first sample is used');
    scopes = [$.root()[0] as unknown as DomNode];
  }

  const fields: Record<string, RecipeField> = {};
  const budget: SearchBudget = { evaluations: 0, deadlineMs: args.deadlineMs };
  for (const name of fieldNames) {
    const values = scopes.map((_, i) => sampleValue(samples[i], name));
    if (values.every((v) => v === null)) {
      notes.push(`field "${name}": no sample values`);
      continue;
    }
    if (exhausted(budget)) {
      notes.push(`field "${name}": search budget exhausted`);
      continue;
    }
    const field = induceField($, scopes, values, ctx, budget);
    if (field) fields[name] = field;
    else notes.push(`field "${name}": no element reproduces the sample values`);
  }
  if (Object.keys(fields).length === 0) return fail(notes, 'no field could be induced');

  const candidate: ExtractionRecipe = { version: 1, shape: args.shape, fields };
  if (recordSelector !== undefined) candidate.recordSelector = recordSelector;
  const checked = validateRecipe(candidate, fieldNames);
  if (!checked.ok) return fail(notes, `induced recipe is invalid: ${checked.errors.join('; ')}`);

  const coverage = measureCoverage($, checked.recipe, samples, fieldNames, args.baseUrl);
  if (coverage < MIN_INDUCTION_COVERAGE) {
    notes.push(`coverage ${coverage.toFixed(2)} is below ${MIN_INDUCTION_COVERAGE}`);
    return { recipe: null, coverage, notes };
  }
  return { recipe: checked.recipe, coverage, notes };
}

function fail(notes: string[], reason: string): InduceResult {
  notes.push(reason);
  return { recipe: null, coverage: 0, notes };
}

function sampleValue(sample: Record<string, string | null> | undefined, name: string): string | null {
  if (!sample || !Object.prototype.hasOwnProperty.call(sample, name)) return null;
  const v = sample[name];
  if (typeof v !== 'string') return null;
  const collapsed = collapseWhitespace(v);
  return collapsed === '' ? null : collapsed;
}

/** Case-, width- and whitespace-insensitive form used to compare values. */
function norm(s: string): string {
  return collapseWhitespace(s.normalize('NFKC')).toLowerCase();
}

/**
 * Best element holding each value (exact text/attribute first, then the
 * deepest element containing it). Used to focus prompts on the page region
 * that holds the sample values.
 */
export function findValueElements($: cheerio.CheerioAPI, values: string[], baseUrl: string): DomElement[] {
  const ctx: TransformContext = { baseUrl, base: effectiveBase($('base[href]').first().attr('href'), baseUrl) };
  const scan = scanScope($.root()[0] as unknown as DomNode);
  const out: DomElement[] = [];
  for (const raw of values) {
    const value = collapseWhitespace(raw);
    if (value.length < 2) continue;
    const best = findSources(scan, value, ctx)[0];
    if (best) out.push(best.el);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Coverage
// ─────────────────────────────────────────────────────────────

function measureCoverage(
  $: cheerio.CheerioAPI,
  recipe: ExtractionRecipe,
  samples: Array<Record<string, string | null>>,
  fieldNames: string[],
  baseUrl: string,
): number {
  // Only the sampled records are compared; the rest of a long listing need not run.
  const run = runRecipe(recipe, { $ }, { baseUrl, maxRecords: samples.length });
  const records: Array<Record<string, unknown>> = Array.isArray(run.data) ? run.data : [run.data];
  const usable = recipe.shape === 'object' ? samples.slice(0, 1) : samples;
  let total = 0;
  let reproduced = 0;
  usable.forEach((sample, i) => {
    for (const name of fieldNames) {
      const want = sampleValue(sample, name);
      if (want === null) continue;
      total++;
      const got = records[i]?.[name];
      if (got !== undefined && sameValue(got as RecipeValue, want)) reproduced++;
    }
  });
  return total === 0 ? 0 : reproduced / total;
}

function sameValue(got: RecipeValue | RecipeValue[], want: string): boolean {
  if (got === null) return false;
  if (Array.isArray(got)) return got.length > 0 && sameValue(got[0], want);
  return norm(String(got)) === norm(want);
}

// ─────────────────────────────────────────────────────────────
// Records
// ─────────────────────────────────────────────────────────────

interface Records {
  elements: DomElement[];
  selector: string;
}

function resolveRecords(
  $: cheerio.CheerioAPI,
  hint: string | undefined,
  samples: Array<Record<string, string | null>>,
  ctx: TransformContext,
  notes: string[],
): Records | null {
  let elements: DomElement[];
  if (hint !== undefined) {
    try {
      elements = $(hint).toArray() as unknown as DomElement[];
    } catch (err) {
      notes.push(`record selector does not compile: ${(err as Error).message}`);
      return null;
    }
    if (elements.length === 0) {
      notes.push('record selector matched nothing');
      return null;
    }
  } else {
    const inferred = inferRecords($, samples, ctx);
    if (!inferred) return null;
    elements = inferred;
  }
  const stable = stableRecordSelector($, elements);
  if (stable) return { elements, selector: stable };
  if (hint !== undefined && checkSelector(hint, { relative: false }) === null) return { elements, selector: hint };
  notes.push('could not derive a valid selector matching exactly the records');
  return null;
}

/** Short document-level selector matching exactly `elements` (same order). */
function stableRecordSelector($: cheerio.CheerioAPI, elements: DomElement[]): string | null {
  const first = elements[0];
  if (!elements.every((e) => e.name === first.name)) return null;
  const tag = tagOf(first);
  const candidates: string[] = [];
  for (const step of stepVariants(first)) {
    // A step must describe every record, not just the first.
    if (elements.every((e) => matchesStep(e, step, tag))) candidates.push(step);
  }
  const parent = first.parent;
  if (isElement(parent) && elements.every((e) => e.parent === parent)) {
    const own = candidates.filter((c) => c !== tag).slice(0, 2).concat(tag);
    for (const p of stepVariants(parent).slice(0, 4)) for (const o of own) candidates.push(`${p} > ${o}`);
    const nth = contiguousRange(elements);
    if (nth) {
      for (const p of stepVariants(parent).slice(0, 4)) candidates.push(`${p} > ${tag}:nth-child(n+${nth.from}):nth-child(-n+${nth.to})`);
    }
  }
  for (const c of candidates) {
    if (checkSelector(c, { relative: false }) !== null) continue;
    let got: DomNode[];
    try {
      got = $(c).toArray() as unknown as DomNode[];
    } catch {
      continue;
    }
    if (got.length === elements.length && got.every((g, i) => g === elements[i])) return c;
  }
  return null;
}

function matchesStep(el: DomElement, step: string, tag: string): boolean {
  if (step === tag) return true;
  const own = stepVariants(el);
  return own.includes(step);
}

/** 1-based nth-child range when the elements are consecutive element siblings. */
function contiguousRange(elements: DomElement[]): { from: number; to: number } | null {
  const parent = elements[0].parent as DomNode & { children: DomNode[] };
  const siblings = parent.children.filter(isElement);
  const from = siblings.indexOf(elements[0]);
  if (from < 0) return null;
  for (let i = 0; i < elements.length; i++) if (siblings[from + i] !== elements[i]) return null;
  return { from: from + 1, to: from + elements.length };
}

/**
 * Finds the records of a listing from the samples: locate the first record's
 * values, take their lowest common ancestor, then climb until the element has
 * same-shaped siblings that hold the following samples' values.
 */
function inferRecords($: cheerio.CheerioAPI, samples: Array<Record<string, string | null>>, ctx: TransformContext): DomElement[] | null {
  const root = $.root()[0] as unknown as DomNode;
  const scan = scanScope(root);
  // Most distinctive (longest) values first; later values pick the occurrence
  // closest to the first anchor, so a price repeated in a sidebar does not
  // pull the common ancestor up to <body>.
  const values = Object.values(samples[0] ?? {})
    .map((raw) => (typeof raw === 'string' ? collapseWhitespace(raw) : ''))
    .filter((v) => v !== '')
    .sort((a, b) => b.length - a.length);
  const anchors: DomElement[] = [];
  for (const value of values) {
    const sources = findSources(scan, value, ctx).slice(0, 8);
    if (sources.length === 0) continue;
    if (anchors.length === 0) {
      anchors.push(sources[0].el);
      continue;
    }
    let pick = sources[0].el;
    let pickDepth = -1;
    for (const s of sources) {
      const depth = ancestorDepth(lowestCommonAncestor([anchors[0], s.el]));
      if (depth > pickDepth) {
        pick = s.el;
        pickDepth = depth;
      }
    }
    anchors.push(pick);
  }
  if (anchors.length === 0) return null;
  let node: DomNode | null = lowestCommonAncestor(anchors);
  for (; isElement(node); node = node.parent) {
    const siblings = sameKindSiblings(node);
    if (siblings.length < 2) continue;
    const records = siblings.slice(siblings.indexOf(node));
    if (records.length < Math.min(samples.length, 2)) continue;
    if (samplesAlign(records, samples, ctx)) return descendToWrapper(records);
  }
  return null;
}

function ancestorDepth(node: DomNode | null): number {
  let d = 0;
  for (let n = node; n; n = n.parent) d++;
  return d;
}

export function lowestCommonAncestor(elements: DomElement[]): DomNode | null {
  const chain = (n: DomNode): DomNode[] => {
    const out: DomNode[] = [];
    for (let c: DomNode | null = n; c; c = c.parent) out.push(c);
    return out.reverse();
  };
  let common = chain(elements[0]);
  for (const el of elements.slice(1)) {
    const other = chain(el);
    let i = 0;
    while (i < common.length && i < other.length && common[i] === other[i]) i++;
    common = common.slice(0, i);
  }
  return common[common.length - 1] ?? null;
}

function sameKindSiblings(el: DomElement): DomElement[] {
  const parent = el.parent as (DomNode & { children?: DomNode[] }) | null;
  const key = kindKey(el);
  return (parent?.children ?? []).filter((c): c is DomElement => isElement(c) && kindKey(c) === key);
}

function kindKey(el: DomElement): string {
  return `${el.name}.${stableClasses(el)[0] ?? ''}`;
}

/** Each of the next few samples has at least half of its values inside the corresponding record. */
function samplesAlign(records: DomElement[], samples: Array<Record<string, string | null>>, ctx: TransformContext): boolean {
  const n = Math.min(samples.length, records.length, 5);
  for (let j = 0; j < n; j++) {
    const values = Object.values(samples[j]).filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    if (values.length === 0) continue;
    const scan = scanScope(records[j]);
    const found = values.filter((v) => findSources(scan, collapseWhitespace(v), ctx).length > 0).length;
    if (found * 2 < values.length) return false;
  }
  return true;
}

/** Prefer the inner wrapper when every record is a single-child shell (li > article.product). */
function descendToWrapper(records: DomElement[]): DomElement[] {
  let current = records;
  for (let depth = 0; depth < 3; depth++) {
    const inner = current.map((r) => r.children.filter(isElement));
    if (!inner.every((c) => c.length === 1 && c[0].name === inner[0][0].name)) break;
    current = inner.map((c) => c[0]);
  }
  return current;
}

// ─────────────────────────────────────────────────────────────
// Scanning a scope for sources of a value
// ─────────────────────────────────────────────────────────────

interface ScanEntry {
  el: DomElement;
  /** Collapsed text, or null when too long to be a source. */
  text: string | null;
  /** norm(text), computed on first use. */
  normText?: string;
  depth: number;
  inHead: boolean;
  /** Inside nav/header/footer/breadcrumbs: a weaker source. */
  chrome: boolean;
  /** Per attribute: collapsed and normalized value, resolved URL; computed on first use. */
  attrs?: Map<string, AttrForms>;
}

interface AttrForms {
  collapsed: string;
  normalized: string;
  /** Absolute URL for link attributes (null when not resolvable). */
  url?: string | null;
}

function attrForms(entry: ScanEntry, name: string, raw: string, ctx: TransformContext): AttrForms {
  entry.attrs ??= new Map();
  let forms = entry.attrs.get(name);
  if (!forms) {
    const collapsed = collapseWhitespace(raw);
    forms = { collapsed, normalized: norm(collapsed) };
    if (URL_ATTRS.has(name)) forms.url = resolveUrl(raw, ctx.base);
    entry.attrs.set(name, forms);
  }
  return forms;
}

function normTextOf(entry: ScanEntry): string | null {
  if (entry.text === null) return null;
  entry.normText ??= norm(entry.text);
  return entry.normText;
}

const scanCache = new WeakMap<DomNode, ScanEntry[]>();

/** Elements of the scope (itself included) in document order, with their texts. */
function scanScope(scope: DomNode): ScanEntry[] {
  const cached = scanCache.get(scope);
  if (cached) return cached;
  type Pending = { node: DomNode; depth: number; inHead: boolean; chrome: boolean };
  const order: Array<Omit<ScanEntry, 'text'>> = [];
  const stack: Pending[] = [];
  const pushChildren = (node: DomNode, depth: number, inHead: boolean, chrome: boolean): void => {
    const children = (node as DomNode & { children?: DomNode[] }).children ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], depth, inHead, chrome });
  };
  // Chrome above the scope still counts (a record inside <nav> is chrome).
  const chromeAbove = isElement(scope) && scope.parent ? isChrome(scope.parent) : false;
  if (isElement(scope)) stack.push({ node: scope, depth: 0, inHead: false, chrome: chromeAbove });
  else pushChildren(scope, 0, false, false);
  while (stack.length > 0 && order.length < MAX_SCAN_ELEMENTS) {
    const { node, depth, inHead, chrome } = stack.pop() as Pending;
    if (!isElement(node) || SKIP_SUBTREES.has(node.name)) continue;
    const head = inHead || node.name === 'head';
    const inChrome = chrome || isChromeElement(node);
    order.push({ el: node, depth, inHead: head, chrome: inChrome });
    pushChildren(node, depth + 1, head, inChrome);
  }
  const sizes = subtreeSizes(order.map((o) => o.el));
  const entries: ScanEntry[] = order.map((o) => {
    const size = sizes.get(o.el);
    const small = size !== undefined && size.text <= MAX_RAW_TEXT && size.elements <= MAX_SOURCE_SUBTREE;
    return { ...o, text: small ? elementText(o.el, MAX_SOURCE_TEXT + 1).text : null };
  });
  for (const e of entries) if (e.text !== null && e.text.length > MAX_SOURCE_TEXT) e.text = null;
  scanCache.set(scope, entries);
  return entries;
}

/**
 * Raw text length and descendant count below each element, bottom-up over
 * the document-order list (no strings built). Elements cut off by the scan
 * limit count as huge.
 */
function subtreeSizes(elements: DomElement[]): Map<DomElement, { text: number; elements: number }> {
  const sizes = new Map<DomElement, { text: number; elements: number }>();
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    const size = { text: 0, elements: 0 };
    for (const c of el.children) {
      if (c.type === 'text') {
        size.text += (c as DomNode & { data: string }).data.length;
      } else if (isElement(c)) {
        const child = sizes.get(c);
        if (child) {
          size.text += child.text;
          size.elements += child.elements + 1;
        } else if (!SKIP_SUBTREES.has(c.name)) {
          size.elements = Number.POSITIVE_INFINITY;
        }
      }
    }
    sizes.set(el, size);
  }
  return sizes;
}

type SourceKind = 'text' | 'attr' | 'url' | 'token' | 'text-part' | 'attr-part';

interface Source {
  el: DomElement;
  kind: SourceKind;
  /** Attribute read; undefined for text. */
  attr?: string;
  /** String the value was found in, and where. */
  haystack: string;
  index: number;
  matched: string;
  rank: number;
}

const KIND_RANK: Record<SourceKind, number> = { text: 0, attr: 1, url: 2, token: 3, 'text-part': 4, 'attr-part': 5 };

/** Among equal kinds, attributes that carry data beat descriptive ones. */
function attrPreference(name: string): number {
  if (name === 'content' || name === 'datetime' || name === 'value') return 0;
  if (name === 'title' || name === 'href' || name === 'src') return 1;
  if (name.startsWith('data-')) return 3;
  return 2;
}

/** Where `value` appears in the scope: exact text/attribute first, then parts of longer strings. */
function findSources(scan: ScanEntry[], value: string, ctx: TransformContext): Source[] {
  const want = norm(value);
  const sources: Source[] = [];
  const containing = new Set<DomElement>();
  for (const entry of scan) {
    const { el, text } = entry;
    const penalty = (entry.inHead && el.name !== 'meta' ? 20 : 0) + (entry.chrome ? 10 : 0) - entry.depth / 100;
    const t = normTextOf(entry);
    if (text !== null && t !== null) {
      if (t === want) {
        sources.push({ el, kind: 'text', haystack: text, index: 0, matched: text, rank: KIND_RANK.text * 100 + penalty });
        containing.add(el);
      } else if (t.length > want.length && t.includes(want)) {
        containing.add(el);
      }
    }
    for (const name of Object.keys(el.attribs)) {
      const raw = el.attribs[name];
      if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ATTR_SOURCE_CHARS) continue;
      const source = attributeSource(entry, name, raw, value, want, ctx);
      if (source) sources.push({ ...source, rank: KIND_RANK[source.kind] * 100 + attrPreference(name) * 5 + penalty });
    }
  }
  // Parts of longer texts: only the deepest elements that contain the value.
  for (const entry of scan) {
    if (!containing.has(entry.el) || entry.text === null || normTextOf(entry) === want) continue;
    if (entry.el.children.some((c) => isElement(c) && containing.has(c))) continue;
    const found = locate(entry.text, value);
    if (!found) continue;
    const penalty = (entry.inHead ? 20 : 0) + (entry.chrome ? 10 : 0);
    sources.push({ el: entry.el, kind: 'text-part', haystack: entry.text, ...found, rank: KIND_RANK['text-part'] * 100 + penalty });
  }
  return sources.sort((a, b) => a.rank - b.rank).slice(0, MAX_SOURCES_PER_FIELD);
}

function attributeSource(
  entry: ScanEntry,
  name: string,
  raw: string,
  value: string,
  want: string,
  ctx: TransformContext,
): Omit<Source, 'rank'> | null {
  const el = entry.el;
  const isData = name.startsWith('data-');
  if (name === 'class') {
    if (!raw.toLowerCase().includes(want)) return null;
    const tokens = raw.split(/\s+/).filter(Boolean);
    const index = tokens.findIndex((t) => norm(t) === want);
    return index >= 0 ? { el, kind: 'token', attr: 'class', haystack: raw, index, matched: tokens[index] } : null;
  }
  if (!VALUE_ATTRS.has(name) && !isData) return null;
  const forms = attrForms(entry, name, raw, ctx);
  const collapsed = forms.collapsed;
  if (forms.normalized === want) return { el, kind: 'attr', attr: name, haystack: collapsed, index: 0, matched: collapsed };
  if (URL_ATTRS.has(name)) {
    const absolute = forms.url ?? null;
    if (absolute !== null && (absolute === value || norm(absolute) === want)) {
      return { el, kind: 'url', attr: name, haystack: raw, index: 0, matched: raw };
    }
    return null;
  }
  const found = collapsed.length > value.length ? locate(collapsed, value) : null;
  return found ? { el, kind: 'attr-part', attr: name, haystack: collapsed, ...found } : null;
}

/** Position of `value` inside `text`, case-insensitively when lower-casing keeps offsets. */
function locate(text: string, value: string): { index: number; matched: string } | null {
  let index = text.indexOf(value);
  if (index < 0) {
    const lower = text.toLowerCase();
    if (lower.length === text.length) index = lower.indexOf(value.toLowerCase());
  }
  return index < 0 ? null : { index, matched: text.slice(index, index + value.length) };
}

/** Navigation, breadcrumbs, header and footer: a value there is a weaker source. */
function isChromeElement(el: DomElement): boolean {
  if (el.name === 'nav' || el.name === 'header' || el.name === 'footer') return true;
  const cls = el.attribs.class;
  return cls !== undefined && /breadcrumb/i.test(cls);
}

function isChrome(node: DomNode | null): boolean {
  for (let n = node; isElement(n); n = n.parent) if (isChromeElement(n)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────
// Field induction
// ─────────────────────────────────────────────────────────────

interface SearchBudget {
  evaluations: number;
  deadlineMs?: number;
}

function exhausted(budget: SearchBudget): boolean {
  return budget.evaluations >= MAX_TOTAL_EVALUATIONS || (budget.deadlineMs !== undefined && Date.now() > budget.deadlineMs);
}

interface Candidate {
  selector: string;
  attr?: string;
  transforms: RecipeTransform[];
}

interface Score {
  matched: number;
  /** Values produced where the sample had none. */
  extras: number;
}

function induceField(
  $: cheerio.CheerioAPI,
  scopes: DomNode[],
  values: Array<string | null>,
  ctx: TransformContext,
  budget: SearchBudget,
): RecipeField | null {
  const wanted = values.filter((v) => v !== null).length;
  // Derive candidates from the first record that has a value.
  const home = values.findIndex((v) => v !== null);
  const sources = findSources(scanScope(scopes[home]), values[home] as string, ctx);
  let best: { candidate: Candidate; score: Score } | null = null;
  let evaluations = 0;
  const tried = new Set<string>();
  for (const source of sources) {
    for (const candidate of candidatesFor(source, scopes[home])) {
      const key = JSON.stringify(candidate);
      if (tried.has(key)) continue;
      tried.add(key);
      if (++evaluations > MAX_EVALUATIONS_PER_FIELD || exhausted(budget)) return finishField(best);
      budget.evaluations++;
      // Cheap check on the home record before evaluating every sample.
      if (!reproduces($, scopes[home], candidate, values[home] as string, ctx)) continue;
      const score = scoreCandidate($, scopes, values, candidate, ctx);
      if (!best || better(score, best.score)) best = { candidate, score };
      if (score.matched === wanted && score.extras === 0) return finishField(best);
    }
  }
  return finishField(best);
}

function finishField(best: { candidate: Candidate; score: Score } | null): RecipeField | null {
  if (!best) return null;
  const { selector, attr, transforms } = best.candidate;
  const field: RecipeField = { selector };
  if (attr !== undefined) field.attr = attr;
  if (transforms.length > 0) field.transforms = transforms;
  return field;
}

function better(a: Score, b: Score): boolean {
  if (a.matched !== b.matched) return a.matched > b.matched;
  return a.extras < b.extras;
}

function candidatesFor(source: Source, scope: DomNode): Candidate[] {
  const transformSets = transformsFor(source);
  if (transformSets.length === 0) return [];
  const out: Candidate[] = [];
  for (const selector of selectorCandidates(source.el, scope, source.attr)) {
    for (const transforms of transformSets) {
      const c: Candidate = { selector, transforms };
      if (source.attr !== undefined) c.attr = source.attr;
      out.push(c);
    }
  }
  return out;
}

function transformsFor(source: Source): RecipeTransform[][] {
  switch (source.kind) {
    case 'text':
    case 'attr':
      return [[]];
    case 'url':
      return [['absolute-url']];
    case 'token':
      return classTokenRegexes(source.haystack.split(/\s+/).filter(Boolean), source.index).map((regex) => [{ regex }]);
    case 'text-part':
    case 'attr-part':
      return regexCandidates(source.haystack, source.index, source.matched).map((p) =>
        p.trim ? [{ regex: p.regex }, 'trim'] : [{ regex: p.regex }],
      );
  }
}

function scoreCandidate(
  $: cheerio.CheerioAPI,
  scopes: DomNode[],
  values: Array<string | null>,
  candidate: Candidate,
  ctx: TransformContext,
): Score {
  const score: Score = { matched: 0, extras: 0 };
  scopes.forEach((scope, i) => {
    const want = values[i];
    const got = extractOne($, scope, candidate, ctx);
    if (want === null) {
      if (got !== null) score.extras++;
    } else if (got !== null && norm(String(got)) === norm(want)) {
      score.matched++;
    }
  });
  return score;
}

function reproduces($: cheerio.CheerioAPI, scope: DomNode, candidate: Candidate, want: string, ctx: TransformContext): boolean {
  const got = extractOne($, scope, candidate, ctx);
  return got !== null && norm(String(got)) === norm(want);
}

/** Same reading rules as runRecipe for one scope (first match). */
function extractOne($: cheerio.CheerioAPI, scope: DomNode, candidate: Candidate, ctx: TransformContext): RecipeValue {
  let el: DomElement | undefined;
  if (candidate.selector === '') {
    el = isElement(scope) ? scope : undefined;
  } else {
    try {
      el = firstMatch($, scope, candidate.selector);
    } catch {
      return null;
    }
  }
  if (!el) return null;
  const raw = candidate.attr === undefined ? elementText(el, 100_000).text : readAttribute(el, candidate.attr);
  if (raw === null) return null;
  const value = applyTransforms(raw, compiled(candidate.transforms), ctx, []);
  return typeof value === 'string' && value.trim() === '' ? null : value;
}

/** First descendant of `scope` matching `selector`, in document order (same result as cheerio's find().first()). */
function firstMatch($: cheerio.CheerioAPI, scope: DomNode, selector: string): DomElement | undefined {
  const fast = compileFastSelector(selector);
  if (!fast) return $(scope as never).find(selector).first()[0] as unknown as DomElement | undefined;
  const test = fast.within(scope);
  const stack: DomNode[] = [];
  const pushChildren = (node: DomNode): void => {
    const children = (node as DomNode & { children?: DomNode[] }).children ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  };
  pushChildren(scope);
  while (stack.length > 0) {
    const node = stack.pop() as DomNode;
    if (!isElement(node)) continue;
    if (test(node)) return node;
    pushChildren(node);
  }
  return undefined;
}

const compiledCache = new Map<string, ReturnType<typeof compileTransforms>>();

function compiled(transforms: RecipeTransform[]): ReturnType<typeof compileTransforms> {
  const key = JSON.stringify(transforms);
  let c = compiledCache.get(key);
  if (!c) {
    c = compileTransforms(transforms);
    if (compiledCache.size > 1_000) compiledCache.clear();
    compiledCache.set(key, c);
  }
  return c;
}
