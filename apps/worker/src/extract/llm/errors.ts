// Error classification for model providers.
//
// Every provider failure becomes an LlmError with a category the client can
// act on (circuit-break, back off, fall back, downgrade JSON mode, give up).
// Classification uses the HTTP status first and the body wording second,
// because providers disagree on status codes: Gemini reports a bad key as
// 400, OpenRouter reports moderation as 403 and upstream failures inside a
// 200 body, Groq reports "request larger than your per-minute budget" as 413.
//
// Messages carry the status and at most 300 characters of the body, with
// anything that looks like a credential removed. API keys never reach a
// message, a log line or an attempt record.

import { LlmError, type LlmAttemptRecord, type LlmErrorCategory, type ModelCapabilities } from '../types.js';

/**
 * Whether an auth/quota failure affects the whole provider account or one
 * model. On input_too_large, 'model' means a per-minute/per-day token
 * allowance of this model (Groq's 413), not a context window, so models of
 * other providers with the same window may still take the input.
 */
export type FailureScope = 'provider' | 'model';

export interface LlmErrorDetails {
  /** Wait the provider asked for (Retry-After), capped at MAX_RETRY_AFTER_MS. */
  retryAfterMs?: number;
  /** Uncapped wait the provider asked for; lets the client skip a pointless retry. */
  requestedRetryAfterMs?: number;
  /** For auth/quota failures. */
  scope?: FailureScope;
  /** Usage reported for a failed call (e.g. empty output still billed). */
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  resolvedModel?: string;
  resolvedProvider?: string;
  finishReason?: string;
  /**
   * output_truncated only: the answer as far as it got (at most
   * MAX_PARTIAL_TEXT_CHARS), so a caller can salvage the complete records.
   */
  partialText?: string;
  /**
   * budget_exhausted from the cost cap only: the largest estimated input
   * (tokens) that a call with the requested output limit could carry within
   * the remaining spend, on the most affordable model skipped (0: none).
   * A caller can shrink its input to this and try again.
   */
  affordableInputTokens?: number;
  /** Every attempt made by the model client, on errors thrown by the client. */
  attempts?: LlmAttemptRecord[];
}

/** Bound on LlmErrorDetails.partialText (characters). */
export const MAX_PARTIAL_TEXT_CHARS = 200 * 1024;

/**
 * LlmError with the details the model client needs. Providers and the client
 * throw this; plain LlmErrors (e.g. from tests) are handled the same way.
 */
export class LlmCallError extends LlmError {
  readonly retryAfterMs?: number;
  readonly requestedRetryAfterMs?: number;
  readonly scope?: FailureScope;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly resolvedModel?: string;
  readonly resolvedProvider?: string;
  readonly finishReason?: string;
  readonly attempts?: LlmAttemptRecord[];
  readonly affordableInputTokens?: number;
  // Non-enumerable (set in the constructor): logging the error must not dump model output.
  declare readonly partialText?: string;

  constructor(
    message: string,
    category: LlmErrorCategory,
    provider: string,
    model: string,
    status?: number,
    details: LlmErrorDetails = {},
  ) {
    super(message, category, provider, model, status);
    this.retryAfterMs = details.retryAfterMs;
    this.requestedRetryAfterMs = details.requestedRetryAfterMs;
    this.scope = details.scope;
    this.inputTokens = details.inputTokens;
    this.outputTokens = details.outputTokens;
    this.costUsd = details.costUsd;
    this.resolvedModel = details.resolvedModel;
    this.resolvedProvider = details.resolvedProvider;
    this.finishReason = details.finishReason;
    this.attempts = details.attempts;
    this.affordableInputTokens = details.affordableInputTokens;
    if (typeof details.partialText === 'string') {
      Object.defineProperty(this, 'partialText', {
        value: details.partialText.slice(0, MAX_PARTIAL_TEXT_CHARS),
        enumerable: false,
        writable: false,
        configurable: true,
      });
    }
  }
}

/** Details of any LlmError (empty for a plain LlmError). */
export function errorDetails(err: LlmError): LlmErrorDetails {
  return err instanceof LlmCallError ? err : {};
}

// ─────────────────────────────────────────────────────────────
// Classification
// ─────────────────────────────────────────────────────────────

export interface Classification {
  category: LlmErrorCategory;
  scope?: FailureScope;
}

// Also covers "user location is not supported": no model of the provider can
// serve this worker, which is exactly what an auth trip expresses.
const AUTH_WORDING =
  /invalid[\s_-]?api[\s_-]?key|api[\s_-]?key[\s_-]?(?:not[\s_-]?valid|invalid|missing|expired)|incorrect api key|unauthori[sz]ed|authentication|no auth credentials|permission[\s_-]?denied|location is not supported/i;
