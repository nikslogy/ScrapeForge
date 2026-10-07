// Google Gemini generateContent adapter (REST, non-streaming).
//
// The key travels in the x-goog-api-key header, never in the URL, so it
// cannot leak through proxies, access logs or error messages that echo URLs.
// JSON mode is responseMimeType "application/json"; for json_schema the
// response envelope is converted to Gemini's OpenAPI-style schema subset,
// and when that is impossible the request goes out with JSON mode only.

import type { JsonSchema, LlmProvider, LlmRequest, LlmResponse, ModelCapabilities } from '../../types.js';
import { LlmCallError, type LlmErrorDetails } from '../errors.js';
import { estimateCostUsd } from '../registry.js';
import { effectiveMaxOutput, estimateTokens } from '../tokens.js';
import {
  embeddedError,
  httpError,
  isRecord,
  nonNegativeInt,
  normalizeBaseUrl,
  parseJsonBody,
  postJson,
  validApiKey,
  type CallContext,
  type HttpResult,
} from './http.js';

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const LABEL = 'Gemini';

export interface GeminiOptions {
  apiKey: string;
  /** API root such as ".../v1beta"; "/models/{model}:generateContent" is appended. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini' as const;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(opts: GeminiOptions) {
    this.#apiKey = validApiKey(opts.apiKey, LABEL);
    this.#baseUrl = normalizeBaseUrl(opts.baseUrl ?? GEMINI_DEFAULT_BASE_URL, 'GEMINI_BASE_URL');
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async complete(caps: ModelCapabilities, req: LlmRequest): Promise<LlmResponse> {
    const ctx: CallContext = { caps, secrets: [this.#apiKey], signal: req.signal, fetchImpl: this.#fetch };
    const model = encodeURIComponent(caps.model.replace(/^models\//, ''));
    const url = `${this.#baseUrl}/models/${model}:generateContent`;
    const started = performance.now();
    const result = await postJson(url, { 'x-goog-api-key': this.#apiKey }, buildGeminiBody(caps, req), ctx);
    if (result.status < 200 || result.status >= 300) throw httpError(result, ctx, LABEL);
    const json = parseJsonBody(result, ctx, LABEL);
    return readGeminiResponse(json, result, ctx, caps, req, Math.round(performance.now() - started));
  }
}

export function geminiFromEnv(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): GeminiProvider | undefined {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '') return undefined;
  return new GeminiProvider({ apiKey, baseUrl: env.GEMINI_BASE_URL?.trim() || undefined, fetchImpl });
}

/** Request body for generateContent. Exported for tests. */
export function buildGeminiBody(caps: ModelCapabilities, req: LlmRequest): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    temperature: req.temperature ?? 0,
    maxOutputTokens: effectiveMaxOutput(caps, req.maxOutputTokens),
  };
  if (caps.jsonMode !== 'none') {
    generationConfig.responseMimeType = 'application/json';
    if (caps.jsonMode === 'json_schema' && req.responseSchema) {
      const schema = toGeminiSchema(req.responseSchema);
      if (schema) generationConfig.responseSchema = schema;
    }
  }
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts: [{ text: req.user }] }],
    generationConfig,
  };
}

const MAX_SCHEMA_DEPTH = 16;
const SCALAR_TYPES: Readonly<Record<string, string>> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
};

/**
 * JSON Schema → Gemini Schema (OpenAPI 3.0 subset). Keeps type, nullable,
 * properties, required, items, enum (strings), description, min/maxItems
 * and anyOf; drops additionalProperties, $schema and other keywords Gemini
 * rejects. Returns null when the schema cannot be expressed (untyped or
 * multi-type values, $ref, objects without properties).
 */
