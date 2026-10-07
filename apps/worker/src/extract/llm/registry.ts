// Model capability registry.
//
// EXTRACT_MODELS lists "provider:model" keys in priority order; the first is
// the primary model and the rest are bounded fallbacks. EXTRACT_MODEL_CAPS
// (JSON) overrides capabilities per key. When EXTRACT_MODELS is unset the
// legacy per-provider env vars still work.
//
// The known-model table below was written offline: context sizes, output
// limits, JSON-mode support and prices are conservative defaults to be
// confirmed by benchmark, not verified facts. Unknown models get safe
// defaults and a warning rather than a failure.
//
// API keys are only checked for presence here; providers read them from env.
// They are never copied into ModelCapabilities or warnings.

import type { JsonMode, ModelCapabilities } from '../types.js';

export type RealProvider = Exclude<ModelCapabilities['provider'], 'fake'>;

export const PROVIDERS: readonly RealProvider[] = ['openrouter', 'groq', 'gemini', 'openai'];

export const PROVIDER_KEY_ENV: Readonly<Record<RealProvider, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/** Legacy fallback order and env vars (used when EXTRACT_MODELS is unset). */
const LEGACY: ReadonlyArray<{ provider: RealProvider; modelEnv: readonly string[]; defaultModel: string }> = [
  { provider: 'openrouter', modelEnv: ['OPENROUTER_MODEL'], defaultModel: 'meta-llama/llama-3.3-70b-instruct:free' },
  // GROQ_MODELS (a list) predates this module; keep honouring it.
  { provider: 'groq', modelEnv: ['GROQ_MODELS', 'GROQ_MODEL'], defaultModel: 'llama-3.3-70b-versatile' },
  { provider: 'gemini', modelEnv: ['GEMINI_MODEL'], defaultModel: 'gemini-2.5-flash-lite' },
  { provider: 'openai', modelEnv: ['OPENAI_MODEL'], defaultModel: 'gpt-4.1-nano' },
];

type KnownCaps = Omit<ModelCapabilities, 'key' | 'provider' | 'model'>;

function caps(
  contextTokens: number,
  maxOutputTokens: number,
  jsonMode: JsonMode,
  strictSchema: boolean,
  inputCostPerMTok?: number,
  outputCostPerMTok?: number,
): KnownCaps {
  const out: KnownCaps = { contextTokens, maxOutputTokens, jsonMode, strictSchema };
  if (inputCostPerMTok !== undefined) out.inputCostPerMTok = inputCostPerMTok;
  if (outputCostPerMTok !== undefined) out.outputCostPerMTok = outputCostPerMTok;
  return out;
}

/**
 * Defaults to be confirmed by benchmark. Limits are rounded down from the
 * advertised values; prices (USD per million tokens) are list prices as last
 * known and only used when a provider does not report cost itself.
 */
export const KNOWN_MODELS: Readonly<Record<string, KnownCaps>> = {
  // OpenRouter reports the actual cost per call, so its rates are fallbacks.
  'openrouter:google/gemini-2.5-flash': caps(1_000_000, 32_768, 'json_schema', false, 0.3, 2.5),
  'openrouter:google/gemini-2.5-flash-lite': caps(1_000_000, 32_768, 'json_schema', false, 0.1, 0.4),
  'openrouter:openai/gpt-4.1-mini': caps(1_000_000, 32_768, 'json_schema', true, 0.4, 1.6),
  'openrouter:openai/gpt-4.1-nano': caps(1_000_000, 32_768, 'json_schema', true, 0.1, 0.4),
  'openrouter:openai/gpt-4o-mini': caps(128_000, 16_384, 'json_schema', true, 0.15, 0.6),
  'openrouter:meta-llama/llama-3.3-70b-instruct': caps(128_000, 8_192, 'json_object', false, 0.2, 0.6),
  'openrouter:meta-llama/llama-3.3-70b-instruct:free': caps(64_000, 8_192, 'json_object', false, 0, 0),
  'groq:llama-3.3-70b-versatile': caps(128_000, 8_192, 'json_object', false, 0.59, 0.79),
  'groq:llama-3.1-8b-instant': caps(128_000, 8_192, 'json_object', false, 0.05, 0.08),
  'groq:openai/gpt-oss-20b': caps(128_000, 16_384, 'json_object', false, 0.1, 0.5),
  'groq:openai/gpt-oss-120b': caps(128_000, 16_384, 'json_object', false, 0.15, 0.75),
  'gemini:gemini-2.5-flash': caps(1_000_000, 32_768, 'json_schema', false, 0.3, 2.5),
  'gemini:gemini-2.5-flash-lite': caps(1_000_000, 32_768, 'json_schema', false, 0.1, 0.4),
  'gemini:gemini-2.0-flash-lite': caps(1_000_000, 8_192, 'json_schema', false, 0.075, 0.3),
  'openai:gpt-4.1-mini': caps(1_000_000, 32_768, 'json_schema', true, 0.4, 1.6),
  'openai:gpt-4.1-nano': caps(1_000_000, 32_768, 'json_schema', true, 0.1, 0.4),
  'openai:gpt-4o-mini': caps(128_000, 16_384, 'json_schema', true, 0.15, 0.6),
};

