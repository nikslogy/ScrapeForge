// Trusted interpreter for declarative extraction recipes.
//
// Runs a validated recipe against one page snapshot: CSS selection (simple
// selectors through the single-pass matcher in fast-select.ts, the rest
// through cheerio), attribute and text reads, structured-data lookups by JSON
// pointer, and the allowlisted transforms. Nothing from the recipe is ever
// evaluated as code.
//
// Semantics: a field reads the first match (all matches, capped, with
// `all: true`); a missing element or empty text is null. A field with
// `structured` reads structured data first and falls back to its selector or
// attribute when the data lacks the value. In listings a match belongs to its
// nearest enclosing record, so nested records keep their own values.
//
// Work is bounded: records are capped (maxRecords), the deadline is checked
// between records and output size is budgeted; every stop is reported in
// `errors`, never thrown, and the complete records produced so far are
// returned.

import * as cheerio from 'cheerio';
import type { ExtractionRecipe, RecipeField, StructuredDataItem } from '../types.js';
import { type DomElement, type DomNode, effectiveBase, elementText, isElement, readAttribute } from './dom.js';
import { compileFastSelector, type FastSelector } from './fast-select.js';
import { RECIPE_LIMITS } from './limits.js';
import { escapePointerToken, parsePointer, resolvePointer } from './pointer.js';
import { applyTransforms, compileTransforms, type CompiledTransform, type RecipeValue, type TransformContext } from './transforms.js';
import { isValidatedRecipe, validateRecipe } from './validate.js';

export interface RecipeEvidence {
  /** JSON pointer into the returned data ("/price", "/3/price", "/3/images/0"). */
  path: string;
  /** Raw text, attribute or structured value before transforms; null when nothing was found. */
  raw: string | null;
  /** Field selector as written in the recipe ("" = the record/scope element). */
  selector?: string;
  /** Structured-data source as "<item id><pointer>", e.g. "sd0/offers/price". */
  structuredPointer?: string;
  /** Source step ("text", "attr:href", "structured", "not-found") then transform steps. */
  steps: string[];
}

export interface RecipeRunOptions {
  /** Page URL; relative links resolve against it (or the page's <base href>). */
  baseUrl: string;
  structured?: StructuredDataItem[];
  /** Records processed at most (array shape). Default 5,000. */
  maxRecords?: number;
  /** Absolute deadline, epoch ms (same convention as ExtractRequest.deadlineMs). */
  deadlineMs?: number;
}

export interface RecipeRunResult {
  data: Record<string, unknown> | Array<Record<string, unknown>>;
  evidence: RecipeEvidence[];
  /** Records returned (array shape); 1 or 0 (scope not found) for object shape. */
  recordCount: number;
  errors: string[];
}

export type RecipeInput = { html: string } | { $: cheerio.CheerioAPI };

/** domhandler's AnyNode, derived from cheerio's API so no transitive type package is imported. */
type AnyNode = Parameters<typeof cheerio.contains>[0];
type Selection = cheerio.Cheerio<AnyNode>;

/** Records per cheerio find() call: css-select checks every match against every context element. */
const RECORD_CHUNK = 32;

interface FieldPlan {
  name: string;
  /** JSON-pointer-escaped name for evidence paths. */
  pathName: string;
  field: RecipeField;
  /** DOM selector to run; undefined when the field reads structured data only. */
  selector?: string;
  transforms: CompiledTransform[];
  /** Structured read resolved once per page. */
  structured?: StructuredRead;
}

interface StructuredRead {
  source: string;
  raws: string[];
}

interface FieldResult {
  value: unknown;
  evidence: RecipeEvidence[];
}

/** Output accounting for one run (see RECIPE_LIMITS.maxOutputChars / maxOutputValues). */
interface Budget {
  chars: number;
  values: number;
  exceeded: boolean;
}

function newBudget(): Budget {
  return { chars: 0, values: 0, exceeded: false };
}

