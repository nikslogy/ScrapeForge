// Extraction engine: orchestrates the stages of docs/engine/DESIGN.md and
// assembles an honest ExtractionOutcome.
//
//   schema → document → blocked page? → structured data → active recipe
//          → LLM over annotated blocks (only for what is still unresolved)
//          → grounding + normalization in code → merge → Ajv validation
//          → (best effort, after the answer) recipe learning
//
// Page and model problems never throw: they become failed/partial outcomes
// with explicit missing reasons and warnings. Only programmer errors (a
// malformed request or deps object) throw.

import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { roundMs, StageTracer } from '../tracing.js';
import { blockContext, buildSourceDocument, documentBuildInfo, renderBlocks } from './document/index.js';
import {
  Budget,
  buildExtractionPrompt,
  buildRepairPrompt,
  estimateTokens,
  parseExtractionResponse,
  planInputBudget,
  type ModelClient,
  type ParsedCell,
  type ParsedRecord,
} from './llm/index.js';
import { LlmCallError } from './llm/errors.js';
import {
  buildRecipePrompt,
  checkInvariants,
  compareOutputs,
  induceRecipe,
  isReservedFieldName,
  parseRecipeResponse,
  runRecipe,
  valuesAgree,
  type RecipeEvidence,
  type RecipeStore,
} from './recipe/index.js';
import { normalizeSchema, SchemaError } from './schema/index.js';
import { extractFromStructuredData, type StructuredFieldValue } from './structured/index.js';
import {
  LlmError,
  type ExtractionMethod,
  type ExtractionOutcome,
  type ExtractionRecipe,
  type ExtractionStatus,
  type ExtractRequest,
  type FieldEvidence,
  type FieldSpec,
  type LlmAttemptRecord,
  type LlmErrorCategory,
  type LlmUsageSummary,
  type MissingField,
  type MissingReason,
  type NormalizedSchema,
  type RecipeKey,
  type SourceDocument,
  type StoredRecipe,
} from './types.js';
import { checkGrounding, isUrlField, normalizeValue, prepareText, validateOutput, type NormalizeContext, type PreparedText } from './validate/index.js';

export type LearningMode = 'background' | 'await' | 'off';

export interface ExtractDeps {
  /** null (or a client without models) → fields the LLM would handle are reported missing. */
  modelClient: ModelClient | null;
  /** null disables the recipe stage and recipe learning. */
  recipeStore: RecipeStore | null;
  /** Stage times are added to this tracer as well as to outcome.timings. */
  tracer?: StageTracer;
  /** Recipe learning after an LLM run. Default 'background' (never delays the answer). */
  learning?: LearningMode;
  /** Set by the caller when the fetch layer already classified the page as a block/challenge page. */
  sourceBlocked?: { reason: string };
  /**
   * Ask the model for a recipe when deterministic induction fails (one more
   * model call). Default: process.env.EXTRACT_RECIPE_PROPOSE === '1'.
   */
  proposeRecipes?: boolean;
  /** Sink for background-learning diagnostics. Default console.warn. */
  log?: (message: string) => void;
}

// ─────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────

/** Output tokens reserved per field per expected record (raw value + block id + JSON framing). */
const OUTPUT_TOKENS_PER_CELL = 40;
/** Never ask for fewer output tokens than this (long string values, prose around JSON). */
const MIN_OUTPUT_TOKENS = 1_024;
/** Characters per token assumed for rendered blocks when converting a token budget to maxChars. */
const CHARS_PER_TOKEN = 3.2;
/** Missing entries reported at most; the rest are summarized in a warning. */
const MAX_MISSING_ENTRIES = 1_000;
/** Per warning kind (text before the first ':'), at most this many distinct entries. */
const MAX_WARNINGS_PER_KIND = 20;
const MAX_EXCERPT_CHARS = 200;
const MAX_REASON_CHARS = 100;
/** Learning samples taken from the first records of a listing. */
const MAX_LEARNING_SAMPLES = 10;
/** Background learning runs in flight at once per process; more are skipped. */
const MAX_BACKGROUND_LEARNING = 4;
/** Wall-clock bound for induction (CPU on the event loop). */
const INDUCTION_BUDGET_MS = 2_000;
/** Deadline for a model-proposed recipe call (runs after the answer). */
const PROPOSAL_TIMEOUT_MS = 30_000;
/** Pages with more visible text than this are never classified as challenge pages by the engine. */
const CHALLENGE_MAX_TEXT_CHARS = 2_000;
/** Below this much visible text a single challenge signal is enough. */
const CHALLENGE_TINY_TEXT_CHARS = 500;
const CHALLENGE_MARKUP_SCAN_CHARS = 256 * 1024;

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

export async function extractStructured(req: ExtractRequest, deps: ExtractDeps): Promise<ExtractionOutcome> {
  assertRequest(req);
  assertDeps(deps);
  return new ExtractionRun(req, deps).execute();
}

/** Resolves when every background learning run started so far has settled (tests, graceful shutdown). */
export async function flushRecipeLearning(): Promise<void> {
  while (backgroundLearning.size > 0) await Promise.allSettled([...backgroundLearning]);
}

const backgroundLearning = new Set<Promise<void>>();

function assertRequest(req: ExtractRequest): void {
  if (typeof req !== 'object' || req === null) throw new TypeError('extractStructured: request must be an object');
  if (typeof req.html !== 'string') throw new TypeError('extractStructured: html must be a string');
  if (typeof req.url !== 'string' || req.url === '') throw new TypeError('extractStructured: url must be a non-empty string');
  if (typeof req.tenantId !== 'string' || req.tenantId === '') throw new TypeError('extractStructured: tenantId must be a non-empty string');
  if (!Number.isFinite(req.deadlineMs)) throw new TypeError('extractStructured: deadlineMs must be a finite epoch ms value');
  if (req.maxCostUsd !== undefined && !(Number.isFinite(req.maxCostUsd) && req.maxCostUsd >= 0)) {
    throw new TypeError('extractStructured: maxCostUsd must be a non-negative number');
  }
  if (req.disable !== undefined && !Array.isArray(req.disable)) throw new TypeError('extractStructured: disable must be an array');
}

