// Chat-completions adapter for OpenRouter, Groq and OpenAI (same wire format,
// small differences handled here):
//   * OpenRouter: attribution headers, usage:{include:true} so the response
//     carries the real cost, and the routed upstream in "provider"/"model".
//     Errors from the upstream can arrive inside an HTTP 200 body.
//   * OpenAI: max_completion_tokens instead of the deprecated max_tokens.
//   * Groq: plain OpenAI-compatible.

import type { LlmProvider, LlmRequest, LlmResponse, ModelCapabilities } from '../../types.js';
import { LlmCallError, type LlmErrorDetails } from '../errors.js';
import { isStrictCompatible } from '../json-schema.js';
import { estimateCostUsd } from '../registry.js';
import { effectiveMaxOutput, estimateTokens } from '../tokens.js';
import {
  embeddedError,
  httpError,
  isRecord,
  nonNegativeInt,
  nonNegativeNumber,
  normalizeBaseUrl,
  parseJsonBody,
  postJson,
  validApiKey,
  type CallContext,
  type HttpResult,
} from './http.js';

export type OpenAICompatibleName = 'openrouter' | 'groq' | 'openai';

export const DEFAULT_BASE_URLS: Readonly<Record<OpenAICompatibleName, string>> = {
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  openai: 'https://api.openai.com/v1',
};

export const BASE_URL_ENV: Readonly<Record<OpenAICompatibleName, string>> = {
  openrouter: 'OPENROUTER_BASE_URL',
  groq: 'GROQ_BASE_URL',
  openai: 'OPENAI_BASE_URL',
};

const KEY_ENV: Readonly<Record<OpenAICompatibleName, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
};

const LABEL: Readonly<Record<OpenAICompatibleName, string>> = { openrouter: 'OpenRouter', groq: 'Groq', openai: 'OpenAI' };

/** Name sent with json_schema response formats (^[a-zA-Z0-9_-]{1,64}$). */
export const RESPONSE_SCHEMA_NAME = 'extraction_response';

export interface OpenAICompatibleOptions {
  name: OpenAICompatibleName;
  apiKey: string;
  /** API root such as "https://openrouter.ai/api/v1"; "/chat/completions" is appended. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** OpenRouter attribution (HTTP-Referer / X-Title). */
  appUrl?: string;
  appTitle?: string;
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: OpenAICompatibleName;
  // Private fields keep the key out of console.log / JSON.stringify output.
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #appUrl: string;
  readonly #appTitle: string;

  constructor(opts: OpenAICompatibleOptions) {
    this.name = opts.name;
    this.#apiKey = validApiKey(opts.apiKey, LABEL[opts.name]);
    this.#endpoint = `${normalizeBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URLS[opts.name], BASE_URL_ENV[opts.name])}/chat/completions`;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#appUrl = opts.appUrl ?? 'https://scrapeforge.io';
    this.#appTitle = opts.appTitle ?? 'ScrapeForge';
  }