/** Capabilities assumed for a model the table does not know. */
export const UNKNOWN_MODEL_DEFAULTS: Readonly<KnownCaps> = {
  contextTokens: 32_000,
  maxOutputTokens: 4_096,
  jsonMode: 'json_object',
  strictSchema: false,
};

const JSON_MODES: ReadonlySet<string> = new Set(['none', 'json_object', 'json_schema']);
const MAX_MODELS = 16;
const MAX_TOKENS_LIMIT = 100_000_000;

export interface ResolvedModels {
  models: ModelCapabilities[];
  warnings: string[];
}

export function isRealProvider(value: string): value is RealProvider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** Splits "openrouter:meta-llama/x:free" at the first colon. */
export function parseModelKey(key: string): { provider: RealProvider; model: string } | null {
  const i = key.indexOf(':');
  if (i <= 0) return null;
  const provider = key.slice(0, i).trim().toLowerCase();
  const model = key.slice(i + 1).trim();
  if (!isRealProvider(provider) || model === '' || /\s/.test(model)) return null;
  return { provider, model };
}

export function hasApiKey(env: NodeJS.ProcessEnv, provider: RealProvider): boolean {
  const value = env[PROVIDER_KEY_ENV[provider]];
  return typeof value === 'string' && value.trim() !== '';
}

function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Validated EXTRACT_MODEL_CAPS entries; invalid fields are dropped with a warning. */
function parseCapsOverrides(raw: string | undefined, warnings: string[]): Map<string, Partial<KnownCaps>> {
  const out = new Map<string, Partial<KnownCaps>>();
  if (raw === undefined || raw.trim() === '') return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push('EXTRACT_MODEL_CAPS is not valid JSON; ignored');
    return out;
  }
  if (!isPlainObject(parsed)) {
    warnings.push('EXTRACT_MODEL_CAPS must be a JSON object keyed by "provider:model"; ignored');
    return out;
  }
  for (const [rawKey, value] of Object.entries(parsed)) {
    const parsedKey = parseModelKey(rawKey);
    if (!parsedKey) {
      warnings.push(`EXTRACT_MODEL_CAPS: ignoring entry ${JSON.stringify(rawKey)} (expected "provider:model")`);
      continue;
    }
    if (!isPlainObject(value)) {
      warnings.push(`EXTRACT_MODEL_CAPS: entry ${JSON.stringify(rawKey)} must be an object; ignored`);
      continue;
    }
    out.set(`${parsedKey.provider}:${parsedKey.model}`, validOverride(rawKey, value, warnings));
  }
  return out;
}

function validOverride(key: string, value: Record<string, unknown>, warnings: string[]): Partial<KnownCaps> {
  const o: Partial<KnownCaps> = {};
  const bad = (field: string) => warnings.push(`EXTRACT_MODEL_CAPS: ${key}.${field} is invalid; ignored`);
  for (const [field, v] of Object.entries(value)) {
    switch (field) {
      case 'contextTokens':
      case 'maxOutputTokens':
        if (Number.isInteger(v) && (v as number) > 0 && (v as number) <= MAX_TOKENS_LIMIT) o[field] = v as number;
        else bad(field);
        break;
      case 'inputCostPerMTok':
      case 'outputCostPerMTok':
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) o[field] = v;
        else bad(field);
        break;
      case 'jsonMode':
        if (typeof v === 'string' && JSON_MODES.has(v)) o.jsonMode = v as JsonMode;
        else bad(field);
        break;
      case 'strictSchema':
        if (typeof v === 'boolean') o.strictSchema = v;
        else bad(field);
        break;
      default:
        // key/provider/model come from EXTRACT_MODELS; anything else is a typo.
        warnings.push(`EXTRACT_MODEL_CAPS: ${key}.${field} cannot be overridden; ignored`);
    }
  }
  return o;
}