/** Charges one raw value; false (and `exceeded`) once the run is over budget. */
function charge(budget: Budget, raw: string): boolean {
  if (budget.exceeded) return false;
  budget.chars += raw.length;
  budget.values += 1;
  if (budget.chars > RECIPE_LIMITS.maxOutputChars || budget.values > RECIPE_LIMITS.maxOutputValues) budget.exceeded = true;
  return !budget.exceeded;
}

const BUDGET_ERROR = `output budget exceeded (${RECIPE_LIMITS.maxOutputChars} chars or ${RECIPE_LIMITS.maxOutputValues} values)`;

export function runRecipe(recipe: ExtractionRecipe, input: RecipeInput, opts: RecipeRunOptions): RecipeRunResult {
  let trusted: ExtractionRecipe;
  if (isValidatedRecipe(recipe)) {
    trusted = recipe;
  } else {
    const checked = validateRecipe(recipe);
    if (!checked.ok) {
      const data = (recipe as { shape?: unknown } | null)?.shape === 'array' ? [] : {};
      return { data, evidence: [], recordCount: 0, errors: checked.errors.map((e) => `invalid recipe: ${e}`) };
    }
    trusted = checked.recipe;
  }

  const errors: string[] = [];
  const evidence: RecipeEvidence[] = [];
  const emptyData = trusted.shape === 'array' ? [] : {};
  try {
    if (pastDeadline(opts.deadlineMs)) {
      return { data: emptyData, evidence, recordCount: 0, errors: ['deadline exceeded before the recipe ran'] };
    }
    const $ = 'html' in input ? cheerio.load(input.html) : input.$;
    const ctx: TransformContext = { baseUrl: opts.baseUrl, base: effectiveBase($('base[href]').first().attr('href'), opts.baseUrl) };
    const plans = planFields(trusted, opts.structured);
    if (trusted.shape === 'object') return runObject($, trusted, plans, ctx, evidence, errors);
    return runArray($, trusted, plans, ctx, opts, evidence, errors);
  } catch (err) {
    // Defensive: selectors were compiled during validation, so this is not expected.
    errors.push(`recipe run failed: ${(err as Error).message}`);
    return { data: emptyData, evidence, recordCount: 0, errors };
  }
}

function pastDeadline(deadlineMs: number | undefined): boolean {
  return deadlineMs !== undefined && Date.now() > deadlineMs;
}

