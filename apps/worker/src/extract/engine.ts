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
import { blockContext, buildSourceDocument, documentBuildInfo, HTML_REWRITTEN_WARNING, renderBlocks, selectBlocks, type BlockContext } from './document/index.js';
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
  isEmptyValue,
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
  type ModelCapabilities,
  type NormalizedSchema,
  type RecipeKey,
  type RecordGroup,
  type SourceDocument,
  type StoredRecipe,
} from './types.js';
import { checkGrounding, isUrlField, normalizeValue, numberKey, prepareText, validateOutput, type GroundingResult, type NormalizeContext, type PreparedText } from './validate/index.js';

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
/**
 * max_tokens is this many times the planned answer size. Only actual output
 * is billed, and models differ in JSON spacing: Claude Haiku 5.5 needed ~65
 * tokens per cell on a 20-card listing where 40 were planned, so an exact
 * reservation truncated a complete answer. The plan itself (record caps,
 * input sizing) still uses OUTPUT_TOKENS_PER_CELL.
 */
const OUTPUT_HEADROOM = 2;
/** matchByMeaning bounds: candidate length, attribute sets, class tokens per value. */
const MEANING_MAX_CHARS = 200;
const MEANING_MAX_ATTR_SETS = 24;
const MEANING_MAX_TOKENS = 12;
/** Attributes whose values are addresses, never a printed fact. */
const MEANING_SKIP_ATTRS = new Set(['href', 'src', 'srcset', 'data-src', 'data-srcset', 'action', 'poster', 'cite', 'data-href', 'data-url']);
/** Sentences/lines of a long block tried by matchByMeaning. */
const MEANING_MAX_PIECES = 24;
/** Cells of one answer that must cite the same record before it counts as the answer's record. */
const HOME_RECORD_MIN_VOTES = 2;
/** Output-bound listings: answer JSON is assumed this much larger than its bare content (spacing, escapes). */
const OUTPUT_FORMAT_FACTOR = 1.2;
/** Records whose text is sampled to estimate a listing record's answer size. */
const OUTPUT_SIZE_SAMPLE = 50;
/** Share of the input budget a selection or chunk plans to fill (rendering estimates are rough). */
const SELECTION_FILL = 0.9;
/** Listings with fewer records than this are never partitioned. */
const MIN_PARTITION_RECORDS = 2;
/** Upper bound on chunk calls for one listing; the rest is reported not processed. */
const MAX_CHUNKS = 64;
/** A chunk whose answer is cut off is halved at most this many times. */
const MAX_CHUNK_SPLITS = 3;
/** Output tokens one chunk's answer is planned to stay under (time to generate, not just the model limit). */
const CHUNK_OUTPUT_TOKENS = 8_192;
/** A chunk failing like this is too big: halve it and retry. */
const SPLIT_CATEGORIES: ReadonlySet<LlmErrorCategory> = new Set(['output_truncated', 'input_too_large', 'timeout']);
/** Chunk calls in flight at once (EXTRACT_PARTITION_CONCURRENCY overrides). */
const DEFAULT_PARTITION_CONCURRENCY = 4;
/** Unprocessed record ranges named in the list-level missing detail. */
const MAX_REPORTED_GAPS = 5;
/** A retry after truncated output keeps this share of the records sent. */
const TRUNCATION_RETRY_SHARE = 0.6;
/** Characters per token assumed for rendered blocks when converting a token budget to maxChars. */
const CHARS_PER_TOKEN = 3.2;
/** Missing entries reported at most; the rest are summarized in a warning. */
const MAX_MISSING_ENTRIES = 1_000;
/** Per warning kind (text before the first ':'), at most this many distinct entries. */
const MAX_WARNINGS_PER_KIND = 20;
const MAX_EXCERPT_CHARS = 200;
const MAX_REASON_CHARS = 100;
/** Structured records whose longest value is looked up in the page's record groups. */
const LIST_COVERAGE_SAMPLE = 20;
/** Cards a structured listing may lack against the page's record group (promo slots): this share of the group. */
const LIST_COVERAGE_TOLERANCE = 0.1;
/**
 * Raw samples handed to induction (the first records of a listing; induction
 * uses at most 20). Whatever it induces is then verified against every
 * grounded record, not only these.
 */
const MAX_LEARNING_SAMPLES = 20;
/** Background learning runs in flight at once per process; more are skipped. */
const MAX_BACKGROUND_LEARNING = 4;
/** Wall-clock bound for induction (CPU on the event loop). */
const INDUCTION_BUDGET_MS = 2_000;
/**
 * Least time an active recipe gets to run, even past the request deadline:
 * it is local and fast, and a late answer from it beats no answer.
 */
const RECIPE_SERVE_MIN_MS = 1_000;
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

// What models write instead of null when they find nothing. Only taken as
// "not found" when the text is not printed in the cited block or record.
const PLACEHOLDER_ANSWER =
  /^(?:n\/?a|n\.a\.?|none|null|nil|undefined|unknown|missing|empty|-+|—|–|not (?:found|available|applicable|specified|provided|mentioned|listed|stated|given|present|shown)|no (?:data|information|info|value)(?: (?:available|found|provided))?)$/;

function isPlaceholderAnswer(v: unknown): boolean {
  if (typeof v !== 'string' || v.length > 40) return false;
  return PLACEHOLDER_ANSWER.test(v.trim().toLowerCase().replace(/[.!]+$/, ''));
}

const MAX_TABLE_ROWS = 2_000;

