// Shared contracts for the structured-extraction engine.
//
// Every module under apps/worker/src/extract/ builds against these types.
// Keep this file free of runtime imports so any module (including Piscina
// worker threads) can import it cheaply.
//
// Design notes live in docs/engine/DESIGN.md.

// ─────────────────────────────────────────────────────────────
// Source document: a structure-preserving view of one fetched page
// ─────────────────────────────────────────────────────────────

export type BlockKind =
  | 'heading'
  | 'paragraph'
  | 'list-item'
  | 'table'
  | 'record'
  | 'field'
  | 'text';

export interface SourceBlock {
  /** Stable within one snapshot: "b0", "b1", ... in document order. */
  id: string;
  kind: BlockKind;
  /** Visible text, whitespace-collapsed. */
  text: string;
  /** Enclosing headings, outermost first (e.g. ["Laptops", "Specs"]). */
  headingPath: string[];
  /** CSS selector that uniquely re-selects this element in the raw snapshot. */
  selector: string;
  /** Char offsets of `text` inside SourceDocument.text. */
  start: number;
  end: number;
  /** Enclosing record block (product card, table row group) when any. */
  parentId?: string;
  /** Repeated-structure group this record belongs to (see RecordGroup). */
  recordGroupId?: string;
  /** Present when kind === 'table'. Header row repeated for every row. */
  table?: { caption?: string; headers: string[]; rows: string[][] };
  /**
   * Selected attributes useful as evidence: href, src, alt, title, content,
   * datetime, value, aria-label, itemprop, class, data-* (bounded length).
   */
  attrs?: Record<string, string>;
}

export type StructuredSource =
  | 'json-ld'
  | 'microdata'
  | 'opengraph'
  | 'meta'
  | 'embedded-json';

export interface StructuredDataItem {
  /** "sd0", "sd1", ... */
  id: string;
  source: StructuredSource;
  /** schema.org @type (or itemtype tail) when known, e.g. "Product". */
  type?: string;
  /** Parsed data. Never produced by executing page scripts. */
  data: unknown;
}

export interface RecordGroup {
  /** "g0", "g1", ... */
  id: string;
  /** CSS selector matching every record element of this group. */
  selector: string;
  /** Block ids of kind 'record', in document order. */
  recordIds: string[];
  /** Hash of the record's internal structure (tag/class skeleton). */
  signature: string;
}

export interface SourceDocument {
  url: string;
  /** sha256 hex of the raw HTML snapshot. */
  snapshotHash: string;
  title?: string;
  /** All block texts joined with "\n"; block offsets index into this. */
  text: string;
  blocks: SourceBlock[];
  structured: StructuredDataItem[];
  recordGroups: RecordGroup[];
  /** Host-independent hash of the page template (coarse DOM skeleton + URL path shape). */
  templateSignature: string;
  stats: { rawBytes: number; blockCount: number; textChars: number; buildMs: number };
}

// ─────────────────────────────────────────────────────────────
// Customer schema, normalized
// ─────────────────────────────────────────────────────────────

export type JsonSchema = Record<string, unknown>;

export type FieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object'
  | 'unknown';

export interface FieldSpec {
  /** Property name in the record object. */
  name: string;
  type: FieldType;
  /** For type 'array': the item type. */
  itemType?: FieldType;
  description?: string;
  required: boolean;
  nullable: boolean;
  /** Declared derived/inferential field (x-derived: true). Exempt from verbatim grounding. */
  derived: boolean;
  /** JSON Schema for this property (as supplied, after shorthand expansion). */
  schema: JsonSchema;
}

export type RequestedShape = 'object' | 'array' | 'auto';

