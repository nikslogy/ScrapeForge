// HTTP plumbing shared by the real providers: one POST with a bounded body
// read, and conversion of failures into classified LlmErrors.

import type { ModelCapabilities } from '../../types.js';
import {
  capRetryAfter,
  classifyFailure,
  LlmCallError,
  parseRetryAfter,
  snippet,
  toLlmError,
  type LlmErrorDetails,
} from '../errors.js';

/** Successful responses are bounded by max output tokens; anything bigger is broken. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Error bodies only feed classification and a 300-char snippet. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

export interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
}

export interface CallContext {
  caps: Pick<ModelCapabilities, 'provider' | 'model'>;
  /** Strings to scrub from any message (the API key). */
  secrets: readonly string[];
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
}

/**
 * POSTs JSON and returns status + body. Non-2xx responses are returned too
 * (the body capped at 64 KiB) so the caller can classify them; transport
 * failures and aborts throw network/timeout LlmErrors.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  ctx: CallContext,
): Promise<HttpResult> {
  try {
    const res = await ctx.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctx.signal,
      // Redirects on an API endpoint are never expected; following one could
      // replay the Authorization header to another host.
      redirect: 'error',
    });
    const ok = res.status >= 200 && res.status < 300;
    const text = await readBody(res, ok ? MAX_RESPONSE_BYTES : MAX_ERROR_BODY_BYTES, ok);
    return { status: res.status, headers: res.headers, text };
  } catch (err) {
    if (err instanceof ResponseTooLargeError) {
      throw new LlmCallError(`${ctx.caps.provider} ${ctx.caps.model}: ${err.message}`, 'unknown', ctx.caps.provider, ctx.caps.model);
    }
    throw toLlmError(err, ctx.caps, ctx.signal, ctx.secrets);
  }
}

class ResponseTooLargeError extends Error {}

/**
 * Reads at most `maxBytes`. Over the limit: throws when `strict`, otherwise
 * returns the prefix (error bodies only need their head).
 */
async function readBody(res: Response, maxBytes: number, strict: boolean): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel().catch(() => undefined);
      if (strict) throw new ResponseTooLargeError(`response body exceeds ${maxBytes} bytes`);
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return new TextDecoder().decode(Buffer.concat(chunks, total));
}

/** LlmError for a non-2xx response. */
export function httpError(result: HttpResult, ctx: CallContext, label: string): LlmCallError {
  const { category, scope } = classifyFailure(result.status, result.text);
  const requested = parseRetryAfter(result.headers, result.text);
  const details: LlmErrorDetails = { scope, requestedRetryAfterMs: requested, retryAfterMs: capRetryAfter(requested) };
  const body = snippet(result.text, ctx.secrets);
  return new LlmCallError(
    `${label} ${ctx.caps.model}: HTTP ${result.status}${body ? `: ${body}` : ''}`,
    category,
    ctx.caps.provider,
    ctx.caps.model,
    result.status,
    details,
  );
}

/**
 * LlmError for an error object embedded in a 2xx body (OpenRouter reports
 * upstream failures this way). The embedded code is used as the status when
 * it is numeric.
 */
export function embeddedError(
  error: Record<string, unknown>,
  result: HttpResult,
  ctx: CallContext,
  label: string,
  details: LlmErrorDetails = {},
): LlmCallError {
  const code = error.code;
  const status = typeof code === 'number' && Number.isInteger(code) ? code : 0;
  // Classify on the whole error object: OpenRouter puts the upstream text in metadata.raw.
  const text = safeStringify(error);
  const { category, scope } = classifyFailure(status, typeof code === 'string' ? `${code} ${text}` : text);
  const requested = parseRetryAfter(result.headers, text);
  const message = typeof error.message === 'string' ? error.message : text;
  return new LlmCallError(
    `${label} ${ctx.caps.model}: error${status ? ` ${status}` : ''} in HTTP ${result.status} body: ${snippet(message, ctx.secrets)}`,
    category,
    ctx.caps.provider,
    ctx.caps.model,
    status || result.status,
    { ...details, scope, requestedRetryAfterMs: requested, retryAfterMs: capRetryAfter(requested) },
  );
}

/** Parses a 2xx body; garbage (HTML error page, truncated JSON) is an 'unknown' failure. */
export function parseJsonBody(result: HttpResult, ctx: CallContext, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LlmCallError(
      `${label} ${ctx.caps.model}: HTTP ${result.status} with a non-JSON body: ${snippet(result.text, ctx.secrets)}`,
      'unknown',
      ctx.caps.provider,
      ctx.caps.model,
      result.status,
    );
  }
  return parsed as Record<string, unknown>;
}

export function nonNegativeInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
}

export function nonNegativeNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/**
 * Trimmed API key, or an error naming the provider only. A key with spaces
 * or control characters would make fetch reject the header with a message
 * that quotes it.
 */
export function validApiKey(raw: string | undefined, label: string): string {
  const key = (raw ?? '').trim();
  if (key === '') throw new Error(`${label}: an API key is required`);
  if (!/^[\x21-\x7e]+$/.test(key)) throw new Error(`${label}: the API key contains invalid characters`);
  return key;
}

/** Validates and normalizes a configured base URL (no trailing slash). */
export function normalizeBaseUrl(raw: string, envName: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${envName} is not a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${envName} must be an http(s) URL`);
  if (url.username || url.password) throw new Error(`${envName} must not contain credentials`);
  if (url.search || url.hash) throw new Error(`${envName} must not contain a query string or fragment`);
  return url.toString().replace(/\/+$/, '');
}