function looseText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function alnum(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Cells of the one table row (rendered "a | b | c") that has a cell equal to
 * one of the answer's own values, narrowed to the field's column when one
 * header names it ("5G" for has5g, "Battery (mAh)" for batteryMah). Null
 * when no single row is named.
 */
function tableCells(text: string, keys: readonly string[], field: FieldSpec): string[] | null {
  const wanted = new Set(keys.map(looseText).filter((k) => k.length >= 2));
  if (wanted.size === 0) return null;
  const rows = text
    .split('\n')
    .slice(0, MAX_TABLE_ROWS)
    .filter((line) => line.includes(' | '))
    .map((line) => line.split(' | ').map((c) => c.trim()));
  if (rows.length < 2) return null;
  const hits = rows.slice(1).filter((cells) => cells.some((c) => wanted.has(looseText(c))));
  if (hits.length !== 1) return null;
  const [row] = hits;
  const header = rows[0];
  if (header.length === row.length) {
    const col = fieldColumn(header, field);
    if (col >= 0) return [row[col]];
  }
  return row;
}

/** Index of the one header that names the field (longest match wins), or -1. */
function fieldColumn(header: readonly string[], field: FieldSpec): number {
  const name = alnum(field.name);
  let best = -1;
  let bestLen = 0;
  let tie = false;
  header.forEach((h, i) => {
    // "Battery (mAh)" → "battery", "Price*" → "price".
    const key = alnum(h.replace(/\([^)]*\)|\[[^\]]*\]/g, ''));
    if (key.length < 2 || !(name.includes(key) || key.includes(name))) return;
    if (key.length > bestLen) [best, bestLen, tie] = [i, key.length, false];
    else if (key.length === bestLen) tie = true;
  });
  return tie ? -1 : best;
}

/** A number with at least three significant digits ("512", "47.82"), so finding it somewhere on the page means something. */
function isDistinctiveNumber(text: string): boolean {
  return (text.match(/\d/g) ?? []).join('').replace(/^0+/, '').length >= 3;
}