function assertDeps(deps: ExtractDeps): void {
  if (typeof deps !== 'object' || deps === null) throw new TypeError('extractStructured: deps must be an object');
  if (deps.learning !== undefined && !['background', 'await', 'off'].includes(deps.learning)) {
    throw new TypeError(`extractStructured: unknown learning mode ${String(deps.learning)}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Blocked / challenge pages
// ─────────────────────────────────────────────────────────────

const CHALLENGE_TITLE =
  /^(?:just a moment|attention required|access denied|checking your browser|please wait\b|verifying you are human|verify you are (?:a )?human|security check|one more step|are you a robot|pardon our interruption|request blocked|you have been blocked|human verification|bot verification|ddos-guard)/i;
const CHALLENGE_TEXT =
  /verifying you are human|verify you are (?:a )?human|checking (?:your browser|if the site connection is secure)|needs to review the security of your connection|enable javascript and cookies to continue|please complete the security check|press (?:&|and) hold to confirm|you have been blocked|unusual traffic from your computer network|request unsuccessful\. incapsula|access to this page has been denied|pardon our interruption/i;
const CHALLENGE_MARKUP =
  /cdn-cgi\/challenge-platform|_cf_chl_opt|\bcf-chl-|\bcf_chl_|challenges\.cloudflare\.com|\bcf-turnstile\b|captcha-delivery\.com|\bpx-captcha\b|_Incapsula_Resource|ddos-guard\.net\/|\/_sec\/cp_challenge|\bsec-if-cpt\b/i;

/**
 * Challenge / interstitial detection on the built document. Conservative:
 * only pages with little visible text qualify, and they need either two
 * independent signals (title, text, markup) or one signal on a nearly empty
 * page. A product page that embeds a captcha widget in a review form is not
 * a challenge page.
 */
export function detectBlockedPage(doc: SourceDocument, html: string): { reason: string; signals: string[] } | null {
  const textChars = doc.stats.textChars;
  if (textChars > CHALLENGE_MAX_TEXT_CHARS) return null;
  const signals: string[] = [];
  if (CHALLENGE_TITLE.test((doc.title ?? '').trim())) signals.push('title');
  if (CHALLENGE_TEXT.test(doc.text)) signals.push('text');
  if (CHALLENGE_MARKUP.test(html.length > CHALLENGE_MARKUP_SCAN_CHARS ? html.slice(0, CHALLENGE_MARKUP_SCAN_CHARS) : html)) {
    signals.push('markup');
  }
  if (signals.length >= 2 || (signals.length === 1 && textChars <= CHALLENGE_TINY_TEXT_CHARS)) {
    return { reason: 'challenge_page', signals };
  }
  return null;
}

/** Bot-wall indicators that only interstitials use (a "JavaScript required" notice is not one: SPA shells print it too). */
const STRONG_BOT_INDICATOR =
  /challenge|captcha|verif(?:y|ying) (?:that )?you are (?:a )?human|just a moment|checking (?:your|the) browser|access denied|you have been blocked|unusual traffic|are you a robot|press (?:&|and) hold/i;

/**
 * Block classification from the fetch layer's quality report (see
 * extraction/quality-scorer.ts). Bot-wall keywords alone are common on real
 * pages ("captcha" in a form, "enable JavaScript" in an SPA shell), so they
 * only count with a blocking HTTP status, or when they are challenge-specific
 * and the quality score is already near zero.
 */
export function blockedFromQualitySignals(quality: { score: number; signals: string[] }, statusCode: number): { reason: string } | undefined {
  const botSignal = quality.signals.find((s) => s.startsWith('Bot detection indicators'));
  if (botSignal === undefined) return undefined;
  if (statusCode === 403 || statusCode === 429 || statusCode === 503) return { reason: `bot_wall_http_${statusCode}` };
  const indicators = botSignal.slice(botSignal.indexOf(':') + 1);
  if (quality.score <= 0.3 && STRONG_BOT_INDICATOR.test(indicators)) return { reason: 'bot_wall' };
  return undefined;
}

// ─────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function sanitizeReason(reason: unknown): string {
  const text = typeof reason === 'string' ? reason : 'unspecified';
  const clean = text.replace(/[\u0000-\u001f\u007f\s]+/g, '_').slice(0, MAX_REASON_CHARS);
  return clean === '' ? 'unspecified' : clean;
}

function clip(text: string, max = MAX_EXCERPT_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** null, blank strings, and arrays/objects holding only such values: nothing was claimed. */
function isEmptyRaw(v: unknown, depth = 0): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v !== 'object') return false;
  if (depth > 32) return false;
  const members = Array.isArray(v) ? v : Object.values(v);
  return members.every((m) => isEmptyRaw(m, depth + 1));
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

const COMMA_DECIMAL_LANGS = new Set([
  'de', 'fr', 'es', 'it', 'pt', 'nl', 'ru', 'pl', 'cs', 'sk', 'sv', 'da', 'fi', 'nb', 'nn', 'no', 'tr', 'id', 'vi', 'el',
  'hu', 'ro', 'bg', 'uk', 'hr', 'sl', 'sr', 'lt', 'lv', 'et', 'ca', 'eu', 'gl', 'is', 'az', 'kk', 'be',
]);
const DOT_DECIMAL_LANGS = new Set(['en', 'ja', 'zh', 'ko', 'he', 'th', 'hi', 'ms', 'fil', 'tl']);
// Regions whose convention differs from the language default.
const DOT_DECIMAL_REGIONS = new Set(['de-ch', 'de-li', 'it-ch', 'es-mx', 'es-us', 'es-pr', 'es-do', 'es-gt', 'es-hn', 'es-ni', 'es-pa', 'es-sv']);
const COMMA_DECIMAL_REGIONS = new Set(['en-za']);
const HTML_LANG = /<html\b[^>]{0,2000}?\blang\s*=\s*["']?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?)/i;

/** Decimal separator implied by <html lang>; only used for the ambiguous "1.234" shape. */
export function decimalSeparatorFromHtml(html: string): '.' | ',' | undefined {
  const m = HTML_LANG.exec(html.slice(0, 16_384));
  if (!m) return undefined;
  const tag = m[1].toLowerCase().replace('_', '-');
  if (DOT_DECIMAL_REGIONS.has(tag)) return '.';
  if (COMMA_DECIMAL_REGIONS.has(tag)) return ',';
  const lang = tag.split('-')[0];
  if (COMMA_DECIMAL_LANGS.has(lang)) return ',';
  if (DOT_DECIMAL_LANGS.has(lang)) return '.';
  return undefined;
}

// A structured value that is a schema.org enumeration URL ("https://schema.org/InStock")
// is a machine code, not what the page displays, even when the visibility
// check matched its meaning ("In stock"). For a plain text field it is not
// accepted as a verified value.
const SCHEMA_ORG_ENUM = /^https?:\/\/(?:www\.)?schema\.org\/[A-Za-z]+$/;

/** Ordered, de-duplicated warnings with a per-kind cap. */
class Warnings {
  readonly #items = new Set<string>();
  readonly #perKind = new Map<string, number>();
  readonly #dropped = new Map<string, number>();

  add(warning: string): void {
    if (this.#items.has(warning)) return;
    const kind = warning.split(':', 1)[0];
    const n = this.#perKind.get(kind) ?? 0;
    if (n >= MAX_WARNINGS_PER_KIND) {
      this.#dropped.set(kind, (this.#dropped.get(kind) ?? 0) + 1);
      return;
    }
    this.#perKind.set(kind, n + 1);
    this.#items.add(warning);
  }

  list(): string[] {
    const out = [...this.#items];
    for (const [kind, n] of this.#dropped) out.push(`${kind}:+${n} more`);
    return out;
  }
}

// ─────────────────────────────────────────────────────────────
// Per-value state
// ─────────────────────────────────────────────────────────────

type SlotSource = 'structured' | 'structured-fallback' | 'recipe' | 'llm';

interface Slot {
  value: unknown;
  source?: SlotSource;
  /** Evidence without its path (filled in once the final shape is known). */
  evidence?: Omit<FieldEvidence, 'path'>;
  missing?: { reason: MissingReason; detail?: string };
  /** Set when the value was found on the page but not in the cited block. */
  citationNote?: string;
}

interface StructuredCandidate {
  value: unknown;
  verified: boolean;
  evidence: Omit<FieldEvidence, 'path'>;
}

/** One field cell as the LLM stage produced it, plus what learning needs to know. */
interface LlmSlot extends Slot {
  /** Raw v as the model reported it. */
  raw?: unknown;
  /** Grounded in the cited block/attrs/record and normalized without problems. */
  clean: boolean;
  /** Block whose record group the value came from (learning). */
  recordGroupId?: string;
}

type EffectiveShape = 'object' | 'array' | 'auto';

interface LlmStageResult {
  ran: boolean;
  /** Parsed records (array/auto) or [one record] (object); empty when the call failed. */
  records: Array<Map<string, LlmSlot>>;
  /** Failure that left the asked fields unresolved. */
  failure?: { reason: MissingReason; detail: string };
}

// ─────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────

class ExtractionRun {
  private readonly tracer: StageTracer;
  private readonly timings = new Map<string, number>();
  private readonly warnings = new Warnings();
  private readonly attempts: LlmAttemptRecord[] = [];
  private readonly disabled: Set<string>;
  private schema!: NormalizedSchema;
  private doc!: SourceDocument;
  private prepared!: PreparedText;
  private nctx!: NormalizeContext;
  private truncated = false;
  private blocksSentToModel = 0;
  private $?: cheerio.CheerioAPI;
  private rejectedCount = 0;

  constructor(
    private readonly req: ExtractRequest,
    private readonly deps: ExtractDeps,
  ) {
    this.tracer = deps.tracer ?? new StageTracer();
    this.disabled = new Set(req.disable ?? []);
  }

  // ── timing ───────────────────────────────────────────────

  private record(stage: string, ms: number): void {
    this.tracer.add(stage, ms);
    this.timings.set(stage, (this.timings.get(stage) ?? 0) + (Number.isFinite(ms) && ms > 0 ? ms : 0));
  }

  private timeSync<T>(stage: string, fn: () => T): T {
    const t0 = this.tracer.now();
    try {
      return fn();
    } finally {
      this.record(stage, this.tracer.now() - t0);
    }
  }

  private async timeAsync<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const t0 = this.tracer.now();
    try {
      return await fn();
    } finally {
      this.record(stage, this.tracer.now() - t0);
    }
  }

  private timingsSnapshot(): Record<string, number> {
    return Object.fromEntries([...this.timings].map(([k, v]) => [k, roundMs(v)]));
  }

  // ── main flow ────────────────────────────────────────────

  async execute(): Promise<ExtractionOutcome> {
    const { req } = this;
    try {
      this.schema = this.timeSync('schema', () => normalizeSchema(req.schema));
    } catch (err) {
      if (!(err instanceof SchemaError)) throw err;
      return this.invalidSchemaOutcome(err);
    }
    const schema = this.schema;

    this.doc = this.timeSync('document', () => buildSourceDocument(req.html, req.url));
    this.prepared = prepareText(this.doc.text);
    this.nctx = { baseUrl: req.url };
    const decimal = decimalSeparatorFromHtml(req.html);
    if (decimal) this.nctx.decimalSeparator = decimal;
    const build = documentBuildInfo(this.doc);
    for (const w of build.warnings) this.warnings.add(`document:${w}`);

    const blocked = this.deps.sourceBlocked
      ? { reason: sanitizeReason(this.deps.sourceBlocked.reason) }
      : detectBlockedPage(this.doc, req.html);
    if (blocked) return this.blockedOutcome(blocked.reason);

    // ── structured data ──
    const mapped = this.disabled.has('structured')
      ? null
      : this.timeSync('structured', () => {
          const result = extractFromStructuredData(this.doc, schema);
          // The mapper's own "not visible" notes are re-issued only when such a value is actually used.
          for (const w of result.warnings) if (!w.startsWith('structured_value_not_visible:')) this.warnings.add(w);
          return { shape: result.shape, records: result.records.map((r) => this.structuredRecord(r)) };
        });
    const structured = new Map<string, StructuredCandidate>();
    const structuredShape = mapped?.shape ?? null;
    const structuredRecords = mapped?.records ?? [];

    // Effective shape: the structured mapper already decided object vs list
    // for 'auto' ("a list only when the page clearly lists ≥ 2 items").
    let shape: EffectiveShape = schema.shape;
    const objectSlots = new Map<string, Slot>();
    let arrayRecords: Array<Map<string, Slot>> | null = null;

    if (structuredShape === 'object' && structuredRecords.length > 0 && schema.shape !== 'array') {
      for (const [name, c] of structuredRecords[0]) structured.set(name, c);
      if (schema.shape === 'auto' && [...structured.values()].some((c) => c.verified)) shape = 'object';
    } else if (structuredShape === 'array' && schema.shape !== 'object' && this.structuredArrayComplete(structuredRecords)) {
      shape = 'array';
      arrayRecords = structuredRecords.map((rec) => {
        const out = new Map<string, Slot>();
        for (const [name, c] of rec) out.set(name, { value: c.value, source: 'structured', evidence: c.evidence });
        return out;
      });
    }
    if (shape !== 'array') {
      for (const [name, c] of structured) {
        if (c.verified) objectSlots.set(name, { value: c.value, source: 'structured', evidence: c.evidence });
      }
    }

    // ── active recipe ──
    const recipeKey = this.recipeKey();
    let activeRecipeSeen = false;
    if (this.deps.recipeStore && recipeKey && !this.disabled.has('recipe') && arrayRecords === null && this.unresolved(objectSlots, shape).length > 0) {
      const served = await this.timeAsync('recipe', () => this.serveRecipe(recipeKey, shape, objectSlots));
      activeRecipeSeen = served.activeSeen;
      if (served.records) {
        shape = 'array';
        arrayRecords = served.records;
      } else if (served.shape === 'object' && shape === 'auto') {
        shape = 'object';
      }
    }

    // ── LLM ──
    let llm: LlmStageResult = { ran: false, records: [] };
    const asked = arrayRecords === null ? this.unresolved(objectSlots, shape) : [];
    if (asked.length > 0) llm = await this.timeAsync('llm', () => this.runLlm(asked, shape));

    // ── merge ──
    let finalShape: 'object' | 'array';
    let records: Array<Map<string, Slot>>;
    if (arrayRecords !== null) {
      finalShape = 'array';
      records = arrayRecords;
    } else if (shape === 'array' || (shape === 'auto' && llm.records.length > 1)) {
      finalShape = 'array';
      records = llm.records;
    } else {
      finalShape = 'object';
      records = [this.mergeObject(objectSlots, structured, asked, llm)];
    }

    if (this.rejectedCount > 0) this.warnings.add(`ungrounded_values_rejected:${this.rejectedCount}`);
    const outcome = this.timeSync('validate', () => this.finish(finalShape, records, llm));
    await this.maybeLearn(outcome, llm, asked, finalShape, recipeKey, activeRecipeSeen);
    outcome.timings = this.timingsSnapshot();
    return outcome;
  }

  // ── structured stage ─────────────────────────────────────

  private structuredRecord(rec: Record<string, StructuredFieldValue>): Map<string, StructuredCandidate> {
    const out = new Map<string, StructuredCandidate>();
    for (const field of this.schema.fields) {
      if (!hasOwn(rec, field.name)) continue;
      const sv = rec[field.name];
      const norm = normalizeValue(sv.raw, field, this.nctx);
      if (!norm.ok) {
        this.warnings.add(`structured_value_unusable:${field.name}`);
        continue;
      }
      if (norm.value === null || isEmptyRaw(norm.value)) continue;
      const displayMismatch =
        field.type === 'string' && !isUrlField(field) && typeof sv.raw === 'string' && SCHEMA_ORG_ENUM.test(sv.raw.trim());
      const verified = sv.visibleInPage && !displayMismatch;
      out.set(field.name, {
        value: norm.value,
        verified,
        evidence: {
          source: 'structured-data',
          structuredId: sv.structuredId,
          raw: sv.raw,
          normalization: norm.steps,
          grounded: verified,
          ...(field.derived ? { derived: true } : {}),
        },
      });
    }
    return out;
  }

  /** Arrays are taken from structured data only when every record fills every field visibly. */
  private structuredArrayComplete(records: Array<Map<string, StructuredCandidate>>): boolean {
    if (records.length === 0) return false;
    return records.every((rec) => this.schema.fields.every((f) => rec.get(f.name)?.verified === true));
  }

  private unresolved(objectSlots: Map<string, Slot>, shape: EffectiveShape): FieldSpec[] {
    if (shape !== 'object') return [...this.schema.fields];
    return this.schema.fields.filter((f) => !objectSlots.has(f.name));
  }

  // ── recipe stage ─────────────────────────────────────────

  private recipeKey(): RecipeKey | null {
    let host: string;
    try {
      host = new URL(this.req.url).hostname;
    } catch {
      return null;
    }
    if (host === '' || this.doc.templateSignature === '') return null;
    return { tenantId: this.req.tenantId, host, templateSignature: this.doc.templateSignature, schemaHash: this.schema.hash };
  }

  private cheerioDoc(): cheerio.CheerioAPI {
    this.$ ??= cheerio.load(this.req.html);
    return this.$;
  }

  /**
   * Runs the recipe and normalizes its values field by field. Values that
   * fail normalization become null (the invariants then decide).
   */
  private applyRecipe(recipe: ExtractionRecipe, deadlineMs: number): {
    records: Array<Map<string, Slot>>;
    data: Record<string, unknown> | Array<Record<string, unknown>>;
    recordCount: number;
    errors: string[];
  } {
    const result = runRecipe(recipe, { $: this.cheerioDoc() }, {
      baseUrl: this.req.url,
      structured: this.doc.structured,
      deadlineMs,
    });
    const evidenceByPath = new Map<string, RecipeEvidence>();
    for (const ev of result.evidence) if (!evidenceByPath.has(ev.path)) evidenceByPath.set(ev.path, ev);
    const fields = this.schema.fields.filter((f) => hasOwn(recipe.fields, f.name));
    const rawRecords = Array.isArray(result.data) ? result.data : [result.data];
    const records: Array<Map<string, Slot>> = [];
    const data: Array<Record<string, unknown>> = [];
    rawRecords.forEach((raw, i) => {
      const slots = new Map<string, Slot>();
      const plain: Array<[string, unknown]> = [];
      for (const field of fields) {
        const rawValue = hasOwn(raw, field.name) ? raw[field.name] : null;
        const ev = evidenceByPath.get(Array.isArray(result.data) ? `/${i}/${escapePointer(field.name)}` : `/${escapePointer(field.name)}`);
        const norm = normalizeValue(rawValue, field, this.nctx);
        const value = norm.ok && !isEmptyRaw(norm.value) ? norm.value : null;
        plain.push([field.name, value]);
        if (value === null) {
          slots.set(field.name, { value: null, source: 'recipe', missing: { reason: 'not_found', detail: norm.ok ? 'recipe found no value' : `recipe value: ${norm.detail}` } });
        } else {
          slots.set(field.name, {
            value,
            source: 'recipe',
            evidence: {
              source: 'recipe',
              raw: ev?.raw ?? rawValue,
              normalization: [...(ev?.steps ?? []), ...(norm.ok ? norm.steps : [])],
              grounded: true,
              ...(field.derived ? { derived: true } : {}),
            },
          });
        }
      }
      records.push(slots);
      data.push(Object.fromEntries(plain));
    });
    return {
      records,
      data: Array.isArray(result.data) ? data : (data[0] ?? {}),
      recordCount: result.recordCount,
      errors: result.errors,
    };
  }

  private async serveRecipe(
    key: RecipeKey,
    shape: EffectiveShape,
    objectSlots: Map<string, Slot>,
  ): Promise<{ activeSeen: boolean; records?: Array<Map<string, Slot>>; shape?: 'object' | 'array' }> {
    const store = this.deps.recipeStore as RecipeStore;
    let stored: StoredRecipe | null;
    try {
      stored = await store.get(key);
    } catch (err) {
      this.warnings.add(`recipe_store_unavailable:${errorName(err)}`);
      return { activeSeen: false };
    }
    if (!stored || stored.state !== 'active') return { activeSeen: false };
    const recipe = stored.recipe;
    if ((shape === 'object' && recipe.shape !== 'object') || (shape === 'array' && recipe.shape !== 'array')) {
      this.warnings.add('recipe_shape_mismatch');
      return { activeSeen: true };
    }
    if (recipe.shape === 'array' && !this.schema.fields.every((f) => hasOwn(recipe.fields, f.name))) {
      // Listings are taken from one source only: a recipe that cannot fill every field is not used.
      return { activeSeen: true };
    }

    const applied = this.applyRecipe(recipe, this.req.deadlineMs);
    const invariants = checkInvariants(stored, { data: applied.data, recordCount: applied.recordCount });
    const ok = invariants.ok && applied.errors.length === 0;
    try {
      await store.recordUse(key, ok);
    } catch (err) {
      this.warnings.add(`recipe_store_unavailable:${errorName(err)}`);
    }
    if (!ok) {
      const reason = applied.errors[0] ?? invariants.reasons[0] ?? 'invariants failed';
      this.warnings.add(`recipe_rejected:${clip(reason.replace(/\s+/g, ' '), 120)}`);
      return { activeSeen: true };
    }
    if (recipe.shape === 'array') return { activeSeen: true, records: applied.records, shape: 'array' };
    const rec = applied.records[0];
    if (rec) {
      for (const [name, slot] of rec) if (!objectSlots.has(name)) objectSlots.set(name, slot);
    }
    return { activeSeen: true, shape: 'object' };
  }

  // ── LLM stage ────────────────────────────────────────────

  private async runLlm(fields: FieldSpec[], shape: EffectiveShape): Promise<LlmStageResult> {
    if (this.disabled.has('llm')) {
      this.warnings.add('llm_disabled');
      return { ran: false, records: [], failure: { reason: 'not_processed', detail: 'llm_disabled' } };
    }
    const client = this.deps.modelClient;
    if (!client || client.models.length === 0) {
      this.warnings.add('no_model_configured');
      return { ran: false, records: [], failure: { reason: 'provider_failure', detail: 'no_model_configured' } };
    }
    if (documentBuildInfo(this.doc).truncated) {
      this.truncated = true;
      this.warnings.add('input_truncated');
    }

    const shapeHint: 'object' | 'array' | 'auto' = shape;
    const reduced: NormalizedSchema = { ...this.schema, fields, shape: shapeHint };
    const primary = client.models[0];
    const expected = shape === 'object' ? 1 : expectedRecordCount(this.doc);
    const outputTokens = Math.max(1, Math.min(primary.maxOutputTokens, Math.max(MIN_OUTPUT_TOKENS, expected * fields.length * OUTPUT_TOKENS_PER_CELL)));
    const frame = buildExtractionPrompt({ schema: reduced, renderedBlocks: '', url: this.req.url, title: this.doc.title, shapeHint });
    const schemaText = frame.user + (primary.jsonMode === 'json_schema' ? JSON.stringify(frame.responseSchema) : '');
    const inputTokens = planInputBudget(primary, { systemText: frame.system, schemaText, reservedOutputTokens: outputTokens });
    if (inputTokens <= 0) {
      this.warnings.add('llm_failed:input_too_large');
      return { ran: false, records: [], failure: { reason: 'provider_failure', detail: 'input_too_large: the prompt frame does not fit the model context' } };
    }
    const budget = new Budget({ deadlineMs: this.req.deadlineMs, maxCostUsd: this.req.maxCostUsd });
    const parseSource = { provider: primary.provider, model: primary.model };

    let maxChars = Math.floor(inputTokens * CHARS_PER_TOKEN);
    let retriedSmaller = false;
    for (;;) {
      const rendered = this.render(maxChars, inputTokens);
      if (rendered.truncated) {
        this.truncated = true;
        this.warnings.add('input_truncated');
      }
      this.blocksSentToModel = rendered.includedIds.length;
      const prompt = buildExtractionPrompt({ schema: reduced, renderedBlocks: rendered.text, url: this.req.url, title: this.doc.title, shapeHint });
      const estimatedInputTokens =
        estimateTokens(prompt.system) + estimateTokens(prompt.user) + (primary.jsonMode === 'json_schema' ? estimateTokens(JSON.stringify(prompt.responseSchema)) : 0);

      const call = await this.complete(client, budget, {
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens: outputTokens,
        responseSchema: prompt.responseSchema,
        temperature: 0,
      }, 'extract', estimatedInputTokens);

      let failure: { category: LlmErrorCategory; message: string } | undefined;
      let parsedRecords: ParsedRecord[] | undefined;
      if (call.ok) {
        const parsed = this.parse(call.text, reduced, parseSource);
        if (parsed.ok) {
          parsedRecords = parsed.records;
        } else if (parsed.category === 'parse_error') {
          const repair = buildRepairPrompt(call.text, parsed.message);
          const repaired = await this.complete(client, budget, { system: repair.system, user: repair.user, maxOutputTokens: outputTokens, temperature: 0 }, 'repair', estimateTokens(repair.system) + estimateTokens(repair.user));
          if (repaired.ok) {
            const again = this.parse(repaired.text, reduced, parseSource);
            if (again.ok) parsedRecords = again.records;
            else failure = { category: again.category, message: again.message };
          } else {
            failure = repaired.failure;
          }
        } else {
          failure = { category: parsed.category, message: parsed.message };
        }
      } else {
        failure = call.failure;
      }

      if (parsedRecords) {
        // An object needs one record; extra ones are not checked (or counted as rejections).
        const used = shape === 'object' ? parsedRecords.slice(0, 1) : parsedRecords;
        return { ran: true, records: used.map((r) => this.processRecord(r, fields, shape)) };
      }
      const f = failure as { category: LlmErrorCategory; message: string };
      if ((f.category === 'output_truncated' || f.category === 'input_too_large') && !retriedSmaller && maxChars > 1) {
        retriedSmaller = true;
        maxChars = Math.floor(Math.min(maxChars, rendered.text.length) / 2);
        this.truncated = true;
        this.warnings.add(`llm_retry_smaller_input:${f.category}`);
        continue;
      }
      this.warnings.add(`llm_failed:${f.category}`);
      const reason: MissingReason = f.category === 'output_truncated' ? 'truncated' : 'provider_failure';
      return { ran: true, records: [], failure: { reason, detail: f.category } };
    }
  }

  /** Renders blocks into at most `maxChars`, shrinking until the token estimate fits. */
  private render(maxChars: number, inputTokens: number): ReturnType<typeof renderBlocks> {
    let limit = maxChars;
    let rendered = renderBlocks(this.doc, { maxChars: limit });
    // Non-ASCII pages tokenize denser than CHARS_PER_TOKEN assumes.
    for (let i = 0; i < 8 && estimateTokens(rendered.text) > inputTokens && rendered.text.length > 0; i++) {
      limit = Math.floor(Math.min(limit, rendered.text.length) * Math.max(0.5, (inputTokens / estimateTokens(rendered.text)) * 0.95));
      rendered = renderBlocks(this.doc, { maxChars: limit });
    }
    return rendered;
  }

  private async complete(
    client: ModelClient,
    budget: Budget,
    request: { system: string; user: string; maxOutputTokens: number; responseSchema?: Record<string, unknown>; temperature: number },
    purpose: 'extract' | 'repair',
    estimatedInputTokens: number,
  ): Promise<{ ok: true; text: string } | { ok: false; failure: { category: LlmErrorCategory; message: string } }> {
    try {
      const res = await client.complete(request, { purpose, budget, estimatedInputTokens });
      this.attempts.push(...res.attempts);
      return { ok: true, text: res.response.text };
    } catch (err) {
      if (err instanceof LlmCallError && err.attempts) this.attempts.push(...err.attempts);
      if (err instanceof LlmError) return { ok: false, failure: { category: err.category, message: err.message } };
      return { ok: false, failure: { category: 'unknown', message: errorName(err) } };
    }
  }

  private parse(
    text: string,
    schema: NormalizedSchema,
    source: { provider: string; model: string },
  ): { ok: true; records: ParsedRecord[] } | { ok: false; category: LlmErrorCategory; message: string } {
    try {
      const parsed = parseExtractionResponse(text, schema, source);
      for (const w of parsed.warnings) this.warnings.add(`llm_response:${w}`);
      return { ok: true, records: parsed.records };
    } catch (err) {
      if (err instanceof LlmError) return { ok: false, category: err.category, message: err.message };
      return { ok: false, category: 'parse_error', message: errorName(err) };
    }
  }

  private processRecord(record: ParsedRecord, fields: FieldSpec[], shape: EffectiveShape): Map<string, LlmSlot> {
    const out = new Map<string, LlmSlot>();
    for (const field of fields) {
      const cell: ParsedCell = hasOwn(record, field.name) ? record[field.name] : { v: null, b: null };
      out.set(field.name, this.processCell(field, cell, shape));
    }
    return out;
  }

  /** Grounding, then normalization, of one model-reported value. */
  private processCell(field: FieldSpec, cell: ParsedCell, shape: EffectiveShape): LlmSlot {
    const notFound = (): LlmSlot => ({
      value: null,
      source: 'llm',
      clean: true,
      missing: this.truncated && shape !== 'array'
        ? { reason: 'not_processed', detail: 'input was truncated; the value may be in the part not sent to the model' }
        : { reason: 'not_found' },
    });
    if (isEmptyRaw(cell.v)) return notFound();

    const ctx = cell.b ? blockContext(this.doc, cell.b) : undefined;
    const blockId = ctx ? ctx.block.id : undefined;
    const recordGroupId = ctx?.record?.recordGroupId ?? ctx?.block.recordGroupId;
    const excerpt = ctx ? excerptOf(ctx.block) : undefined;
    let grounded = false;
    let clean = true;
    let note: string | undefined;

    if (field.derived) {
      clean = false;
    } else {
      const g = checkGrounding(
        cell.v,
        { blockText: ctx?.block.text, attrs: ctx?.block.attrs, recordText: ctx?.record?.text, documentText: this.prepared },
        { derived: false },
      );
      if (!g.grounded || g.where === 'none') {
        this.rejectedCount++;
        return {
          value: null,
          source: 'llm',
          raw: cell.v,
          clean: false,
          missing: { reason: 'rejected_ungrounded', detail: cell.b ? `value not found in cited block ${cell.b} or on the page` : 'value not found on the page' },
        };
      }
      grounded = true;
      if (g.where === 'document') {
        clean = false;
        note = cell.b ? `cited ${cell.b} but the value is elsewhere on the page` : 'no block cited; value found elsewhere on the page';
      }
    }

    const norm = normalizeValue(cell.v, field, this.nctx);
    if (!norm.ok) {
      const reason: MissingReason = norm.reason === 'ambiguous' ? 'ambiguous' : 'not_found';
      return { value: null, source: 'llm', raw: cell.v, clean: false, missing: { reason, detail: `${norm.reason}: ${norm.detail}` } };
    }
    if (isEmptyRaw(norm.value)) return notFound();

    const evidence: Omit<FieldEvidence, 'path'> = {
      source: 'llm',
      raw: cell.v,
      normalization: norm.steps,
      grounded,
      ...(blockId ? { blockId } : {}),
      ...(excerpt ? { excerpt } : {}),
      ...(field.derived ? { derived: true } : {}),
    };
    if (note) evidence.note = note;
    const slot: LlmSlot = { value: norm.value, source: 'llm', raw: cell.v, clean, evidence };
    if (recordGroupId) slot.recordGroupId = recordGroupId;
    if (note) slot.citationNote = note;
    return slot;
  }

  // ── merge ────────────────────────────────────────────────

  private mergeObject(
    objectSlots: Map<string, Slot>,
    structured: Map<string, StructuredCandidate>,
    asked: FieldSpec[],
    llm: LlmStageResult,
  ): Map<string, Slot> {
    const out = new Map<string, Slot>();
    const askedNames = new Set(asked.map((f) => f.name));
    const llmRecord = llm.records[0];
    for (const field of this.schema.fields) {
      const resolved = objectSlots.get(field.name);
      if (resolved) {
        out.set(field.name, resolved);
        continue;
      }
      const fallback = structured.get(field.name);
      const fromLlm = askedNames.has(field.name) ? llmRecord?.get(field.name) : undefined;
      if (fromLlm && fromLlm.value !== null) {
        if (fallback && !fallback.verified && !valuesAgree(fallback.value, fromLlm.value)) this.warnings.add(`conflict:${field.name}`);
        out.set(field.name, fromLlm);
        continue;
      }
      if (fallback) {
        this.warnings.add(`structured_value_not_visible:${field.name}`);
        out.set(field.name, { value: fallback.value, source: 'structured-fallback', evidence: { ...fallback.evidence, grounded: false } });
        continue;
      }
      if (fromLlm) {
        out.set(field.name, fromLlm);
      } else if (llm.failure) {
        out.set(field.name, { value: null, missing: { reason: llm.failure.reason, detail: llm.failure.detail } });
      } else {
        // Asked, but the model returned no record at all.
        out.set(field.name, {
          value: null,
          missing: this.truncated
            ? { reason: 'not_processed', detail: 'input was truncated; the value may be in the part not sent to the model' }
            : { reason: 'not_found' },
        });
      }
    }
    return out;
  }

  // ── outcome ──────────────────────────────────────────────

  private finish(
    shape: 'object' | 'array',
    records: Array<Map<string, Slot>>,
    llm: LlmStageResult,
  ): ExtractionOutcome {
    const schema = this.schema;
    const base = shape === 'array' && schema.wrapperKey !== undefined ? `/${escapePointer(schema.wrapperKey)}` : '';
    const evidence: FieldEvidence[] = [];
    const missing: MissingField[] = [];
    const sources = new Set<SlotSource>();

    // Records without a single value carry nothing usable (e.g. every value rejected).
    let kept = records;
    if (shape === 'array') {
      kept = records.filter((r) => [...r.values()].some((s) => s.value !== null));
      if (kept.length < records.length) this.warnings.add(`dropped_records_without_values:${records.length - kept.length}`);
    }

    const built = kept.map((rec, i) => {
      const prefix = shape === 'array' ? `${base}/${i}` : '';
      const entries: Array<[string, unknown]> = [];
      for (const field of schema.fields) {
        const slot = rec.get(field.name) ?? { value: null, missing: { reason: 'not_found' as MissingReason } };
        const path = `${prefix}/${escapePointer(field.name)}`;
        if (slot.value !== null) {
          entries.push([field.name, slot.value]);
          if (slot.source) sources.add(slot.source);
          if (slot.evidence) evidence.push({ path, ...slot.evidence });
          if (slot.citationNote) this.warnings.add(`citation_mismatch:${path}`);
        } else {
          // Optional, non-nullable fields are left out rather than set to null (null would be schema-invalid).
          if (field.nullable || field.required) entries.push([field.name, null]);
          const m = slot.missing ?? { reason: 'not_found' as MissingReason };
          missing.push({ path, reason: m.reason, ...(m.detail ? { detail: m.detail } : {}) });
        }
      }
      return Object.fromEntries(entries);
    });

    let data: ExtractionOutcome['data'] = null;
    if (shape === 'object') {
      const record = built[0];
      if (record && Object.values(record).some((v) => v !== null)) data = record;
    } else if (built.length > 0) {
      data = schema.wrapperKey !== undefined ? Object.fromEntries([[schema.wrapperKey, built]]) : built;
    } else {
      // An empty list: the missing entry is the list itself.
      const why = llm.failure ?? (this.truncated ? { reason: 'not_processed' as MissingReason, detail: 'input was truncated' } : { reason: 'not_found' as MissingReason, detail: 'no records found' });
      missing.length = 0;
      missing.push({ path: base, reason: why.reason, ...(why.detail ? { detail: why.detail } : {}) });
    }
    if (shape === 'array' && this.truncated && data !== null) {
      // First, so capping the per-record entries below can never drop it.
      missing.unshift({
        path: base,
        reason: 'not_processed',
        detail: `input truncated: ${this.blocksSentToModel} of ${this.doc.blocks.length} blocks were sent to the model; later records were not processed`,
      });
    }

    let schemaValid = false;
    let schemaErrors: string[] | undefined;
    if (data !== null) {
      const v = validateOutput(schema, data);
      schemaValid = v.valid;
      if (!v.valid) schemaErrors = v.errors;
    }

    const status = this.status(data, schemaValid, missing, shape);
    const method = methodOf(data === null ? new Set() : sources);
    if (missing.length > MAX_MISSING_ENTRIES) {
      this.warnings.add(`missing_entries_capped:${missing.length - MAX_MISSING_ENTRIES}`);
      missing.length = MAX_MISSING_ENTRIES;
    }

    const outcome: ExtractionOutcome = {
      data: status === 'failed' ? null : data,
      status,
      method: status === 'failed' ? 'none' : method,
      schemaValid: status === 'failed' ? false : schemaValid,
      evidence: this.req.includeEvidence ? evidence : [],
      missing,
      warnings: this.warnings.list(),
      scope: this.scope(),
      llm: summarize(this.attempts),
      timings: {},
    };
    if (schemaErrors && status !== 'failed') outcome.schemaErrors = schemaErrors;
    return outcome;
  }

  private status(data: ExtractionOutcome['data'], schemaValid: boolean, missing: MissingField[], shape: 'object' | 'array'): ExtractionStatus {
    if (data === null) return 'failed';
    if (!schemaValid || this.truncated) return 'partial';
    const byName = new Map(this.schema.fields.map((f) => [f.name, f]));
    for (const m of missing) {
      if (m.reason !== 'not_found') return 'partial';
      const name = fieldOfPath(m.path, shape, this.schema.wrapperKey);
      const field = name !== undefined ? byName.get(name) : undefined;
      // Genuinely absent: the schema allows the field to be null or left out.
      if (!field || !(field.nullable || !field.required)) return 'partial';
    }
    return 'complete';
  }

  private scope(): ExtractionOutcome['scope'] {
    const doc = this.doc;
    return {
      url: this.req.url,
      snapshotHash: doc.snapshotHash,
      description: 'page-snapshot',
      blocksTotal: doc.blocks.length,
      blocksSentToModel: this.blocksSentToModel,
      recordsDetected: doc.recordGroups.reduce((max, g) => Math.max(max, g.recordIds.length), 0),
      truncated: this.truncated,
    };
  }

  private invalidSchemaOutcome(err: SchemaError): ExtractionOutcome {
    const snapshotHash = createHash('sha256').update(this.req.html).digest('hex');
    return {
      data: null,
      status: 'failed',
      method: 'none',
      schemaValid: false,
      evidence: [],
      missing: [],
      warnings: [`invalid_schema:${err.code}: ${clip(err.message, 300)}`],
      scope: { url: this.req.url, snapshotHash, description: 'page-snapshot', blocksTotal: 0, blocksSentToModel: 0, recordsDetected: 0, truncated: false },
      llm: summarize([]),
      timings: this.timingsSnapshot(),
    };
  }

  private blockedOutcome(reason: string): ExtractionOutcome {
    this.warnings.add(`source_page_blocked:${reason}`);
    const missing: MissingField[] =
      this.schema.shape === 'array'
        ? [{ path: this.schema.wrapperKey !== undefined ? `/${escapePointer(this.schema.wrapperKey)}` : '', reason: 'not_processed', detail: 'source_page_blocked' }]
        : this.schema.fields.map((f) => ({ path: `/${escapePointer(f.name)}`, reason: 'not_processed' as MissingReason, detail: 'source_page_blocked' }));
    return {
      data: null,
      status: 'failed',
      method: 'none',
      schemaValid: false,
      evidence: [],
      missing,
      warnings: this.warnings.list(),
      scope: this.scope(),
      llm: summarize([]),
      timings: this.timingsSnapshot(),
    };
  }

  // ── recipe learning ──────────────────────────────────────

  private async maybeLearn(
    outcome: ExtractionOutcome,
    llm: LlmStageResult,
    asked: FieldSpec[],
    shape: 'object' | 'array',
    key: RecipeKey | null,
    activeSeen: boolean,
  ): Promise<void> {
    const mode = this.deps.learning ?? 'background';
    const store = this.deps.recipeStore;
    if (mode === 'off' || !store || !key || activeSeen) return;
    if (this.disabled.has('recipe') || this.disabled.has('recipe-learning')) return;
    if (!llm.ran || llm.failure || llm.records.length === 0 || this.truncated || outcome.status === 'failed') return;
    const plan = this.learningPlan(llm, asked, shape);
    if (!plan) return;

    const learner = new RecipeLearner(this, store, key, plan);
    if (mode === 'await') {
      try {
        await this.timeAsync('learn', () => learner.run());
      } catch (err) {
        this.warnings.add(`recipe_learning_failed:${errorName(err)}`);
      }
      if (learner.attempts.length > 0) {
        this.attempts.push(...learner.attempts);
        outcome.llm = summarize(this.attempts);
      }
      outcome.warnings = this.warnings.list();
      return;
    }
    if (backgroundLearning.size >= MAX_BACKGROUND_LEARNING) return;
    const log = this.deps.log ?? ((m: string) => console.warn(m));
    const task: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => learner.run())
      .then(() => {
        // The answer is already out: report the proposal's spend here.
        if (learner.attempts.length > 0) {
          const cost = learner.attempts.reduce((sum, a) => sum + a.costUsd, 0);
          log(`[extract] recipe proposal used ${learner.attempts.length} model call(s), $${cost.toFixed(6)}`);
        }
      })
      .catch((err: unknown) => log(`[extract] background recipe learning failed: ${errorName(err)}`))
      .finally(() => backgroundLearning.delete(task));
    backgroundLearning.add(task);
  }

  /** What learning needs, or null when this run is not a trustworthy reference. */
  private learningPlan(llm: LlmStageResult, asked: FieldSpec[], shape: 'object' | 'array'): LearningPlan | null {
    const learnFields = asked.filter((f) => !f.derived && !isReservedFieldName(f.name));
    if (learnFields.length === 0) return null;
    const records = shape === 'object' ? llm.records.slice(0, 1) : llm.records;
    for (const rec of records) {
      for (const f of learnFields) {
        const slot = rec.get(f.name);
        if (!slot || !slot.clean) return null;
      }
    }
    const reference = records.map((rec) => Object.fromEntries(learnFields.map((f) => [f.name, rec.get(f.name)?.value ?? null])));
    const samples = records.slice(0, MAX_LEARNING_SAMPLES).map((rec) => {
      const sample: Record<string, string | null> = {};
      for (const f of learnFields) {
        const raw = rec.get(f.name)?.raw;
        Object.defineProperty(sample, f.name, {
          value: typeof raw === 'string' ? raw : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : null,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return sample;
    });
    const filled = learnFields.filter((f) => reference.every((r) => r[f.name] !== null)).map((f) => f.name);
    if (filled.length === 0) return null;
    let recordSelector: string | undefined;
    if (shape === 'array') {
      const counts = new Map<string, number>();
      for (const rec of records) {
        const groups = new Set<string>();
        for (const slot of rec.values()) if (slot.recordGroupId) groups.add(slot.recordGroupId);
        for (const g of groups) counts.set(g, (counts.get(g) ?? 0) + 1);
      }
      const best = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (best) recordSelector = this.doc.recordGroups.find((g) => g.id === best[0])?.selector;
    }
    return {
      shape,
      fields: learnFields,
      reference: shape === 'object' ? reference[0] : reference,
      samples,
      requiredFields: filled,
      recordCount: records.length,
      recordSelector,
    };
  }

  // Accessors for the learner (kept off the public surface).
  get request(): ExtractRequest {
    return this.req;
  }

  get document(): SourceDocument {
    return this.doc;
  }

  get normalizedSchema(): NormalizedSchema {
    return this.schema;
  }

  get proposeEnabled(): boolean {
    return this.deps.proposeRecipes ?? process.env.EXTRACT_RECIPE_PROPOSE === '1';
  }

  get client(): ModelClient | null {
    return this.deps.modelClient;
  }

  get spentUsd(): number {
    return this.attempts.reduce((s, a) => s + (Number.isFinite(a.costUsd) ? a.costUsd : 0), 0);
  }

  /** Runs a recipe on this snapshot for learning (own deadline: learning may run after the request's). */
  recipeData(recipe: ExtractionRecipe): { data: Record<string, unknown> | Array<Record<string, unknown>>; errors: string[] } {
    const applied = this.applyRecipe(recipe, Date.now() + INDUCTION_BUDGET_MS);
    return { data: applied.data, errors: applied.errors };
  }
}

interface LearningPlan {
  shape: 'object' | 'array';
  fields: FieldSpec[];
  /** Normalized grounded values the recipe must reproduce. */
  reference: Record<string, unknown> | Array<Record<string, unknown>>;
  /** Raw strings as the model reported them (first records). */
  samples: Array<Record<string, string | null>>;
  requiredFields: string[];
  recordCount: number;
  recordSelector?: string;
}

/**
 * Candidate lifecycle on one grounded LLM result: an existing candidate is
 * checked against it (agreement promotes, disagreement drops); otherwise a
 * recipe is induced from the raw values (or, when enabled, proposed by the
 * model) and saved as a candidate only if it reproduces this very result.
 */
class RecipeLearner {
  readonly attempts: LlmAttemptRecord[] = [];

  constructor(
    private readonly run_: ExtractionRun,
    private readonly store: RecipeStore,
    private readonly key: RecipeKey,
    private readonly plan: LearningPlan,
  ) {}

  async run(): Promise<string> {
    const { plan, store, key } = this;
    const snapshotHash = this.run_.document.snapshotHash;
    const fieldNames = plan.fields.map((f) => f.name);
    const existing = await store.get(key);
    if (existing?.state === 'active') return 'active recipe exists';
    if (existing) {
      const verdict = this.evaluate(existing.recipe, fieldNames);
      if (verdict === 'inconclusive') return 'candidate check inconclusive';
      if (verdict === 'agree') {
        await store.recordAgreement(key, snapshotHash, plan.shape === 'array' ? { recordCount: plan.recordCount } : {});
        return 'candidate agreed';
      }
      await store.recordDisagreement(key);
      return 'candidate disagreed';
    }

    const req = this.run_.request;
    const induced = induceRecipe({
      html: req.html,
      baseUrl: req.url,
      shape: plan.shape,
      ...(plan.recordSelector ? { recordSelector: plan.recordSelector } : {}),
      samples: plan.samples,
      fieldNames,
      deadlineMs: Date.now() + INDUCTION_BUDGET_MS,
    });
    let recipe = induced.recipe && this.usable(induced.recipe, fieldNames) ? induced.recipe : null;
    if (!recipe && this.run_.proposeEnabled) recipe = await this.propose(fieldNames);
    if (!recipe) return 'no recipe';
    const saved = await store.saveCandidate(key, recipe, {
      snapshotHash,
      requiredFields: plan.requiredFields.filter((f) => hasOwn(recipe.fields, f)),
      ...(plan.shape === 'array' ? { recordCount: plan.recordCount } : {}),
    });
    return saved.saved ? 'candidate saved' : `candidate not saved: ${saved.reason}`;
  }

  /** The recipe reproduces this run's grounded values (and, for listings, fills every field). */
  private usable(recipe: ExtractionRecipe, fieldNames: string[]): boolean {
    if (recipe.shape !== this.plan.shape) return false;
    if (this.plan.shape === 'array' && !this.run_.normalizedSchema.fields.every((f) => hasOwn(recipe.fields, f.name))) return false;
    return this.evaluate(recipe, fieldNames) === 'agree';
  }

  /** Inconclusive when the run itself was cut short (deadline, output budget): no verdict on the recipe. */
  private evaluate(recipe: ExtractionRecipe, fieldNames: string[]): 'agree' | 'disagree' | 'inconclusive' {
    const compared = fieldNames.filter((f) => hasOwn(recipe.fields, f));
    if (compared.length === 0) return 'disagree';
    const { data, errors } = this.run_.recipeData(recipe);
    if (errors.some((e) => /deadline|budget/i.test(e))) return 'inconclusive';
    return compareOutputs(data, this.plan.reference, compared).agree ? 'agree' : 'disagree';
  }

  private async propose(fieldNames: string[]): Promise<ExtractionRecipe | null> {
    const client = this.run_.client;
    if (!client || client.models.length === 0) return null;
    const req = this.run_.request;
    const descriptions: Record<string, string> = {};
    for (const f of this.plan.fields) {
      Object.defineProperty(descriptions, f.name, { value: f.description ?? '', enumerable: true, writable: true, configurable: true });
    }
    const prompt = buildRecipePrompt({
      html: req.html,
      fieldNames,
      fieldDescriptions: descriptions,
      shape: this.plan.shape,
      ...(this.plan.recordSelector ? { recordSelectorHint: this.plan.recordSelector } : {}),
      samples: Array.isArray(this.plan.reference) ? this.plan.reference.slice(0, 3) : [this.plan.reference],
    });
    const remaining = req.maxCostUsd === undefined ? undefined : Math.max(0, req.maxCostUsd - this.run_.spentUsd);
    const budget = new Budget({ deadlineMs: Date.now() + PROPOSAL_TIMEOUT_MS, ...(remaining !== undefined ? { maxCostUsd: remaining } : {}) });
    let text: string;
    try {
      const res = await client.complete(
        { system: prompt.system, user: prompt.user, maxOutputTokens: 2_048, responseSchema: prompt.responseSchema, temperature: 0 },
        { purpose: 'recipe', budget, estimatedInputTokens: estimateTokens(prompt.system) + estimateTokens(prompt.user) },
      );
      this.attempts.push(...res.attempts);
      text = res.response.text;
    } catch (err) {
      if (err instanceof LlmCallError && err.attempts) this.attempts.push(...err.attempts);
      return null;
    }
    let recipe: ExtractionRecipe;
    try {
      recipe = parseRecipeResponse(text, fieldNames);
    } catch {
      return null;
    }
    return this.usable(recipe, fieldNames) ? recipe : null;
  }
}

// ─────────────────────────────────────────────────────────────
// Outcome helpers
// ─────────────────────────────────────────────────────────────

/** Expected records on a listing page: the largest repeated group or table. */
function expectedRecordCount(doc: SourceDocument): number {
  let n = 1;
  for (const g of doc.recordGroups) n = Math.max(n, g.recordIds.length);
  for (const b of doc.blocks) if (b.kind === 'table' && b.table) n = Math.max(n, b.table.rows.length);
  return n;
}

function excerptOf(block: { text: string; attrs?: Record<string, string> }): string | undefined {
  if (block.text) return clip(block.text);
  if (block.attrs) {
    const attrs = Object.entries(block.attrs).map(([k, v]) => `${k}=${v}`).join(', ');
    if (attrs) return clip(attrs);
  }
  return undefined;
}

/** Field name of a missing-entry path ("/price", "/3/price", "/items/3/price"). */
function fieldOfPath(path: string, shape: 'object' | 'array', wrapperKey: string | undefined): string | undefined {
  const parts = path.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  const expected = shape === 'object' ? 1 : wrapperKey !== undefined ? 3 : 2;
  return parts.length === expected ? parts[expected - 1] : undefined;
}

function methodOf(sources: Set<SlotSource>): ExtractionMethod {
  const kinds = new Set<ExtractionMethod>();
  for (const s of sources) kinds.add(s === 'llm' ? 'llm' : s === 'recipe' ? 'recipe' : 'structured-data');
  if (kinds.size === 0) return 'none';
  if (kinds.size > 1) return 'mixed';
  return [...kinds][0];
}

function summarize(attempts: LlmAttemptRecord[]): LlmUsageSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const a of attempts) {
    inputTokens += a.inputTokens;
    outputTokens += a.outputTokens;
    costUsd += Number.isFinite(a.costUsd) ? a.costUsd : 0;
  }
  return { calls: attempts.length, inputTokens, outputTokens, costUsd, attempts: [...attempts] };
}

function errorName(err: unknown): string {
  if (err instanceof LlmError) return `${err.category}`;
  if (err instanceof Error) return err.name || 'Error';
  return typeof err;
}
