// Model layer: provider adapters, capability registry, error classification,
// circuit breaker, budget, prompt/response protocol and test fakes.

import type { LlmProvider, ModelCapabilities } from '../types.js';
import { defaultBreaker, type CircuitBreaker } from './breaker.js';
import { ModelClient } from './client.js';
import { geminiFromEnv } from './providers/gemini.js';
import { openAICompatibleFromEnv } from './providers/openai-compatible.js';
import { resolveModels } from './registry.js';

export { Budget, type BudgetOptions } from './budget.js';
export { CircuitBreaker, defaultBreaker, type BreakerEntry, type CircuitBreakerOptions } from './breaker.js';
export {
  AUTH_TRIP_MS,
  DEFAULT_PER_CALL_TIMEOUT_MS,
  ModelClient,
  QUOTA_TRIP_MS,
  type ClientAttemptRecord,
  type CompleteOptions,
  type CompleteResult,
  type LlmPurpose,
  type ModelClientOptions,
} from './client.js';
export {
  classifyFailure,
  errorDetails,
  LlmCallError,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  scrubSecrets,
  snippet,
  toLlmError,
  type Classification,
  type FailureScope,
  type LlmErrorDetails,
} from './errors.js';
export { isStrictCompatible } from './json-schema.js';
export { buildRepairPrompt, parseExtractionResponse, type ParsedCell, type ParsedRecord, type ParseResult, type ParseSource } from './parse.js';
export { buildExtractionPrompt, buildResponseSchema, neutralizePageTags, type ExtractionPrompt, type ExtractionPromptArgs } from './prompt.js';
export {
  estimateCostUsd,
  hasApiKey,
  KNOWN_MODELS,
  parseModelKey,
  PROVIDER_KEY_ENV,
  PROVIDERS,
  resolveModels,
  UNKNOWN_MODEL_DEFAULTS,
  type RealProvider,
  type ResolvedModels,
} from './registry.js';
export { effectiveMaxOutput, estimateTokens, planInputBudget, type InputBudgetOptions } from './tokens.js';
export { FakeProvider, delay, fakeCaps, fakeError, fakeResponse, scripted, type FakeCall, type FakeHandler, type FakeStep } from './providers/fake.js';
export { GeminiProvider, geminiFromEnv, toGeminiSchema } from './providers/gemini.js';
export { OpenAICompatibleProvider, openAICompatibleFromEnv, type OpenAICompatibleName } from './providers/openai-compatible.js';

export interface DefaultModelClientOptions {
  breaker?: CircuitBreaker;
  /** Injected fetch (tests); defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected backoff sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * ModelClient for the models configured in `env` (EXTRACT_MODELS or the
 * legacy *_API_KEY vars), with real providers and the process-wide breaker.
 * Configuration problems are on `client.warnings`. EXTRACT_LLM_TIMEOUT_MS
 * overrides the per-call timeout. Throws only for an invalid *_BASE_URL or a
 * malformed API key (the message names the provider, never the key).
 */
export function createDefaultModelClient(env: NodeJS.ProcessEnv = process.env, opts: DefaultModelClientOptions = {}): ModelClient {
  const { models, warnings } = resolveModels(env);
  const providers: Partial<Record<ModelCapabilities['provider'], LlmProvider>> = {};
  const needed = new Set(models.map((m) => m.provider));
  for (const name of ['openrouter', 'groq', 'openai'] as const) {
    if (needed.has(name)) providers[name] = openAICompatibleFromEnv(name, env, opts.fetchImpl);
  }
  if (needed.has('gemini')) providers.gemini = geminiFromEnv(env, opts.fetchImpl);

  const timeout = Number(env.EXTRACT_LLM_TIMEOUT_MS);
  const perCallTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
  if (env.EXTRACT_LLM_TIMEOUT_MS !== undefined && perCallTimeoutMs === undefined) {
    warnings.push('EXTRACT_LLM_TIMEOUT_MS is not a positive number; using the default');
  }
  return new ModelClient({ models, providers, breaker: opts.breaker ?? defaultBreaker, sleep: opts.sleep, perCallTimeoutMs, warnings });
}