function buildCaps(
  provider: RealProvider,
  model: string,
  override: Partial<KnownCaps> | undefined,
  warnings: string[],
): ModelCapabilities {
  const key = `${provider}:${model}`;
  const known = Object.hasOwn(KNOWN_MODELS, key) ? KNOWN_MODELS[key] : undefined;
  const base = known ?? UNKNOWN_MODEL_DEFAULTS;
  if (!known) {
    const defaulted = (['contextTokens', 'maxOutputTokens', 'jsonMode', 'strictSchema'] as const).filter(
      (f) => override?.[f] === undefined,
    );
    if (defaulted.length > 0) {
      warnings.push(
        `unknown model ${key}: using conservative defaults for ${defaulted
          .map((f) => `${f}=${String(UNKNOWN_MODEL_DEFAULTS[f])}`)
          .join(', ')} (set EXTRACT_MODEL_CAPS to override)`,
      );
    }
  }
  const out: ModelCapabilities = { key, provider, model, ...base, ...override };
  if (out.maxOutputTokens > out.contextTokens) {
    warnings.push(`${key}: maxOutputTokens exceeds contextTokens; clamped`);
    out.maxOutputTokens = out.contextTokens;
  }
  return out;
}

function explicitEntries(value: string, warnings: string[]): Array<{ provider: RealProvider; model: string }> {
  const out: Array<{ provider: RealProvider; model: string }> = [];
  for (const item of splitList(value)) {
    const parsed = parseModelKey(item);
    if (!parsed) {
      warnings.push(
        `EXTRACT_MODELS: ignoring ${JSON.stringify(item.slice(0, 100))} (expected "provider:model" with provider one of ${PROVIDERS.join(', ')})`,
      );
      continue;
    }
    out.push(parsed);
  }
  return out;
}

function legacyEntries(env: NodeJS.ProcessEnv): Array<{ provider: RealProvider; model: string }> {
  const out: Array<{ provider: RealProvider; model: string }> = [];
  for (const { provider, modelEnv, defaultModel } of LEGACY) {
    if (!hasApiKey(env, provider)) continue;
    let models: string[] = [];
    for (const name of modelEnv) {
      models = splitList(env[name]);
      if (models.length > 0) break;
    }
    if (models.length === 0) models = [defaultModel];
    for (const model of models) out.push({ provider, model });
  }
  return out;
}

/**
 * Resolves the ordered model list from env. Never throws: configuration
 * problems become warnings and the offending entries are skipped.
 */
export function resolveModels(env: NodeJS.ProcessEnv): ResolvedModels {
  const warnings: string[] = [];
  const overrides = parseCapsOverrides(env.EXTRACT_MODEL_CAPS, warnings);
  const explicit = (env.EXTRACT_MODELS ?? '').trim() !== '';
  const entries = explicit ? explicitEntries(env.EXTRACT_MODELS as string, warnings) : legacyEntries(env);

  const models: ModelCapabilities[] = [];
  const seen = new Set<string>();
  for (const { provider, model } of entries) {
    const key = `${provider}:${model}`;
    if (seen.has(key)) {
      warnings.push(`duplicate model ${key}; keeping the first occurrence`);
      continue;
    }
    seen.add(key);
    if (!hasApiKey(env, provider)) {
      warnings.push(`skipping ${key}: ${PROVIDER_KEY_ENV[provider]} is not set`);
      continue;
    }
    if (models.length >= MAX_MODELS) {
      warnings.push(`more than ${MAX_MODELS} models configured; ignoring ${key} and later entries`);
      break;
    }
    models.push(buildCaps(provider, model, overrides.get(key), warnings));
  }
  for (const key of overrides.keys()) {
    if (!seen.has(key)) warnings.push(`EXTRACT_MODEL_CAPS: no configured model ${key}; entry unused`);
  }
  if (models.length === 0) {
    warnings.push(
      explicit
        ? 'EXTRACT_MODELS yielded no usable model'
        : `no model configured: set EXTRACT_MODELS or one of ${PROVIDERS.map((p) => PROVIDER_KEY_ENV[p]).join(', ')}`,
    );
  }
  return { models, warnings };
}

/** Cost from registry rates; 0 when the model has no rates. */
export function estimateCostUsd(
  caps: Pick<ModelCapabilities, 'inputCostPerMTok' | 'outputCostPerMTok'>,
  inputTokens: number,
  outputTokens: number,
): number {
  const input = caps.inputCostPerMTok ?? 0;
  const output = caps.outputCostPerMTok ?? 0;
  const cost = (Math.max(0, inputTokens) * input + Math.max(0, outputTokens) * output) / 1_000_000;
  return Number.isFinite(cost) ? cost : 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