const MODERATION_WORDING = /flagged|moderation|content[\s_-]?(?:policy|filter|management)|usage polic/i;
const QUOTA_WORDING = /credit|quota|billing|insufficient[\s_-]?(?:funds|balance)|payment required|key limit/i;
// Quota problems that no model of this provider can work around.
const ACCOUNT_QUOTA_WORDING =
  /insufficient[\s_-]?(?:funds|balance|quota|credits?)|more credits|out of credits|credits? (?:exhausted|balance)|negative balance|payment|key limit/i;
const DAILY_WORDING = /per[\s_-]?day|daily|per[\s_-]?month|monthly|\bRPD\b|\bTPD\b/i;
const PER_MINUTE_WORDING = /per[\s_-]?min|per[\s_-]?second|\bRPM\b|\bTPM\b|\bRPS\b/i;
const RATE_LIMIT_WORDING = /rate[\s_-]?limit|too many requests|resource[\s_-]?exhausted/i;
const TOO_LARGE_WORDING =
  /context[\s_-]?length|context window|too many tokens|maximum context|request too large|prompt is too long|input is too long|exceeds? the maximum (?:number of )?(?:input )?tokens|too large for model|reduce the length/i;
// Wording that names the JSON/response-format feature itself; safe on any 4xx.
const UNSUPPORTED_FEATURE_WORDING =
  /response_format|json_schema|response_?schema|response_?mime_?type|structured output|json mode|requested parameters|invalid schema|json_validate_failed|failed to generate json/i;
// Generic wording; only trusted on a plain 400, where "schema" can only be
// our response schema (e.g. Gemini's "schema produces a constraint that has
// too many states").
const UNSUPPORTED_GENERIC_WORDING = /not supported|unsupported|does not support|\bschema\b/i;
const OVERLOADED_WORDING = /overloaded|temporarily unavailable|service unavailable|at capacity|upstream error|try again later/i;

function classify429(body: string): Classification {
  if (DAILY_WORDING.test(body)) return { category: 'quota', scope: ACCOUNT_QUOTA_WORDING.test(body) ? 'provider' : 'model' };
  if (/insufficient_quota/i.test(body)) return { category: 'quota', scope: 'provider' };
  if (PER_MINUTE_WORDING.test(body)) return { category: 'rate_limit' };
  if (QUOTA_WORDING.test(body) && !RATE_LIMIT_WORDING.test(body)) {
    return { category: 'quota', scope: ACCOUNT_QUOTA_WORDING.test(body) ? 'provider' : 'model' };
  }
  return { category: 'rate_limit' };
}

function quota(body: string, status: number): Classification {
  return { category: 'quota', scope: status === 402 || ACCOUNT_QUOTA_WORDING.test(body) ? 'provider' : 'model' };
}

function tooLarge(body: string): Classification {
  return PER_MINUTE_WORDING.test(body) || DAILY_WORDING.test(body) ? { category: 'input_too_large', scope: 'model' } : { category: 'input_too_large' };
}

// Fields in which providers echo the model's output or the request back
// (Groq's failed_generation, OpenRouter's moderation flagged_input). That
// text comes from the page, so classifying on it would let a page's wording
// ("Unauthorized", "credit") trip the breaker for every request.
const ECHO_KEYS: ReadonlySet<string> = new Set(['failed_generation', 'flagged_input']);
const MAX_ECHO_DEPTH = 8;
const MAX_NESTED_JSON_CHARS = 64 * 1024;

/**
 * Copy of a parsed error value without echoed content. JSON held in strings
 * (OpenRouter's metadata.raw carries the upstream body) is cleaned as well.
 */
