// === Job Types ===
export interface ScrapeJobData {
  jobId: string;
  userId: string;
  apiKeyId: string;
  url: string;
  options: ScrapeOptions;
  priority: 1 | 2 | 3 | 4;
  createdAt: string;
}

export interface ScrapeOptions {
  formats?: OutputFormat[];
  waitFor?: string;
  timeout?: number;
  proxy?: ProxyPreference;
  headers?: Record<string, string>;
  cookies?: CookieInput[];
  screenshot?: boolean;
  mobile?: boolean;
  blockResources?: boolean;
  cacheTtl?: number;
  webhookUrl?: string;
  extractSchema?: Record<string, unknown>;
  /** Return per-field evidence in metadata.extraction.evidence. */
  includeEvidence?: boolean;
  /** Spend cap for model calls of this request, USD (also capped by the worker's EXTRACT_MAX_COST_USD). */
  maxLlmCostUsd?: number;
}

export type OutputFormat = 'html' | 'markdown' | 'text' | 'screenshot' | 'json';

export type ProxyPreference = 'none' | 'datacenter' | 'residential' | 'mobile' | 'auto';

export interface CookieInput {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

// === Result Types ===
export interface ScrapeResult {
  jobId: string;
  url: string;
  status: 'completed' | 'failed';
  statusCode?: number;
  content: {
    html?: string;
    markdown?: string;
    text?: string;
    screenshot?: string;
    // Union because listing-page extractions return an array of items
    // while single-entity pages return one object. Clients using `json`
    // should check `Array.isArray(...)` before indexing into properties.
    json?: Record<string, unknown> | Array<Record<string, unknown>>;
  };
  metadata: {
    tierUsed: number;
    proxyTier: string;
    latencyMs: number;
    cached: boolean;
    qualityScore: number;
    extractionMethod?: string;
    /** Page title resolved from JSON-LD, Readability, or meta tags. */
    title?: string;
    /** Page description resolved from `meta[description]` / og / twitter. */
    description?: string;
    costBreakdown: CostBreakdown;
    /** Structured-extraction outcome; present when an extract schema was given. */
    extraction?: ExtractionMetadata;
    /** Where the time went: per-stage milliseconds and router tier attempts. */
    timings?: TimingsMetadata;
  };
  error?: string;
}

// === Structured extraction metadata ===
// Mirrors the engine's ExtractionOutcome (apps/worker/src/extract/types.ts)
// without its data and attempt log; see docs/engine/DESIGN.md.

export type ExtractionStatus = 'complete' | 'partial' | 'failed';

export type ExtractionMethod = 'structured-data' | 'recipe' | 'llm' | 'mixed' | 'none';

export type ExtractionMissingReason =
  | 'not_found'
  | 'not_processed'
  | 'ambiguous'
  | 'provider_failure'
  | 'truncated'
  | 'rejected_ungrounded'
  | 'unparseable';

export interface ExtractionMissingField {
  /** JSON pointer into content.json, e.g. "/price" or "/items/3/price". */
  path: string;
  reason: ExtractionMissingReason;
  detail?: string;
}

export interface ExtractionEvidence {
  path: string;
  source: 'structured-data' | 'recipe' | 'dom' | 'llm';
  blockId?: string;
  structuredId?: string;
  excerpt?: string;
  raw?: unknown;
  normalization?: string[];
  grounded: boolean;
  derived?: boolean;
  note?: string;
}

export interface ExtractionScope {
  url: string;
  snapshotHash: string;
  description: 'page-snapshot';
  blocksTotal: number;
  blocksSentToModel: number;
  recordsDetected: number;
  truncated: boolean;
}

export interface ExtractionLlmSummary {
  /** Model calls made, failed ones included. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Distinct models that served the calls (resolved upstream model when reported). */
  models: string[];
}

export interface ExtractionMetadata {
  status: ExtractionStatus;
  method: ExtractionMethod;
  schemaValid: boolean;
  schemaErrors?: string[];
  missing: ExtractionMissingField[];
  warnings: string[];
  scope: ExtractionScope;
  llm: ExtractionLlmSummary;
  /** Only when the request set includeEvidence. */
  evidence?: ExtractionEvidence[];
}

export interface TimingsMetadata {
  /** Stage → milliseconds (fetch, content, extract, document, structured, recipe, llm, validate, …). */
  stages: Record<string, number>;
  /** Router tier attempts in order. */
  attempts: Array<{ tier: number; ms: number; outcome: 'accepted' | 'rejected' | 'error'; reason?: string }>;
  totalMs: number;
}

export interface CostBreakdown {
  compute: number;
  proxy: number;
  captcha: number;
  llm: number;
  total: number;
}

// === Domain Strategy ===
export interface DomainStrategy {
  tier: 1 | 2 | 3 | 4;
  proxyTier: 'datacenter' | 'residential' | 'mobile';
  successRate: number;
  avgLatencyMs: number;
  sampleSize: number;
  lastUpdated: string;
}

// === Proxy Types ===
export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  protocol: 'http' | 'https' | 'socks5';
  provider: string;
  tier: 'datacenter' | 'residential' | 'mobile';
  country?: string;
}

export interface ProxyScore {
  proxyId: string;
  successes: number;
  failures: number;
  avgLatency: number;
  lastUsed: string;
  domainScores: Record<string, { successes: number; failures: number }>;
}

// === Queue Constants ===
export const QUEUE_NAMES = {
  SCRAPE_REALTIME: 'scrape-realtime',
  SCRAPE_STANDARD: 'scrape-standard',
  SCRAPE_BATCH: 'scrape-batch',
  SCRAPE_BACKGROUND: 'scrape-background',
} as const;

export const QUEUE_CONFIG = {
  [QUEUE_NAMES.SCRAPE_REALTIME]:   { priority: 1, timeout: 30_000 },
  [QUEUE_NAMES.SCRAPE_STANDARD]:   { priority: 2, timeout: 60_000 },
  [QUEUE_NAMES.SCRAPE_BATCH]:      { priority: 3, timeout: 300_000 },
  [QUEUE_NAMES.SCRAPE_BACKGROUND]: { priority: 4, timeout: 1_800_000 },
} as const;

// === API Key Format ===
export const API_KEY_PREFIX = 'sf_live_';