export interface NormalizedSchema {
  /** The full schema the final output is validated against. */
  jsonSchema: JsonSchema;
  /**
   * 'array'  → output is an array of records.
   * 'object' → output is one record.
   * 'auto'   → legacy behaviour: engine picks array for listing pages.
   */
  shape: RequestedShape;
  /**
   * When the customer wrapped the array in an object (e.g. {items: [...]})
   * this is the wrapper property name; output keeps that wrapper.
   */
  wrapperKey?: string;
  /** Object schema for one record. */
  recordSchema: JsonSchema;
  fields: FieldSpec[];
  /** sha256 of canonical JSON of the original schema (first 16 hex). */
  hash: string;
  /** True when the input was shorthand ({title: "string — desc"}). */
  fromShorthand: boolean;
}

// ─────────────────────────────────────────────────────────────
// Extraction outcome (what the engine returns)
// ─────────────────────────────────────────────────────────────

export type EvidenceSource = 'structured-data' | 'recipe' | 'dom' | 'llm';

export interface FieldEvidence {
  /** JSON pointer into the returned data, e.g. "/price" or "/3/price". */
  path: string;
  source: EvidenceSource;
  blockId?: string;
  structuredId?: string;
  /** ≤ 200 chars of supporting source text. */
  excerpt?: string;
  /** Raw value as found in the source before normalization. */
  raw?: unknown;
  /** Normalization steps applied in code, e.g. ["strip-currency", "parse-number"]. */
  normalization?: string[];
  /** Raw value verified present in the cited source location. */
  grounded: boolean;
  /** Value is an inference (summary, sentiment), not a verbatim fact. */
  derived?: boolean;
  /** Why the evidence is weaker than it looks (e.g. the value was found outside the cited block). */
  note?: string;
}

export type MissingReason =
  | 'not_found'
  | 'not_processed'
  | 'ambiguous'
  | 'provider_failure'
  | 'truncated'
  | 'rejected_ungrounded';

export interface MissingField {
  path: string;
  reason: MissingReason;
  detail?: string;
}

export type ExtractionStatus = 'complete' | 'partial' | 'failed';

export type ExtractionMethod =
  | 'structured-data'
  | 'recipe'
  | 'llm'
  | 'mixed'
  | 'none';

export interface LlmAttemptRecord {
  provider: string;
  model: string;
  /** Resolved upstream model/provider when the router reports one. */
  resolvedModel?: string;
  resolvedProvider?: string;
  purpose: 'extract' | 'recipe' | 'repair';
  ok: boolean;
  errorCategory?: LlmErrorCategory;
  finishReason?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  /** Approximate input token estimate made before the call. */
  estimatedInputTokens?: number;
}

export interface LlmUsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  attempts: LlmAttemptRecord[];
}

export interface ExtractionOutcome {
  /** Customer data only. Shape follows NormalizedSchema. null when nothing usable. */
  data: Record<string, unknown> | Array<Record<string, unknown>> | null;
  status: ExtractionStatus;
  method: ExtractionMethod;
  /** Output validated against the customer's JSON Schema (Ajv). */
  schemaValid: boolean;
  schemaErrors?: string[];
  evidence: FieldEvidence[];
  missing: MissingField[];
  warnings: string[];
  scope: {
    url: string;
    snapshotHash: string;
    /** What "complete" refers to. Always the supplied page snapshot for now. */
    description: 'page-snapshot';
    blocksTotal: number;
    blocksSentToModel: number;
    recordsDetected: number;
    truncated: boolean;
  };
  llm: LlmUsageSummary;
  /** Stage → milliseconds, e.g. { document: 12, structured: 1, llm: 2400, validate: 3 }. */
  timings: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────
// LLM layer
// ─────────────────────────────────────────────────────────────

export type LlmErrorCategory =
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'overloaded'
  | 'unsupported_request'
  | 'input_too_large'
  | 'output_truncated'
  | 'empty_output'
  | 'parse_error'
  | 'content_filter'
  | 'network'
  | 'timeout'
  | 'budget_exhausted'
  | 'unknown';

export type JsonMode = 'none' | 'json_object' | 'json_schema';

export interface ModelCapabilities {
  /** Registry key, e.g. "openrouter:google/gemini-2.5-flash". */
  key: string;
  provider: 'openrouter' | 'groq' | 'gemini' | 'openai' | 'fake';
  /** Model id as the provider expects it. */
  model: string;
  contextTokens: number;
  maxOutputTokens: number;
  jsonMode: JsonMode;
  /** json_schema mode is enforced strictly (true) or best-effort (false). */
  strictSchema: boolean;
  /** USD per million tokens; used only when the provider does not report cost. */
  inputCostPerMTok?: number;
  outputCostPerMTok?: number;
}

export interface LlmRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  /** JSON Schema for the RESPONSE envelope (not the customer schema). */
  responseSchema?: JsonSchema;
  temperature?: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  finishReason: 'stop' | 'length' | 'content_filter' | 'other';
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  resolvedModel?: string;
  resolvedProvider?: string;
  latencyMs: number;
}