export function withoutEchoes(value: unknown, depth = 0): unknown {
  if (depth > MAX_ECHO_DEPTH) return undefined;
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t.startsWith('{') || t.length > MAX_NESTED_JSON_CHARS) return value;
    try {
      return withoutEchoes(JSON.parse(t), depth + 1);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((v) => withoutEchoes(v, depth + 1));
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (ECHO_KEYS.has(k)) continue;
    Object.defineProperty(out, k, { value: withoutEchoes(v, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** The body as classification should read it: JSON bodies without echoed content. */
function classificationText(body: string): string {
  const t = body.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return body;
  try {
    return JSON.stringify(withoutEchoes(JSON.parse(t))) ?? body;
  } catch {
    return body;
  }
}

/**
 * Classifies a failed call from its HTTP status (or the code embedded in a
 * 200 body; 0 when unknown) and body text. Echoed model output in a JSON
 * body is ignored.
 */
export function classifyFailure(status: number, rawBody: string): Classification {
  const body = classificationText(rawBody);
  if (status === 401) return { category: 'auth', scope: 'provider' };
  if (status === 403) {
    if (MODERATION_WORDING.test(body)) return { category: 'content_filter' };
    if (QUOTA_WORDING.test(body)) return quota(body, status);
    return { category: 'auth', scope: 'provider' };
  }
  if (status === 402) return quota(body, status);
  if (status === 429) return classify429(body);
  if (status === 413) return tooLarge(body);
  if (status === 408 || status >= 500) return { category: 'overloaded' };

  // Other 4xx codes, errors inside 200 bodies, and unknown codes: wording.
  if (AUTH_WORDING.test(body)) return { category: 'auth', scope: 'provider' };
  if (MODERATION_WORDING.test(body)) return { category: 'content_filter' };
  if (RATE_LIMIT_WORDING.test(body)) return classify429(body);
  if (QUOTA_WORDING.test(body)) return quota(body, status);
  if (TOO_LARGE_WORDING.test(body)) return tooLarge(body);
  if (UNSUPPORTED_FEATURE_WORDING.test(body)) return { category: 'unsupported_request' };
  if (status === 400 && UNSUPPORTED_GENERIC_WORDING.test(body)) return { category: 'unsupported_request' };
  if (OVERLOADED_WORDING.test(body)) return { category: 'overloaded' };
  return { category: 'unknown' };
}

function isAbortLike(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Converts anything thrown while calling a provider into an LlmError. Aborts
 * (deadline or per-call cap) are timeouts; other fetch failures are network
 * errors. Messages are scrubbed because fetch errors can echo URLs.
 */
export function toLlmError(
  err: unknown,
  caps: Pick<ModelCapabilities, 'provider' | 'model'>,
  signal?: AbortSignal,
  secrets: readonly string[] = [],
): LlmError {
  if (err instanceof LlmError) return err;
  if (isAbortLike(err) || signal?.aborted) {
    return new LlmCallError(`${caps.provider} ${caps.model}: request timed out or was aborted`, 'timeout', caps.provider, caps.model);
  }
  const message = err instanceof Error ? describeCause(err) : String(err);
  return new LlmCallError(
    `${caps.provider} ${caps.model}: request failed: ${snippet(message, secrets)}`,
    'network',
    caps.provider,
    caps.model,
  );
}

/** "fetch failed (ECONNREFUSED)" instead of the bare "fetch failed". */
function describeCause(err: Error): string {
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return `${err.message} (${code})`;
    const msg = (cause as { message?: unknown }).message;
    if (typeof msg === 'string') return `${err.message} (${msg})`;
  }
  return err.message;
}

// ─────────────────────────────────────────────────────────────
// Retry-After
// ─────────────────────────────────────────────────────────────

export const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Requested wait in ms (uncapped) from retry-after-ms / Retry-After headers
 * (seconds or HTTP date), or Gemini's RetryInfo "retryDelay" in the body.
 */
export function parseRetryAfter(headers: Headers | undefined, body = '', now = Date.now()): number | undefined {
  const ms = headers?.get('retry-after-ms');
  if (ms && /^\s*\d+(?:\.\d+)?\s*$/.test(ms)) return Math.ceil(Number(ms));
  const value = headers?.get('retry-after')?.trim();
  if (value) {
    if (/^\d+(?:\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1000);
    // Date.parse accepts almost anything ("-3" is year -3): require an HTTP-date shape.
    if (/\b\d{4}\b/.test(value) && /\d{1,2}:\d{2}/.test(value)) {
      const date = Date.parse(value);
      if (!Number.isNaN(date)) return Math.max(0, date - now);
    }
  }
  const delay = /"retryDelay"\s*:\s*"(\d{1,6}(?:\.\d{1,9})?)s"/.exec(body.slice(0, 64 * 1024));
  if (delay) return Math.ceil(Number(delay[1]) * 1000);
  return undefined;
}

export function capRetryAfter(ms: number | undefined): number | undefined {
  return ms === undefined ? undefined : Math.min(Math.max(0, ms), MAX_RETRY_AFTER_MS);
}

// ─────────────────────────────────────────────────────────────
// Secret scrubbing
// ─────────────────────────────────────────────────────────────

export const MAX_ERROR_SNIPPET = 300;
// Scrub only the head of huge bodies; the snippet never needs more.
const MAX_SCRUB_INPUT = 16 * 1024;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-[redacted]'],
  [/\bgsk_[A-Za-z0-9]{8,}/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{16,}/g, '[redacted]'],
  [
    /\b((?:x-goog-)?api[_-]?key|key|token|access_token|secret|password|authorization)(["']?\s{0,4}[=:]\s{0,4}["']?)[^\s"'&,;}]+/gi,
    '$1$2[redacted]',
  ],
];

/** Removes anything resembling a credential, plus the exact strings in `secrets`. */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    // Short strings would redact ordinary words; real keys are long.
    if (secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Whitespace-collapsed, scrubbed, ≤ MAX_ERROR_SNIPPET chars. */
export function snippet(text: string, secrets: readonly string[] = []): string {
  const head = text.length > MAX_SCRUB_INPUT ? text.slice(0, MAX_SCRUB_INPUT) : text;
  const clean = scrubSecrets(head, secrets).replace(/\s+/g, ' ').trim();
  return clean.length > MAX_ERROR_SNIPPET ? `${clean.slice(0, MAX_ERROR_SNIPPET)}…` : clean;
}