function planFields(recipe: ExtractionRecipe, structured: StructuredDataItem[] | undefined): FieldPlan[] {
  return Object.keys(recipe.fields).map((name) => {
    const field = recipe.fields[name];
    const readsDom = field.structured === undefined || field.selector !== undefined || field.attr !== undefined;
    return {
      name,
      pathName: escapePointerToken(name),
      field,
      selector: readsDom ? (field.selector ?? '') : undefined,
      transforms: compileTransforms(field.transforms),
      structured: field.structured ? readStructured(structured, field.structured, field.all === true) : undefined,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────

function runObject(
  $: cheerio.CheerioAPI,
  recipe: ExtractionRecipe,
  plans: FieldPlan[],
  ctx: TransformContext,
  evidence: RecipeEvidence[],
  errors: string[],
): RecipeRunResult {
  const root = $.root();
  const scope = recipe.scopeSelector ? select(root, recipe.scopeSelector, 1)[0] : (root[0] as DomNode);
  if (!scope) errors.push('scope selector matched nothing');
  const budget = newBudget();
  const record: Record<string, unknown> = {};
  for (const plan of plans) {
    let elements: DomElement[] = [];
    if (scope && plan.selector !== undefined) {
      const limit = plan.field.all ? RECIPE_LIMITS.maxItemsPerField : 1;
      elements = plan.selector === '' ? [scope as DomElement] : select($(scope as AnyNode), plan.selector, limit);
    }
    const result = fieldValue(plan, elements, `/${plan.pathName}`, ctx, budget);
    record[plan.name] = result.value;
    evidence.push(...result.evidence);
  }
  if (budget.exceeded) errors.push(BUDGET_ERROR);
  return { data: record, evidence, recordCount: scope ? 1 : 0, errors };
}

function runArray(
  $: cheerio.CheerioAPI,
  recipe: ExtractionRecipe,
  plans: FieldPlan[],
  ctx: TransformContext,
  opts: RecipeRunOptions,
  evidence: RecipeEvidence[],
  errors: string[],
): RecipeRunResult {
  const requested = opts.maxRecords ?? RECIPE_LIMITS.defaultMaxRecords;
  const maxRecords = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : RECIPE_LIMITS.defaultMaxRecords;
  let records = select($.root(), recipe.recordSelector as string, Number.POSITIVE_INFINITY);
  if (records.length > maxRecords) {
    errors.push(`maxRecords reached: ${records.length} records matched, only the first ${maxRecords} were extracted`);
    records = records.slice(0, maxRecords);
  }
  const selection = $(records as AnyNode[]);
  const recordIndex = new Map<DomNode, number>();
  records.forEach((r, i) => recordIndex.set(r, i));
  const fastPlans: FastPlan[] = [];
  const fastIndex = plans.map((plan) => {
    const matcher = plan.selector ? compileFastSelector(plan.selector) : null;
    if (!matcher) return -1;
    fastPlans.push({ matcher, limit: plan.field.all ? RECIPE_LIMITS.maxItemsPerField : 1 });
    return fastPlans.length - 1;
  });

  const budget = newBudget();
  const data: Array<Record<string, unknown>> = [];
  outer: for (let start = 0; start < records.length; start += RECORD_CHUNK) {
    if (pastDeadline(opts.deadlineMs)) {
      errors.push(`deadline exceeded after ${data.length} of ${records.length} records`);
      break;
    }
    const chunk = selection.slice(start, start + RECORD_CHUNK);
    // Simple selectors are matched for all fields in one walk per record; the
    // rest use one find() per field and chunk. Either way a match belongs to
    // its nearest enclosing record, so a nested record keeps its own values.
    const chunkRecords = records.slice(start, start + RECORD_CHUNK);
    const fast = fastPlans.length > 0 ? chunkRecords.map((r) => matchRecordFast(r, fastPlans, recordIndex)) : [];
    const matches = plans.map((plan, p) => {
      const k = fastIndex[p];
      return k >= 0 ? chunkRecords.map((_, i) => fast[i][k]) : matchChunk(plan, chunk, start, recordIndex);
    });
    for (let i = 0; i < chunk.length; i++) {
      if (i > 0 && pastDeadline(opts.deadlineMs)) {
        errors.push(`deadline exceeded after ${data.length} of ${records.length} records`);
        break outer;
      }
      const index = start + i;
      const record: Record<string, unknown> = {};
      const recordEvidence: RecipeEvidence[] = [];
      plans.forEach((plan, p) => {
        const result = fieldValue(plan, matches[p][i], `/${index}/${plan.pathName}`, ctx, budget);
        record[plan.name] = result.value;
        for (const e of result.evidence) recordEvidence.push(e);
      });
      // A record cut short by the budget is dropped, so every record returned is complete.
      if (budget.exceeded) {
        errors.push(`${BUDGET_ERROR} after ${data.length} of ${records.length} records`);
        break outer;
      }
      data.push(record);
      for (const e of recordEvidence) evidence.push(e);
    }
  }
  return { data, evidence, recordCount: data.length, errors };
}

interface FastPlan {
  matcher: FastSelector;
  /** Matches kept per record (1, or maxItemsPerField for `all`). */
  limit: number;
}

/**
 * One document-order walk of the record's subtree testing every fast field.
 * Nested records are tested themselves but not entered: what is inside them
 * belongs to them.
 */
function matchRecordFast(record: DomElement, plans: FastPlan[], recordIndex: Map<DomNode, number>): DomElement[][] {
  const out: DomElement[][] = plans.map(() => []);
  const tests = plans.map((plan) => plan.matcher.within(record));
  let open = plans.length;
  const stack: DomNode[] = [];
  for (let i = record.children.length - 1; i >= 0; i--) stack.push(record.children[i]);
  while (stack.length > 0 && open > 0) {
    const node = stack.pop() as DomNode;
    if (!isElement(node)) continue;
    for (let k = 0; k < plans.length; k++) {
      const found = out[k];
      if (found.length >= plans[k].limit || !tests[k](node)) continue;
      found.push(node);
      if (found.length === plans[k].limit) open--;
    }
    if (recordIndex.has(node)) continue;
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return out;
}

/** Elements each record of the chunk yields for one field. */
function matchChunk(
  plan: FieldPlan,
  chunk: Selection,
  start: number,
  recordIndex: Map<DomNode, number>,
): DomElement[][] {
  const records = asElements(chunk);
  const out: DomElement[][] = records.map(() => []);
  if (plan.selector === undefined) return out;
  if (plan.selector === '') {
    records.forEach((r, i) => out[i].push(r));
    return out;
  }
  const limit = plan.field.all ? RECIPE_LIMITS.maxItemsPerField : 1;
  for (const el of asElements(chunk.find(plan.selector))) {
    let p = el.parent;
    while (p && !recordIndex.has(p)) p = p.parent;
    if (!p) continue;
    const i = (recordIndex.get(p) as number) - start;
    // Matches whose nearest record lies in another chunk are handled there.
    if (i < 0 || i >= records.length || out[i].length >= limit) continue;
    out[i].push(el);
  }
  return out;
}

function asElements(selection: Selection): DomElement[] {
  return selection.toArray() as DomElement[];
}

/**
 * Elements below the selection's first node matching `selector`, in document
 * order, at most `limit`. Simple selectors use the single-pass matcher (linear
 * even on hostile, very deep DOMs); the rest go through cheerio.
 */
function select(scope: Selection, selector: string, limit: number): DomElement[] {
  const fast = compileFastSelector(selector);
  if (!fast) {
    const found = scope.find(selector);
    return asElements(limit === Number.POSITIVE_INFINITY ? found : found.slice(0, limit));
  }
  const root = scope[0] as DomNode | undefined;
  if (!root) return [];
  const test = fast.within(root);
  const out: DomElement[] = [];
  const stack: DomNode[] = [];
  const pushChildren = (node: DomNode): void => {
    const children = (node as DomNode & { children?: DomNode[] }).children ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  };
  pushChildren(root);
  while (stack.length > 0 && out.length < limit) {
    const node = stack.pop() as DomNode;
    if (!isElement(node)) continue;
    if (test(node)) out.push(node);
    pushChildren(node);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Field values
// ─────────────────────────────────────────────────────────────

function fieldValue(plan: FieldPlan, elements: DomElement[], path: string, ctx: TransformContext, budget: Budget): FieldResult {
  const field = plan.field;
  let raws: string[] = [];
  let source: string;
  let structuredPointer: string | undefined;
  if (plan.structured && plan.structured.raws.length > 0) {
    raws = plan.structured.raws.filter((raw) => charge(budget, raw));
    source = 'structured';
    structuredPointer = plan.structured.source;
  } else if (elements.length > 0) {
    source = field.attr ? `attr:${field.attr}` : 'text';
    for (const el of elements) {
      if (budget.exceeded) break;
      const raw = readElement(el, field.attr);
      if (raw !== null && charge(budget, raw)) raws.push(raw);
    }
  } else {
    source = 'not-found';
  }
  const selector = plan.selector !== undefined && source !== 'structured' ? plan.selector : undefined;

  if (!field.all) {
    const raw = raws.length > 0 ? raws[0] : null;
    const steps = [raw === null && source !== 'not-found' ? `${source}:no-value` : source];
    const value = raw === null ? null : finish(applyTransforms(capped(raw, steps), plan.transforms, ctx, steps));
    return { value, evidence: [makeEvidence(path, raw, selector, structuredPointer, steps)] };
  }

  const values: unknown[] = [];
  const evidence: RecipeEvidence[] = [];
  for (const raw of raws) {
    const steps = [source];
    const value = finish(applyTransforms(capped(raw, steps), plan.transforms, ctx, steps));
    if (value === null) continue;
    evidence.push(makeEvidence(`${path}/${values.length}`, raw, selector, structuredPointer, steps));
    values.push(value);
  }
  if (values.length === 0) evidence.push(makeEvidence(path, null, selector, structuredPointer, [source]));
  return { value: values, evidence };
}

function readElement(el: DomElement, attr: string | undefined): string | null {
  if (attr === undefined) return elementText(el, RECIPE_LIMITS.maxValueChars).text;
  // The scope of an object recipe without scopeSelector is the document root.
  if (!el.attribs) return null;
  return readAttribute(el, attr);
}

function capped(raw: string, steps: string[]): string {
  if (raw.length <= RECIPE_LIMITS.maxValueChars) return raw;
  steps.push('truncated');
  return raw.slice(0, RECIPE_LIMITS.maxValueChars);
}

/** Empty text is not a value. */
function finish(value: RecipeValue): RecipeValue {
  return typeof value === 'string' && value.trim() === '' ? null : value;
}

function makeEvidence(
  path: string,
  raw: string | null,
  selector: string | undefined,
  structuredPointer: string | undefined,
  steps: string[],
): RecipeEvidence {
  const e: RecipeEvidence = { path, raw: raw === null || raw.length <= RECIPE_LIMITS.maxValueChars ? raw : raw.slice(0, RECIPE_LIMITS.maxValueChars), steps };
  if (selector !== undefined) e.selector = selector;
  if (structuredPointer !== undefined) e.structuredPointer = structuredPointer;
  return e;
}

// ─────────────────────────────────────────────────────────────
// Structured data
// ─────────────────────────────────────────────────────────────

function typeMatches(itemType: string | undefined, want: string): boolean {
  if (!itemType) return false;
  const a = itemType.toLowerCase();
  const b = want.toLowerCase();
  if (a === b) return true;
  // "https://schema.org/Product" or "schema:Product" vs "Product".
  const tail = a.slice(Math.max(a.lastIndexOf('/'), a.lastIndexOf(':'), a.lastIndexOf('#')) + 1);
  return tail === b;
}

/** First structured item (of the wanted type) where the pointer leads to a usable value. */
function readStructured(
  items: StructuredDataItem[] | undefined,
  spec: NonNullable<RecipeField['structured']>,
  all: boolean,
): StructuredRead | undefined {
  const tokens = parsePointer(spec.pointer);
  if (!items || !tokens) return undefined;
  for (const item of items) {
    if (spec.type !== undefined && !typeMatches(item.type, spec.type)) continue;
    const raws = scalarRaws(resolvePointer(item.data, tokens), all);
    if (raws.length > 0) return { source: `${item.id}${spec.pointer}`, raws };
  }
  return undefined;
}

function scalarText(v: unknown): string | null {
  if (typeof v === 'string') return v.length > RECIPE_LIMITS.maxValueChars ? v.slice(0, RECIPE_LIMITS.maxValueChars) : v;
  if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') return String(v);
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, '@value')) {
    return scalarText((v as Record<string, unknown>)['@value']);
  }
  return null;
}

function scalarRaws(value: unknown, all: boolean): string[] {
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const v of value) {
      const s = scalarText(v);
      if (s !== null) out.push(s);
      if (out.length >= (all ? RECIPE_LIMITS.maxItemsPerField : 1)) break;
    }
    return out;
  }
  const s = scalarText(value);
  return s === null ? [] : [s];
}