/** A block's text, then its sentences and lines (bounded) when it has several. */
function textPieces(text: string): string[] {
  const pieces = text
    .slice(0, MEANING_MAX_CHARS * MEANING_MAX_PIECES)
    .split(/\n|(?<=[.!?])\s+|\s[·|•]\s|;\s/)
    .filter((p) => p.trim() !== '')
    .slice(0, MEANING_MAX_PIECES);
  return pieces.length > 1 ? [text, ...pieces] : [text];
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function ownField(record: unknown, key: string): unknown {
  return typeof record === 'object' && record !== null && hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined;
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

interface ModelCall {
  client: ModelClient;
  budget: Budget;
  reduced: NormalizedSchema;
  fields: FieldSpec[];
  shape: EffectiveShape;
  shapeHint: 'object' | 'array' | 'auto';
  primary: ModelCapabilities;
  parseSource: { provider: string; model: string };
}

interface PartitionPlan {
  group: RecordGroup;
  perChunk: number;
}

/** Records [from, to) of the partitioned group; depth = times it was halved. */
interface Chunk {
  from: number;
  to: number;
  depth: number;
}

interface ChunkEntry {
  from: number;
  to: number;
  status: 'done' | 'failed' | 'skipped';
  reason?: string;
  returned?: number;
}

interface LlmStageResult {
  ran: boolean;
  /** Parsed records (array/auto) or [one record] (object); empty when the call failed. */
  records: Array<Map<string, LlmSlot>>;
  /** Records the model returned (an object keeps only the first). */
  parsedCount?: number;
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
  /** Records of a listing known to exist but not returned (list-level missing entry). */
  private listGap?: { reason: MissingReason; detail: string };
  /** Only the blocks most relevant to the fields were sent (a page larger than one call). */
  private selectedInput = false;
  /** Some chunks of a partitioned listing were not processed. */
  private coverageGap = false;
  /** A field asked of a selected input was not found (it may be in what was not sent). */
  private selectionIncomplete = false;
  /** How the page reached the model, for scope. */
  private strategy?: 'single' | 'selected' | 'partitioned';
  /** Partitioned extraction summary, for scope. */
  private partition?: { chunks: number; done: number; failed: number; skipped: number; recordsPerChunk: number };
  /** The structured list returned was cut by the mapper's record cap. */
  private structuredTruncated = false;
  /** Values returned from structured data that the model should have verified but could not. */
  private unverifiedFallbacks = 0;

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
          return {
            shape: result.shape,
            primary: result.primary,
            capped: result.warnings.some((w) => w.startsWith('structured_records_capped:')),
            records: result.records.map((r) => this.structuredRecord(r)),
          };
        });
    const structured = new Map<string, StructuredCandidate>();
    const structuredShape = mapped?.shape ?? null;
    const structuredRecords = mapped?.records ?? [];

    // Effective shape: the structured mapper already decided object vs list
    // for 'auto' ("a list only when the page clearly lists ≥ 2 items").
    let shape: EffectiveShape = schema.shape;
    const objectSlots = new Map<string, Slot>();
    let arrayRecords: Array<Map<string, Slot>> | null = null;
    let structuredListFallback: { records: Array<Map<string, Slot>>; detail: string } | null = null;

    if (structuredShape === 'object' && structuredRecords.length > 0 && schema.shape !== 'array') {
      for (const [name, c] of structuredRecords[0]) structured.set(name, c);
      // Only a content entity of the kind the fields ask for (the product of
      // a product page) settles 'auto' as one object; page metadata may sit
      // on a listing page too, so the model decides there.
      const primary = mapped?.primary;
      const decidesObject = primary !== undefined && primary.content && primary.fits;
      if (schema.shape === 'auto' && decidesObject && [...structured.values()].some((c) => c.verified)) shape = 'object';
    } else if (structuredShape === 'array' && schema.shape !== 'object' && this.structuredArrayComplete(structuredRecords)) {
      shape = 'array';
      const asSlots = structuredRecords.map((rec) => {
        const out = new Map<string, Slot>();
        for (const [name, c] of rec) out.set(name, { value: c.value, source: 'structured', evidence: c.evidence });
        return out;
      });
      const shortfall = this.structuredListShortfall(structuredRecords);
      if (shortfall) {
        // A featured-items or SEO-capped ItemList: the page shows more records.
        // The model reads the page; these records are only the fallback.
        this.warnings.add(`structured_list_incomplete:${shortfall.listed}_of_${shortfall.onPage}`);
        structuredListFallback = {
          records: asSlots,
          detail: `structured data lists ${shortfall.listed} of the ${shortfall.onPage} records on the page; the others were not extracted`,
        };
      } else {
        arrayRecords = asSlots;
        if (mapped?.capped) {
          this.structuredTruncated = true;
          this.listGap = { reason: 'not_processed', detail: 'structured data lists more records than are returned; later records were not processed' };
        }
      }
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
    } else if (structuredListFallback && llm.records.length <= 1 && (llm.failure || !llm.ran)) {
      // The model could not read the page: the partial structured list, reported as such.
      finalShape = 'array';
      records = structuredListFallback.records;
      this.listGap = { reason: llm.failure?.reason ?? 'not_processed', detail: structuredListFallback.detail };
    } else if (shape === 'array' || (shape === 'auto' && llm.records.length > 1)) {
      finalShape = 'array';
      records = llm.records;
    } else {
      finalShape = 'object';
      records = [this.mergeObject(objectSlots, structured, asked, llm)];
    }

    if (this.rejectedCount > 0) this.warnings.add(`ungrounded_values_rejected:${this.rejectedCount}`);
    if (schema.shape === 'object') {
      // An explicit object schema returns one record even on a listing page
      // (an array would violate it); say when the page clearly has more.
      const n = this.recordsMatchingObjectSchema(llm, mapped?.primary?.listSize);
      if (n > 1) this.warnings.add(`multiple_records_for_object_schema:${n}`);
    }
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

  /**
   * Does the page show clearly more records than the structured list holds?
   * The record group that holds the structured records (most of their
   * longest text values occur in its records) is compared with the list's
   * length. A list whose records are in no group is not judged.
   */
  private structuredListShortfall(records: Array<Map<string, StructuredCandidate>>): { listed: number; onPage: number } | null {
    const listed = records.length;
    const larger = this.doc.recordGroups.filter((g) => g.recordIds.length - listed > Math.max(0, Math.floor(g.recordIds.length * LIST_COVERAGE_TOLERANCE)));
    if (larger.length === 0) return null;
    const keys: string[] = [];
    for (const rec of records.slice(0, LIST_COVERAGE_SAMPLE)) {
      let key = '';
      for (const c of rec.values()) {
        const raw = c.evidence.raw;
        if (typeof raw === 'string') {
          const t = raw.replace(/\s+/g, ' ').trim().toLowerCase();
          if (t.length > key.length) key = t;
        }
      }
      if (key.length >= 3) keys.push(key);
    }
    if (keys.length === 0) return null;
    const blocks = new Map(this.doc.blocks.map((b) => [b.id, b]));
    let onPage = 0;
    for (const g of larger) {
      const text = g.recordIds.map((id) => blocks.get(id)?.text ?? '').join('\n').replace(/\s+/g, ' ').toLowerCase();
      const found = keys.filter((k) => text.includes(k)).length;
      if (found * 2 > keys.length) onPage = Math.max(onPage, g.recordIds.length);
    }
    return onPage > 0 ? { listed, onPage } : null;
  }

  /**
   * How many records like the one returned for an object schema the page
   * holds: the model's own record count, the record group its values were
   * read from, or the structured list the record is a member of.
   */
  private recordsMatchingObjectSchema(llm: LlmStageResult, structuredListSize: number | undefined): number {
    let n = Math.max(llm.parsedCount ?? 0, structuredListSize ?? 0);
    const groups = new Set<string>();
    for (const slot of llm.records[0]?.values() ?? []) if (slot.value !== null && slot.recordGroupId) groups.add(slot.recordGroupId);
    for (const g of this.doc.recordGroups) if (groups.has(g.id)) n = Math.max(n, g.recordIds.length);
    return n;
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
    // A flattened snapshot (adversarial nesting) has selectors that do not
    // match the raw HTML recipes run against: neither serve nor learn.
    if (documentBuildInfo(this.doc).warnings.some((w) => w.startsWith(HTML_REWRITTEN_WARNING))) return null;
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
          const missing: Slot['missing'] = norm.ok
            ? { reason: 'not_found', detail: 'recipe found no value' }
            : { reason: norm.reason === 'ambiguous' ? 'ambiguous' : 'unparseable', detail: `recipe value: ${norm.detail}` };
          slots.set(field.name, { value: null, source: 'recipe', missing });
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

    const applied = this.applyRecipe(recipe, Math.max(this.req.deadlineMs, Date.now() + RECIPE_SERVE_MIN_MS));
    if (applied.errors.some((e) => /deadline|budget/i.test(e))) {
      // Cut short by time or a work budget: says nothing about drift, so no recordUse.
      this.warnings.add('recipe_inconclusive:deadline_or_budget');
      return { activeSeen: true };
    }
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
    const outputTokens = this.plannedOutputTokens(primary, expected, fields.length);
    const frame = buildExtractionPrompt({ schema: reduced, renderedBlocks: '', url: this.req.url, title: this.doc.title, shapeHint });
    const schemaText = frame.user + (primary.jsonMode === 'json_schema' ? JSON.stringify(frame.responseSchema) : '');
    const inputTokens = planInputBudget(primary, { systemText: frame.system, schemaText, reservedOutputTokens: outputTokens });
    if (inputTokens <= 0) {
      this.warnings.add('llm_failed:input_too_large');
      return { ran: false, records: [], failure: { reason: 'provider_failure', detail: 'input_too_large: the prompt frame does not fit the model context' } };
    }
    const call: ModelCall = {
      client,
      budget: new Budget({ deadlineMs: this.req.deadlineMs, maxCostUsd: this.req.maxCostUsd }),
      reduced,
      fields,
      shape,
      shapeHint,
      primary,
      parseSource: { provider: primary.provider, model: primary.model },
    };
    const maxChars = Math.floor(inputTokens * CHARS_PER_TOKEN);

    if (shape === 'array' && !this.disabled.has('partition')) {
      const plan = this.partitionPlan(fields, outputTokens, maxChars, inputTokens);
      if (plan) return this.runPartitioned(call, plan, maxChars);
    }
    return this.runSingle(call, outputTokens, maxChars, inputTokens);
  }

  /** max_tokens for an answer of `records` × `fieldCount` cells, with headroom, within the model limit. */
  private plannedOutputTokens(primary: ModelCapabilities, records: number, fieldCount: number): number {
    const planned = Math.max(MIN_OUTPUT_TOKENS, records * fieldCount * OUTPUT_TOKENS_PER_CELL);
    return Math.max(1, Math.min(primary.maxOutputTokens, Math.ceil(planned * OUTPUT_HEADROOM)));
  }

  /** One model call for the whole (or the selected part of the) page, as in Phase 1. */
  private async runSingle(call: ModelCall, outputTokens: number, initialMaxChars: number, inputTokens: number): Promise<LlmStageResult> {
    const { fields, shape } = call;
    let maxChars = initialMaxChars;
    // A listing whose answer cannot fit the output limit is cut to the
    // records it can hold: a truncated partial, not a failed oversized call.
    let recordCap = shape === 'object' ? null : this.outputRecordCap(fields, outputTokens);
    if (recordCap) this.warnings.add(`output_limit_records:${recordCap.count}_of_${recordCap.group.recordIds.length}`);
    let retriedSmaller = false;
    for (;;) {
      let rendered = this.render(maxChars, inputTokens, recordCap ?? undefined);
      // A single answer on a page that does not fit: send the blocks most
      // relevant to the fields instead of the first ones.
      if (rendered.truncated && !recordCap && shape === 'object' && !this.disabled.has('select')) {
        const selection = selectBlocks(this.doc, fields, Math.floor(maxChars * SELECTION_FILL));
        rendered = this.render(maxChars, inputTokens, undefined, selection.blockIds);
        this.selectedInput = true;
        this.warnings.add(`input_selected:${rendered.includedIds.length}_of_${this.doc.blocks.length}_blocks`);
      } else if (rendered.truncated) {
        this.truncated = true;
        this.warnings.add('input_truncated');
      }
      this.blocksSentToModel = rendered.includedIds.length;
      this.strategy = this.selectedInput ? 'selected' : 'single';
      const result = await this.callAndParse(call, rendered.text, outputTokens);
      if ('records' in result) {
        // An object needs one record; extra ones are not checked (or counted as rejections).
        const used = shape === 'object' ? result.records.slice(0, 1) : result.records;
        return { ran: true, records: used.map((r) => this.processRecord(r, fields, shape)), parsedCount: result.records.length };
      }
      const f = result.failure;
      if ((f.category === 'output_truncated' || f.category === 'input_too_large') && !retriedSmaller && maxChars > 1) {
        retriedSmaller = true;
        const sent = recordCap ? recordCap.count : this.recordsSent(rendered.includedIds);
        const group = recordCap?.group ?? largestRecordGroup(this.doc);
        if (f.category === 'output_truncated' && group && sent > 1) {
          recordCap = { group, count: Math.max(1, Math.floor(sent * TRUNCATION_RETRY_SHARE)) };
        } else {
          maxChars = Math.floor(Math.min(maxChars, rendered.text.length) / 2);
        }
        this.truncated = true;
        this.warnings.add(`llm_retry_smaller_input:${f.category}`);
        continue;
      }
      this.warnings.add(`llm_failed:${f.category}`);
      const reason: MissingReason = f.category === 'output_truncated' ? 'truncated' : 'provider_failure';
      return { ran: true, records: [], failure: { reason, detail: f.category } };
    }
  }

  /** One extraction call on `renderedText`, with one repair call when the answer does not parse. */
  private async callAndParse(
    call: ModelCall,
    renderedText: string,
    outputTokens: number,
  ): Promise<{ records: ParsedRecord[] } | { failure: { category: LlmErrorCategory; message: string } }> {
    const prompt = buildExtractionPrompt({ schema: call.reduced, renderedBlocks: renderedText, url: this.req.url, title: this.doc.title, shapeHint: call.shapeHint });
    const estimatedInputTokens =
      estimateTokens(prompt.system) + estimateTokens(prompt.user) + (call.primary.jsonMode === 'json_schema' ? estimateTokens(JSON.stringify(prompt.responseSchema)) : 0);
    const first = await this.complete(call.client, call.budget, {
      system: prompt.system,
      user: prompt.user,
      maxOutputTokens: outputTokens,
      responseSchema: prompt.responseSchema,
      temperature: 0,
    }, 'extract', estimatedInputTokens);
    if (!first.ok) return { failure: first.failure };
    const parsed = this.parse(first.text, call.reduced, call.parseSource);
    if (parsed.ok) return { records: parsed.records };
    if (parsed.category !== 'parse_error') return { failure: { category: parsed.category, message: parsed.message } };
    const repair = buildRepairPrompt(first.text, parsed.message);
    const repaired = await this.complete(call.client, call.budget, { system: repair.system, user: repair.user, maxOutputTokens: outputTokens, temperature: 0 }, 'repair', estimateTokens(repair.system) + estimateTokens(repair.user));
    if (!repaired.ok) return { failure: repaired.failure };
    const again = this.parse(repaired.text, call.reduced, call.parseSource);
    return again.ok ? { records: again.records } : { failure: { category: again.category, message: again.message } };
  }

  // ── partitioned extraction (listings larger than one call) ──

  /**
   * Records per chunk when the largest record group does not fit one call
   * (its answer exceeds the output limit, or the page the input budget);
   * null when one call holds it, or there is no group to split.
   */
  private partitionPlan(fields: FieldSpec[], outputTokens: number, maxChars: number, inputTokens: number): PartitionPlan | null {
    const group = largestRecordGroup(this.doc);
    if (!group || group.recordIds.length < MIN_PARTITION_RECORDS) return null;
    const total = group.recordIds.length;
    // Chunks are sized for latency too: an answer of tens of thousands of
    // tokens takes over a minute to generate (and times out), while a few
    // chunks of ~8k run side by side.
    const outputCap = this.outputRecordCap(fields, Math.min(outputTokens, CHUNK_OUTPUT_TOKENS))?.count ?? total;
    const whole = this.render(maxChars, inputTokens);
    if (outputCap >= total && !whole.truncated) return null;
    // Input: the rendered size of a sample of records.
    const sample = group.recordIds.slice(0, OUTPUT_SIZE_SAMPLE);
    const sampleChars = renderBlocks(this.doc, { blockIds: sample }).text.length;
    const perRecordChars = Math.max(1, sampleChars / sample.length);
    const inputCap = Math.max(1, Math.floor((maxChars * SELECTION_FILL) / perRecordChars));
    const perChunk = Math.max(1, Math.min(outputCap, inputCap));
    if (perChunk >= total) return null;
    return { group, perChunk };
  }

  private async runPartitioned(call: ModelCall, plan: PartitionPlan, maxChars: number): Promise<LlmStageResult> {
    const ids = plan.group.recordIds;
    // The ceiling a chunk may use: its planned answer with headroom, never above twice the latency target.
    const outputTokens = Math.min(this.plannedOutputTokens(call.primary, plan.perChunk, call.fields.length), CHUNK_OUTPUT_TOKENS * OUTPUT_HEADROOM);
    const queue: Chunk[] = [];
    for (let from = 0; from < ids.length; from += plan.perChunk) queue.push({ from, to: Math.min(ids.length, from + plan.perChunk), depth: 0 });
    const ledger: ChunkEntry[] = [];
    if (queue.length > MAX_CHUNKS) {
      for (const c of queue.splice(MAX_CHUNKS)) ledger.push({ from: c.from, to: c.to, status: 'skipped', reason: `more than ${MAX_CHUNKS} chunks` });
    }
    const answered: Array<{ from: number; records: ParsedRecord[] }> = [];
    let sentBlocks = 0;
    const concurrency = Math.max(1, Math.min(this.partitionConcurrency(), queue.length));
    const worker = async (): Promise<void> => {
      for (let chunk = queue.shift(); chunk; chunk = queue.shift()) {
        if (!call.budget.canSpend()) {
          ledger.push({ from: chunk.from, to: chunk.to, status: 'skipped', reason: call.budget.remainingMs() <= 0 ? 'deadline' : 'cost_cap' });
          continue;
        }
        const rendered = renderBlocks(this.doc, { blockIds: ids.slice(chunk.from, chunk.to), maxChars });
        const tooBig = rendered.truncated || estimateTokens(rendered.text) > maxChars / CHARS_PER_TOKEN;
        const result = tooBig
          ? { failure: { category: 'input_too_large' as LlmErrorCategory, message: 'chunk does not fit the input budget' } }
          : await this.callAndParse(call, rendered.text, Math.min(outputTokens, this.plannedOutputTokens(call.primary, chunk.to - chunk.from, call.fields.length)));
        if ('records' in result) {
          sentBlocks += rendered.includedIds.length;
          answered.push({ from: chunk.from, records: result.records });
          ledger.push({ from: chunk.from, to: chunk.to, status: 'done', returned: result.records.length });
          continue;
        }
        const category = result.failure.category;
        if (SPLIT_CATEGORIES.has(category) && chunk.to - chunk.from > 1 && chunk.depth < MAX_CHUNK_SPLITS) {
          // Halve and retry both halves first.
          const mid = chunk.from + Math.ceil((chunk.to - chunk.from) / 2);
          queue.unshift({ from: chunk.from, to: mid, depth: chunk.depth + 1 }, { from: mid, to: chunk.to, depth: chunk.depth + 1 });
          this.warnings.add(`partition_chunk_split:${category}`);
          continue;
        }
        ledger.push({ from: chunk.from, to: chunk.to, status: 'failed', reason: category });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    // Merge in page order; an answer repeated for the same card is kept once.
    answered.sort((a, b) => a.from - b.from);
    ledger.sort((a, b) => a.from - b.from);
    const records: Array<Map<string, LlmSlot>> = [];
    const seen = new Set<string>();
    let parsedCount = 0;
    let duplicates = 0;
    for (const chunk of answered) {
      for (const r of chunk.records) {
        parsedCount++;
        const slots = this.processRecord(r, call.fields, call.shape);
        const key = this.recordIdentity(r, slots, call.fields);
        if (key !== undefined && seen.has(key)) {
          duplicates++;
          continue;
        }
        if (key !== undefined) seen.add(key);
        records.push(slots);
      }
    }
    if (duplicates > 0) this.warnings.add(`partition_duplicates_dropped:${duplicates}`);
    this.blocksSentToModel = sentBlocks;
    this.strategy = 'partitioned';
    const done = ledger.filter((e) => e.status === 'done');
    this.partition = {
      chunks: ledger.length,
      done: done.length,
      failed: ledger.filter((e) => e.status === 'failed').length,
      skipped: ledger.filter((e) => e.status === 'skipped').length,
      recordsPerChunk: plan.perChunk,
    };
    this.warnings.add(`partitioned:${ledger.length}_chunks_of_${plan.perChunk}`);
    const gaps = ledger.filter((e) => e.status !== 'done');
    if (gaps.length > 0) {
      const missingRecords = gaps.reduce((n, e) => n + (e.to - e.from), 0);
      const ranges = gaps.slice(0, MAX_REPORTED_GAPS).map((e) => `${e.from + 1}–${e.to} (${e.reason})`).join(', ');
      const more = gaps.length > MAX_REPORTED_GAPS ? `, and ${gaps.length - MAX_REPORTED_GAPS} more` : '';
      this.coverageGap = true;
      const allProviderFailures = gaps.every((e) => e.status === 'failed' && e.reason !== 'output_truncated' && e.reason !== 'input_too_large');
      this.listGap = {
        reason: allProviderFailures ? 'provider_failure' : 'not_processed',
        detail: `${missingRecords} of ${ids.length} records were not processed: records ${ranges}${more}`,
      };
    }
    if (done.length === 0) {
      const reason = gaps[0]?.reason ?? 'unknown';
      this.warnings.add(`llm_failed:${reason}`);
      return { ran: true, records: [], failure: { reason: reason === 'output_truncated' ? 'truncated' : 'provider_failure', detail: this.listGap?.detail ?? reason } };
    }
    return { ran: true, records, parsedCount };
  }

  private partitionConcurrency(): number {
    const fromEnv = Number(process.env.EXTRACT_PARTITION_CONCURRENCY);
    return Number.isInteger(fromEnv) && fromEnv > 0 ? Math.min(fromEnv, 16) : DEFAULT_PARTITION_CONCURRENCY;
  }

  /**
   * Key under which a parsed record counts as a repeat: the listing card it
   * cites plus its accepted values. Only an answer for the same card with
   * the same values is dropped; a card cited by mistake for another one
   * keeps its record. Undefined (never a repeat) without a cited card.
   */
  private recordIdentity(record: ParsedRecord, slots: Map<string, LlmSlot>, fields: FieldSpec[]): string | undefined {
    const home = this.homeRecord(record, fields);
    if (!home) return undefined;
    return `${home.block.id}|${JSON.stringify(fields.map((f) => slots.get(f.name)?.value ?? null))}`;
  }

  /**
   * Renders blocks into at most `maxChars`, shrinking until the token
   * estimate fits; with `recordCap`, rendering also stops before that
   * record of the group (whole units only, like the char limit).
   */
  private render(maxChars: number, inputTokens: number, recordCap?: { group: RecordGroup; count: number }, blockIds?: readonly string[]): ReturnType<typeof renderBlocks> {
    let limit = maxChars;
    const opts = blockIds ? { blockIds } : {};
    let rendered = renderBlocks(this.doc, { ...opts, maxChars: limit });
    // Non-ASCII pages tokenize denser than CHARS_PER_TOKEN assumes.
    for (let i = 0; i < 8 && estimateTokens(rendered.text) > inputTokens && rendered.text.length > 0; i++) {
      limit = Math.floor(Math.min(limit, rendered.text.length) * Math.max(0.5, (inputTokens / estimateTokens(rendered.text)) * 0.95));
      rendered = renderBlocks(this.doc, { ...opts, maxChars: limit });
    }
    if (recordCap && recordCap.count < recordCap.group.recordIds.length) {
      const marker = `[${recordCap.group.recordIds[recordCap.count]}] <record`;
      const at = rendered.text.startsWith(marker) ? 0 : rendered.text.indexOf(`\n${marker}`);
      if (at > 0) {
        const cut = renderBlocks(this.doc, { maxChars: at });
        // A record nested in a larger unit cannot be cut out; keep the char-limited rendering then.
        if (cut.includedIds.includes(recordCap.group.recordIds[0])) return { ...cut, truncated: true };
      }
    }
    return rendered;
  }

  /**
   * Records of the largest group the output limit can hold, when fewer than
   * the group has (null otherwise). Applies only when the usual reservation
   * (OUTPUT_TOKENS_PER_CELL) exceeds the limit; the answer size is then
   * estimated per record from each field's JSON framing plus the record's own
   * text (values are read from it).
   */
  private outputRecordCap(fields: FieldSpec[], outputTokens: number): { group: RecordGroup; count: number } | null {
    const group = largestRecordGroup(this.doc);
    if (!group) return null;
    const records = group.recordIds.length;
    if (records * fields.length * OUTPUT_TOKENS_PER_CELL <= outputTokens) return null;
    const blocks = new Map(this.doc.blocks.map((b) => [b.id, b]));
    const sample = group.recordIds.slice(0, OUTPUT_SIZE_SAMPLE);
    const textTokens = sample.reduce((sum, id) => sum + estimateTokens(blocks.get(id)?.text ?? ''), 0) / Math.max(1, sample.length);
    const framing = fields.reduce((sum, f) => sum + estimateTokens(`${JSON.stringify(f.name)}:{"v":"","b":"b00000"},`), 0);
    const valueTokens = Math.min(textTokens, fields.length * OUTPUT_TOKENS_PER_CELL);
    const perRecord = (framing + valueTokens) * OUTPUT_FORMAT_FACTOR;
    const count = Math.max(1, Math.floor(outputTokens / perRecord));
    return count < records ? { group, count } : null;
  }

  /** Records of the largest group among the rendered blocks. */
  private recordsSent(includedIds: string[]): number {
    const group = largestRecordGroup(this.doc);
    if (!group) return 0;
    const ids = new Set(includedIds);
    return group.recordIds.filter((id) => ids.has(id)).length;
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
    const home = shape === 'object' ? undefined : this.homeRecord(record, fields);
    // The answer's own words ("Nova X1 Pro"): they say which table row it describes.
    const keys: string[] = [];
    for (const field of fields) {
      const v = hasOwn(record, field.name) ? record[field.name].v : undefined;
      if (field.type === 'string' && typeof v === 'string' && v.length >= 2 && v.length <= MEANING_MAX_CHARS) keys.push(v);
    }
    for (const field of fields) {
      const cell: ParsedCell = hasOwn(record, field.name) ? record[field.name] : { v: null, b: null };
      out.set(field.name, this.processCell(field, cell, shape, home, keys));
    }
    return out;
  }

  /**
   * The listing record a model answer describes: the record most of its
   * cells cite (at least two, and more than any other record). A value
   * whose own citation does not check out is then looked for in that
   * record, so one miscited cell ("4 stars" citing the next card) does not
   * lose a value its own card prints.
   */
  private homeRecord(record: ParsedRecord, fields: FieldSpec[]): BlockContext | undefined {
    const votes = new Map<string, number>();
    for (const field of fields) {
      if (!hasOwn(record, field.name)) continue;
      const cell = record[field.name];
      if (!cell.b || isEmptyRaw(cell.v)) continue;
      const ctx = blockContext(this.doc, cell.b);
      const id = ctx?.record?.id ?? (ctx?.block.kind === 'record' ? ctx.block.id : undefined);
      if (id) votes.set(id, (votes.get(id) ?? 0) + 1);
    }
    let best: string | undefined;
    let bestVotes = 0;
    let tie = false;
    for (const [id, n] of votes) {
      if (n > bestVotes) [best, bestVotes, tie] = [id, n, false];
      else if (n === bestVotes) tie = true;
    }
    if (!best || bestVotes < HOME_RECORD_MIN_VOTES || tie) return undefined;
    return blockContext(this.doc, best);
  }

  /** Grounding, then normalization, of one model-reported value. */
  private processCell(field: FieldSpec, cell: ParsedCell, shape: EffectiveShape, home?: BlockContext, keys: readonly string[] = []): LlmSlot {
    const notFound = (detail?: string): LlmSlot => {
      if (!detail && shape !== 'array' && (this.truncated || this.selectedInput)) {
        if (this.selectedInput) this.selectionIncomplete = true;
        const why = this.truncated
          ? 'input was truncated; the value may be in the part not sent to the model'
          : 'only the parts of the page most relevant to the fields were sent; the value may be in the rest';
        return { value: null, source: 'llm', clean: true, missing: { reason: 'not_processed', detail: why } };
      }
      return { value: null, source: 'llm', clean: true, missing: { reason: 'not_found', ...(detail ? { detail } : {}) } };
    };
    if (isEmptyRaw(cell.v)) return notFound();

    const cited = cell.b ? blockContext(this.doc, cell.b) : undefined;
    let ctx = cited;
    let grounded = false;
    let clean = true;
    let note: string | undefined;
    let mismatch = false;

    if (field.derived) {
      clean = false;
    } else {
      let found = cited ? this.groundIn(field, cell.v, cited, keys) : null;
      // The citation did not check out (or there was none): try the record
      // the rest of this answer cites before the whole page.
      if ((!found || found.where === 'document') && home && home.block.id !== (cited?.record?.id ?? cited?.block.id)) {
        const inHome = this.groundIn(field, cell.v, home, keys);
        if (inHome && inHome.where !== 'document') {
          found = inHome;
          ctx = home;
          mismatch = true;
          note = `${cell.b ? `cited ${cell.b}` : 'no block cited'}; value found in its record ${home.block.id}${inHome.meaning ? ` (${inHome.meaning})` : ''}`;
        }
      }
      if (!found && !cited) found = this.groundIn(field, cell.v, undefined, keys);
      // In a listing, a number found only elsewhere on the page that is
      // printed on another card of the same list (and not on this one)
      // belongs to that card.
      if (found?.where === 'document' && home && (field.type === 'number' || field.type === 'integer') && this.onAnotherCard(field, cell.v, home)) found = null;
      if (!found) {
        // "N/A", "Not specified": the model's way of saying it found nothing.
        if (isPlaceholderAnswer(cell.v)) return notFound();
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
      if (found.meaning) this.warnings.add('grounded_by_meaning');
      if (!note) {
        if (found.where === 'document') {
          mismatch = true;
          note = cell.b ? `cited ${cell.b} but the value is elsewhere on the page` : 'no block cited; value found elsewhere on the page';
        } else if (found.meaning) {
          note = found.meaning;
        }
      }
      if (mismatch) clean = false;
    }

    const blockId = ctx ? ctx.block.id : undefined;
    const recordGroupId = ctx?.record?.recordGroupId ?? ctx?.block.recordGroupId;
    const excerpt = ctx ? excerptOf(ctx.block) : undefined;

    const norm = normalizeValue(cell.v, field, this.nctx);
    if (!norm.ok) {
      // On the page but not convertible ("Free" for a price): not genuinely absent.
      const reason: MissingReason = norm.reason === 'ambiguous' ? 'ambiguous' : 'unparseable';
      return { value: null, source: 'llm', raw: cell.v, clean: false, missing: { reason, detail: `${norm.reason}: ${norm.detail}` } };
    }
    if (isEmptyRaw(norm.value)) {
      // "Contact sales" for a price: the page says there is none.
      return norm.steps.includes('no-value') ? notFound(`the page states no value: ${clip(String(cell.v), 60)}`) : notFound();
    }

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
    if (mismatch && note) slot.citationNote = note;
    return slot;
  }

  /** Per record group: how many of its records print each number. */
  private readonly groupNumbers = new Map<string, Map<string, number>>();

  /** True when `raw` normalizes to a number printed on a sibling record of `home` but not on `home` itself. */
  private onAnotherCard(field: FieldSpec, raw: unknown, home: BlockContext): boolean {
    const groupId = home.block.recordGroupId;
    const group = groupId ? this.doc.recordGroups.find((g) => g.id === groupId) : undefined;
    if (!group) return false;
    const n = normalizeValue(raw, field, this.nctx);
    if (!n.ok || typeof n.value !== 'number') return false;
    let counts = this.groupNumbers.get(group.id);
    if (!counts) {
      counts = new Map();
      for (const id of group.recordIds) {
        const text = blockContext(this.doc, id)?.block.text;
        if (text) for (const key of prepareText(text).numbers()) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      this.groupNumbers.set(group.id, counts);
    }
    const key = numberKey(n.value);
    return (counts.get(key) ?? 0) > 0 && !prepareText(home.block.text).numbers().has(key);
  }

  /**
   * Where `raw` is printed relative to `ctx` (block, its attributes, its
   * record, or elsewhere on the page), or null when it is not. A number
   * whose text is not printed as written ("512 GB SSD" for a cell reading
   * "512 GB PCIe 4.0 NVMe SSD") is looked up as the number it normalizes
   * to; a number or boolean the model wrote in its own words is matched by
   * meaning against the cited block.
   */
  private groundIn(field: FieldSpec, raw: unknown, ctx: BlockContext | undefined, keys: readonly string[]): { where: string; meaning?: string } | null {
    const sources = { blockText: ctx?.block.text, attrs: ctx?.block.attrs, recordText: ctx?.record?.text, recordAttrs: ctx?.recordAttrs, documentText: this.prepared };
    const near = (r: GroundingResult): boolean => r.grounded && r.where !== 'none' && r.where !== 'document';
    const g = checkGrounding(raw, sources, { derived: false });
    if (near(g)) return { where: g.where };
    let byNumber: GroundingResult | undefined;
    if (typeof raw === 'string' && (field.type === 'number' || field.type === 'integer')) {
      const n = normalizeValue(raw, field, this.nctx);
      if (n.ok && typeof n.value === 'number' && !n.steps.some((s) => s.startsWith('convert:'))) {
        byNumber = checkGrounding(n.value, sources, { derived: false });
        if (near(byNumber)) return { where: byNumber.where };
      }
    }
    const meaning = ctx ? this.matchByMeaning(field, raw, ctx, keys) : null;
    if (meaning) return { where: 'block', meaning };
    if (g.grounded && g.where === 'document') return { where: 'document' };
    // A number found only as the number it normalizes to, somewhere on the
    // page, and with no citation to say where: only when it is distinctive
    // ("512", "47.82"; never "1" or "4").
    if (!ctx && byNumber?.grounded && byNumber.where === 'document' && typeof raw === 'string' && isDistinctiveNumber(raw)) return { where: 'document' };
    return null;
  }

  /**
   * Second chance for a number or boolean the model wrote in its own form
   * instead of copying it ("3" for a rating the page shows as class
   * "star-rating Three", "true" for "In stock", "false" for remote when the
   * block says "It is not eligible for fully remote work"). Short texts of
   * the cited block (its sentences and lines, when it is long) and its
   * record's attributes are normalized with the field's own rules; the
   * value is accepted only when one of them converts to exactly the same
   * value, and, for a yes/no field, none of them to the opposite. Strings
   * never take this path: their meaning is too loose to compare. Returns a
   * note for the evidence, or null.
   */
  private matchByMeaning(field: FieldSpec, raw: unknown, ctx: BlockContext, keys: readonly string[] = []): string | null {
    if (field.type !== 'boolean' && field.type !== 'number' && field.type !== 'integer') return null;
    const target = normalizeValue(raw, field, this.nctx);
    if (!target.ok || isEmptyRaw(target.value)) return null;
    // A whole table cited: only the row this answer names, in the field's column when the header says which.
    const row = ctx.block.kind === 'table' ? tableCells(ctx.block.text, keys, field) : null;
    const candidates: string[] = row ?? [...textPieces(ctx.block.text)];
    const attrSets = [ctx.block.attrs ?? {}, ...(ctx.recordAttrs ?? [])].slice(0, MEANING_MAX_ATTR_SETS);
    for (const attrs of attrSets) {
      for (const [name, value] of Object.entries(attrs)) {
        // Links and image paths hold digits that mean nothing ("/3f/c6/…").
        if (MEANING_SKIP_ATTRS.has(name) || /[/\\=?&#]|:\/\//.test(value)) continue;
        candidates.push(value);
        // Class lists carry one token per fact ("star-rating Three").
        if (/\s/.test(value)) candidates.push(...value.split(/\s+/).slice(0, MEANING_MAX_TOKENS));
      }
    }
    let match: string | null = null;
    for (const candidate of candidates) {
      const text = candidate.trim();
      if (text === '' || text.length > MEANING_MAX_CHARS) continue;
      const n = normalizeValue(text, field, this.nctx);
      if (!n.ok || isEmptyRaw(n.value)) continue;
      if (n.value === target.value) {
        match ??= `matched by meaning: "${text.slice(0, 60)}" in ${ctx.block.id}`;
        if (field.type !== 'boolean') return match;
      } else if (field.type === 'boolean') {
        return null; // the block says both: not a confirmation
      }
    }
    return match;
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
        if (askedNames.has(field.name) && llm.failure) {
          // The model was asked to verify it but could not run: returned unverified.
          this.warnings.add(`unverified_values:${field.name}`);
          this.unverifiedFallbacks++;
        }
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
    let droppedWithProblems: { count: number; reason: MissingReason } | undefined;
    if (shape === 'array') {
      kept = records.filter((r) => [...r.values()].some((s) => s.value !== null));
      if (kept.length < records.length) {
        this.warnings.add(`dropped_records_without_values:${records.length - kept.length}`);
        // A record the model reported but whose every value was rejected (or
        // could not be read) is a record of the page that is not returned.
        const keptSet = new Set(kept);
        for (const r of records) {
          if (keptSet.has(r)) continue;
          const reasons = [...r.values()]
            .map((s) => s.missing?.reason)
            .filter((x): x is MissingReason => x !== undefined && x !== 'not_found' && x !== 'not_processed');
          if (reasons.length === 0) continue;
          const reason = reasons.includes('rejected_ungrounded') ? 'rejected_ungrounded' : reasons[0];
          droppedWithProblems = { count: (droppedWithProblems?.count ?? 0) + 1, reason: droppedWithProblems?.reason ?? reason };
        }
      }
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
      const why =
        llm.failure ??
        (droppedWithProblems
          ? { reason: droppedWithProblems.reason, detail: `${droppedWithProblems.count} record(s) were reported but none of their values could be accepted` }
          : this.truncated
            ? { reason: 'not_processed' as MissingReason, detail: 'input was truncated' }
            : { reason: 'not_found' as MissingReason, detail: 'no records found' });
      missing.length = 0;
      missing.push({ path: base, reason: why.reason, ...(why.detail ? { detail: why.detail } : {}) });
    }
    if (shape === 'array' && droppedWithProblems && data !== null) {
      missing.unshift({
        path: base,
        reason: droppedWithProblems.reason,
        detail: `${droppedWithProblems.count} record(s) were dropped because none of their values could be accepted`,
      });
    }
    if (shape === 'array' && this.listGap && data !== null) {
      missing.unshift({ path: base, reason: this.listGap.reason, detail: this.listGap.detail });
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
    if (!schemaValid || this.truncated || this.structuredTruncated || this.unverifiedFallbacks > 0) return 'partial';
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
      truncated: this.truncated || this.structuredTruncated || this.coverageGap || this.selectionIncomplete,
      ...(this.strategy ? { strategy: this.strategy } : {}),
      ...(this.partition ? { partitions: { ...this.partition } } : {}),
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
    if (!llm.ran || llm.failure || llm.records.length === 0 || this.truncated || this.coverageGap || outcome.status === 'failed') return;
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
  /** Normalized grounded values the recipe must reproduce exactly: every record of the run. */
  reference: Record<string, unknown> | Array<Record<string, unknown>>;
  /** Raw strings as the model reported them (first records), for induction only. */
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

  /**
   * Agreement means exact agreement with every grounded reference record:
   * every compared value matches and a listing has the same number of
   * records. A single wrong value (a sale card's struck-through price) is a
   * disagreement, so the recipe is neither saved nor promoted. Inconclusive
   * when the run itself was cut short (deadline, output budget).
   */
  private evaluate(recipe: ExtractionRecipe, fieldNames: string[]): 'agree' | 'disagree' | 'inconclusive' {
    const compared = fieldNames.filter((f) => hasOwn(recipe.fields, f));
    if (compared.length === 0) return 'disagree';
    const { data, errors } = this.run_.recipeData(recipe);
    if (errors.some((e) => /deadline|budget/i.test(e))) return 'inconclusive';
    const reference = this.plan.reference;
    const exact = (a: unknown, b: unknown): boolean => {
      const r = compareOutputs(a, b, compared);
      return r.agree && r.fieldAgreement === 1;
    };
    if (!exact(data, reference)) return 'disagree';
    if (Array.isArray(reference)) {
      if (!Array.isArray(data) || data.length !== reference.length) return 'disagree';
      // Record by record as well, so no part of a long listing goes unchecked.
      for (let i = 0; i < reference.length; i++) {
        const a = data[i];
        const b = reference[i];
        if (compared.every((f) => isEmptyValue(ownField(a, f)) && isEmptyValue(ownField(b, f)))) continue;
        if (!exact(a, b)) return 'disagree';
      }
    }
    return 'agree';
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

function largestRecordGroup(doc: SourceDocument): RecordGroup | undefined {
  let best: RecordGroup | undefined;
  for (const g of doc.recordGroups) if (!best || g.recordIds.length > best.recordIds.length) best = g;
  return best;
}

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