export function toGeminiSchema(schema: JsonSchema, depth = 0): Record<string, unknown> | null {
  if (depth > MAX_SCHEMA_DEPTH || !isRecord(schema)) return null;
  if ('$ref' in schema) return null;

  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.filter((b) => !(isRecord(b) && b.type === 'null'));
    const nullable = branches.length < schema.anyOf.length;
    const converted = branches.map((b) => (isRecord(b) ? toGeminiSchema(b, depth + 1) : null));
    if (converted.length === 0 || converted.some((c) => c === null)) return null;
    const out: Record<string, unknown> =
      converted.length === 1 ? { ...(converted[0] as Record<string, unknown>) } : { anyOf: converted };
    if (nullable) out.nullable = true;
    return out;
  }

  const rawTypes = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
  const nullable = rawTypes.includes('null') || schema.nullable === true;
  const types = rawTypes.filter((t) => t !== 'null');
  if (types.length !== 1 || typeof types[0] !== 'string') return null;
  const type = types[0];

  let out: Record<string, unknown>;
  if (type === 'object') {
    if (!isRecord(schema.properties)) return null;
    const keys = Object.keys(schema.properties);
    // Gemini rejects OBJECT schemas with empty properties.
    if (keys.length === 0) return null;
    const properties: Record<string, unknown> = {};
    for (const k of keys) {
      const sub = schema.properties[k];
      const converted = isRecord(sub) ? toGeminiSchema(sub, depth + 1) : null;
      if (!converted) return null;
      Object.defineProperty(properties, k, { value: converted, enumerable: true, writable: true, configurable: true });
    }
    out = { type: 'OBJECT', properties, propertyOrdering: keys };
    const required = Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === 'string' && keys.includes(r)) : [];
    if (required.length > 0) out.required = required;
  } else if (type === 'array') {
    if (!isRecord(schema.items)) return null;
    const items = toGeminiSchema(schema.items, depth + 1);
    if (!items) return null;
    out = { type: 'ARRAY', items };
    if (Number.isInteger(schema.minItems)) out.minItems = schema.minItems;
    if (Number.isInteger(schema.maxItems)) out.maxItems = schema.maxItems;
  } else if (Object.hasOwn(SCALAR_TYPES, type)) {
    out = { type: SCALAR_TYPES[type] };
    if (type === 'string' && Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((e) => typeof e === 'string')) {
      out.enum = schema.enum;
    }
  } else {
    return null;
  }
  if (typeof schema.description === 'string') out.description = schema.description.slice(0, 1_000);
  if (nullable) out.nullable = true;
  return out;
}

export function mapGeminiFinishReason(reason: unknown): LlmResponse['finishReason'] {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'content_filter';
    default:
      return 'other';
  }
}

function readGeminiResponse(
  json: Record<string, unknown>,
  result: HttpResult,
  ctx: CallContext,
  caps: ModelCapabilities,
  req: LlmRequest,
  latencyMs: number,
): LlmResponse {
  const usage = isRecord(json.usageMetadata) ? json.usageMetadata : {};
  const resolvedModel = typeof json.modelVersion === 'string' ? json.modelVersion : undefined;
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : undefined;
  const content = candidate && isRecord(candidate.content) ? candidate.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  // Thought summaries (thought: true) are not part of the answer.
  const text = parts.map((p) => (isRecord(p) && typeof p.text === 'string' && p.thought !== true ? p.text : '')).join('');

  const inputTokens = nonNegativeInt(usage.promptTokenCount) ?? estimateTokens(req.system) + estimateTokens(req.user);
  // Thinking tokens are billed as output.
  const reportedOutput = nonNegativeInt(usage.candidatesTokenCount);
  const outputTokens = (reportedOutput ?? estimateTokens(text)) + (nonNegativeInt(usage.thoughtsTokenCount) ?? 0);
  const costUsd = estimateCostUsd(caps, inputTokens, outputTokens);
  const details: LlmErrorDetails = { inputTokens, outputTokens, costUsd, resolvedModel };

  if (isRecord(json.error)) throw embeddedError(json.error, result, ctx, LABEL, details);

  let finishReason = mapGeminiFinishReason(candidate?.finishReason);
  // A blocked prompt has no candidates, only promptFeedback.blockReason.
  const feedback = isRecord(json.promptFeedback) ? json.promptFeedback : {};
  if (!candidate && typeof feedback.blockReason === 'string') finishReason = 'content_filter';

  if (text.trim() === '' && finishReason !== 'length' && finishReason !== 'content_filter') {
    const raw = typeof candidate?.finishReason === 'string' ? candidate.finishReason : undefined;
    throw new LlmCallError(
      `${LABEL} ${caps.model}: empty content (finishReason=${(raw ?? 'none').slice(0, 40)})`,
      'empty_output',
      caps.provider,
      caps.model,
      result.status,
      { ...details, finishReason: raw },
    );
  }
  const response: LlmResponse = { text, finishReason, inputTokens, outputTokens, costUsd, latencyMs };
  if (resolvedModel) response.resolvedModel = resolvedModel;
  return response;
}