  async complete(caps: ModelCapabilities, req: LlmRequest): Promise<LlmResponse> {
    const ctx: CallContext = { caps, secrets: [this.#apiKey], signal: req.signal, fetchImpl: this.#fetch };
    const headers: Record<string, string> = { authorization: `Bearer ${this.#apiKey}` };
    if (this.name === 'openrouter') {
      headers['HTTP-Referer'] = this.#appUrl;
      headers['X-Title'] = this.#appTitle;
    }
    const started = performance.now();
    const result = await postJson(this.#endpoint, headers, buildChatBody(this.name, caps, req), ctx);
    if (result.status < 200 || result.status >= 300) throw httpError(result, ctx, LABEL[this.name]);
    const json = parseJsonBody(result, ctx, LABEL[this.name]);
    return readChatCompletion(json, result, ctx, LABEL[this.name], caps, req, Math.round(performance.now() - started));
  }
}

/** Provider for `name` configured from env, or undefined when its key is missing. */
export function openAICompatibleFromEnv(
  name: OpenAICompatibleName,
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): OpenAICompatibleProvider | undefined {
  const apiKey = env[KEY_ENV[name]];
  if (!apiKey || apiKey.trim() === '') return undefined;
  const baseUrl = env[BASE_URL_ENV[name]]?.trim() || undefined;
  return new OpenAICompatibleProvider({
    name,
    apiKey,
    baseUrl,
    fetchImpl,
    appUrl: name === 'openrouter' ? env.OPENROUTER_REFERER?.trim() || undefined : undefined,
    appTitle: name === 'openrouter' ? env.OPENROUTER_APP_TITLE?.trim() || undefined : undefined,
  });
}

/** Request body for /chat/completions. Exported for tests. */
export function buildChatBody(name: OpenAICompatibleName, caps: ModelCapabilities, req: LlmRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: caps.model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
    temperature: req.temperature ?? 0,
  };
  body[name === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = effectiveMaxOutput(caps, req.maxOutputTokens);

  const format = responseFormat(caps, req);
  if (format) body.response_format = format;
  if (name === 'openrouter') {
    body.usage = { include: true };
    // Without this OpenRouter may route to an upstream that silently ignores
    // response_format; with it, an unsupported format fails fast (and the
    // client retries with a weaker JSON mode).
    if (format) body.provider = { require_parameters: true };
  }
  return body;
}

function responseFormat(caps: ModelCapabilities, req: LlmRequest): Record<string, unknown> | undefined {
  if (caps.jsonMode === 'none') return undefined;
  if (caps.jsonMode === 'json_schema' && req.responseSchema) {
    return {
      type: 'json_schema',
      json_schema: {
        name: RESPONSE_SCHEMA_NAME,
        // A schema strict mode cannot express would be rejected outright;
        // send it best-effort instead (local validation still applies).
        strict: caps.strictSchema && isStrictCompatible(req.responseSchema),
        schema: req.responseSchema,
      },
    };
  }
  return { type: 'json_object' };
}

export function mapFinishReason(reason: unknown): LlmResponse['finishReason'] {
  switch (reason) {
    case 'stop':
    case 'end_turn':
    case 'eos':
      return 'stop';
    case 'length':
    case 'max_tokens':
    case 'max_output_tokens':
      return 'length';
    case 'content_filter':
    case 'safety':
      return 'content_filter';
    default:
      return 'other';
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  // Some upstreams return content parts: [{type:"text", text:"..."}].
  if (Array.isArray(content)) {
    return content.map((p) => (isRecord(p) && typeof p.text === 'string' && p.type !== 'reasoning' ? p.text : '')).join('');
  }
  return '';
}

function readChatCompletion(
  json: Record<string, unknown>,
  result: HttpResult,
  ctx: CallContext,
  label: string,
  caps: ModelCapabilities,
  req: LlmRequest,
  latencyMs: number,
): LlmResponse {
  const usage = isRecord(json.usage) ? json.usage : {};
  const resolvedModel = typeof json.model === 'string' ? json.model : undefined;
  const resolvedProvider = typeof json.provider === 'string' ? json.provider : undefined;
  const reportedInput = nonNegativeInt(usage.prompt_tokens);
  const reportedOutput = nonNegativeInt(usage.completion_tokens);
  const reportedCost = nonNegativeNumber(usage.cost);
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : undefined;

  // An error in the body (often an upstream failure before any generation) is
  // charged only for the usage the provider reports, never an estimate.
  const embedded = isRecord(json.error) ? json.error : choice && isRecord(choice.error) ? choice.error : undefined;
  if (embedded) {
    const reported: LlmErrorDetails = { inputTokens: reportedInput, outputTokens: reportedOutput, resolvedModel, resolvedProvider };
    reported.costUsd =
      reportedCost ??
      (reportedInput !== undefined || reportedOutput !== undefined ? estimateCostUsd(caps, reportedInput ?? 0, reportedOutput ?? 0) : undefined);
    throw embeddedError(embedded, result, ctx, label, reported);
  }

  const message = choice && isRecord(choice.message) ? choice.message : {};
  const text = contentText(message.content);
  // Providers that omit usage still cost something; estimate rather than record 0.
  const inputTokens = reportedInput ?? estimateTokens(req.system) + estimateTokens(req.user);
  const outputTokens = reportedOutput ?? estimateTokens(text);
  const costUsd = reportedCost ?? estimateCostUsd(caps, inputTokens, outputTokens);
  const details: LlmErrorDetails = { inputTokens, outputTokens, costUsd, resolvedModel, resolvedProvider };

  let finishReason = mapFinishReason(choice?.finish_reason);
  // Structured-output refusals come back as message.refusal with no content.
  if (typeof message.refusal === 'string' && message.refusal.trim() !== '' && text.trim() === '') finishReason = 'content_filter';

  if (text.trim() === '' && finishReason !== 'length' && finishReason !== 'content_filter') {
    throw new LlmCallError(
      `${label} ${caps.model}: empty content (finish_reason=${String(choice?.finish_reason ?? 'none').slice(0, 40)})`,
      'empty_output',
      caps.provider,
      caps.model,
      result.status,
      { ...details, finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined },
    );
  }
  const response: LlmResponse = { text, finishReason, inputTokens, outputTokens, costUsd, latencyMs };
  if (resolvedModel) response.resolvedModel = resolvedModel;
  if (resolvedProvider) response.resolvedProvider = resolvedProvider;
  return response;
}