export interface LlmProvider {
  readonly name: ModelCapabilities['provider'];
  complete(model: ModelCapabilities, req: LlmRequest): Promise<LlmResponse>;
}

/** Thrown by providers and the model client. Never contains API keys. */
export class LlmError extends Error {
  constructor(
    message: string,
    public readonly category: LlmErrorCategory,
    public readonly provider: string,
    public readonly model: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

// ─────────────────────────────────────────────────────────────
// Declarative extraction recipes (replace generated JavaScript)
// ─────────────────────────────────────────────────────────────

export type RecipeTransform =
  | 'trim'
  | 'collapse-whitespace'
  | 'lowercase'
  | 'uppercase'
  | 'strip-currency'
  | 'parse-number'
  | 'parse-integer'
  | 'parse-boolean'
  | 'absolute-url'
  | { regex: string; group?: number }
  | { map: Record<string, string | number | boolean | null> };

export interface RecipeField {
  /** CSS selector relative to the record (array) or scope (object). "" = the element itself. */
  selector?: string;
  /** Read this attribute instead of text content. */
  attr?: string;
  /** Read from structured data instead of the DOM. */
  structured?: { type?: string; pointer: string };
  /** Collect all matches as an array instead of the first. */
  all?: boolean;
  transforms?: RecipeTransform[];
}

export interface ExtractionRecipe {
  version: 1;
  shape: 'object' | 'array';
  /** Required for shape 'array': CSS selector of each record element. */
  recordSelector?: string;
  /** Optional for shape 'object': container that scopes field selectors. */
  scopeSelector?: string;
  fields: Record<string, RecipeField>;
}

export type RecipeState = 'candidate' | 'active';

export interface StoredRecipe {
  recipe: ExtractionRecipe;
  state: RecipeState;
  createdAt: string;
  /** Distinct snapshot hashes on which the recipe agreed with grounded results. */
  validatedOn: string[];
  uses: number;
  failures: number;
  /** Fields the recipe must fill for its output to be accepted. */
  requiredFields: string[];
  /** Expected record count range seen during validation (array shape). */
  recordCount?: { min: number; max: number };
}

export interface RecipeKey {
  tenantId: string;
  host: string;
  templateSignature: string;
  schemaHash: string;
}

// ─────────────────────────────────────────────────────────────
// Engine entry point
// ─────────────────────────────────────────────────────────────

export interface ExtractRequest {
  html: string;
  url: string;
  /** Customer schema: JSON Schema or shorthand ({field: "type — description"}). */
  schema: Record<string, unknown>;
  /** Tenant scope for caches/recipes (userId). */
  tenantId: string;
  /** Absolute deadline (epoch ms) for the whole extraction. */
  deadlineMs: number;
  /** Max LLM spend for this request, USD. */
  maxCostUsd?: number;
  /** Include per-field evidence in the outcome (always computed internally). */
  includeEvidence?: boolean;
  /** Skip stages (testing / diagnostics). */
  disable?: Array<'structured' | 'recipe' | 'llm' | 'recipe-learning'>;
}
