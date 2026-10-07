import { describe, expect, it } from 'vitest';
import {
  estimateCostUsd,
  KNOWN_MODELS,
  parseModelKey,
  resolveModels,
  UNKNOWN_MODEL_DEFAULTS,
} from '../../src/extract/llm/registry.js';

const KEYS = {
  OPENROUTER_API_KEY: 'sk-or-v1-secretvalue0001',
  GROQ_API_KEY: 'gsk_secretvalue0002',
  GEMINI_API_KEY: 'AIzaSecretValue0003xxxxxxxxxxxx',
  OPENAI_API_KEY: 'sk-proj-secretvalue0004',
};

function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  for (const key of Object.values(KEYS)) expect(text).not.toContain(key);
}

describe('parseModelKey', () => {
  it('splits at the first colon and validates the provider', () => {
    expect(parseModelKey('openrouter:meta-llama/llama-3.3-70b-instruct:free')).toEqual({
      provider: 'openrouter',
      model: 'meta-llama/llama-3.3-70b-instruct:free',
    });
    expect(parseModelKey(' Groq : llama-3.1-8b-instant ')).toEqual({ provider: 'groq', model: 'llama-3.1-8b-instant' });
    expect(parseModelKey('anthropic:claude')).toBeNull();
    expect(parseModelKey('fake:x')).toBeNull();
    expect(parseModelKey('openai:')).toBeNull();
    expect(parseModelKey(':gpt')).toBeNull();
    expect(parseModelKey('gpt-4.1-mini')).toBeNull();
    expect(parseModelKey('openai:gpt 4')).toBeNull();
  });
});

describe('resolveModels: EXTRACT_MODELS', () => {
  it('keeps priority order and fills capabilities from the known table', () => {
    const { models, warnings } = resolveModels({
      ...KEYS,
      EXTRACT_MODELS: 'openrouter:google/gemini-2.5-flash, openrouter:openai/gpt-4.1-mini,groq:llama-3.3-70b-versatile',
    });
    expect(warnings).toEqual([]);
    expect(models.map((m) => m.key)).toEqual([
      'openrouter:google/gemini-2.5-flash',
      'openrouter:openai/gpt-4.1-mini',
      'groq:llama-3.3-70b-versatile',
    ]);
    expect(models[0]).toEqual({
      key: 'openrouter:google/gemini-2.5-flash',
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
      ...KNOWN_MODELS['openrouter:google/gemini-2.5-flash'],
    });
    expectNoSecrets(models);
  });

  it('gives unknown models safe defaults and a warning', () => {
    const { models, warnings } = resolveModels({ ...KEYS, EXTRACT_MODELS: 'openrouter:acme/new-model' });
    expect(models[0]).toMatchObject({ key: 'openrouter:acme/new-model', ...UNKNOWN_MODEL_DEFAULTS });
    expect(models[0]).toMatchObject({ contextTokens: 32_000, maxOutputTokens: 4_096, jsonMode: 'json_object', strictSchema: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^unknown model openrouter:acme\/new-model: using conservative defaults/);
  });

  it('skips models whose provider has no key, naming the env var only', () => {
    const { models, warnings } = resolveModels({
      OPENROUTER_API_KEY: KEYS.OPENROUTER_API_KEY,
      GROQ_API_KEY: '   ',
      EXTRACT_MODELS: 'groq:llama-3.3-70b-versatile,openai:gpt-4.1-mini,openrouter:openai/gpt-4o-mini',
    });
    expect(models.map((m) => m.key)).toEqual(['openrouter:openai/gpt-4o-mini']);
    expect(warnings).toEqual([
      'skipping groq:llama-3.3-70b-versatile: GROQ_API_KEY is not set',
      'skipping openai:gpt-4.1-mini: OPENAI_API_KEY is not set',
    ]);
    expectNoSecrets(warnings);
  });

  it('warns on invalid and duplicate entries', () => {
    const { models, warnings } = resolveModels({
      ...KEYS,
      EXTRACT_MODELS: 'gpt-4o, anthropic:claude,, groq:llama-3.1-8b-instant, groq:llama-3.1-8b-instant',
    });
    expect(models.map((m) => m.key)).toEqual(['groq:llama-3.1-8b-instant']);
    expect(warnings).toEqual([
      expect.stringMatching(/^EXTRACT_MODELS: ignoring "gpt-4o"/),
      expect.stringMatching(/^EXTRACT_MODELS: ignoring "anthropic:claude"/),
      'duplicate model groq:llama-3.1-8b-instant; keeping the first occurrence',
    ]);
  });

  it('does not fall back to legacy env when EXTRACT_MODELS yields nothing', () => {
    const { models, warnings } = resolveModels({ ...KEYS, EXTRACT_MODELS: 'nonsense' });
    expect(models).toEqual([]);
    expect(warnings).toContain('EXTRACT_MODELS yielded no usable model');
  });

  it('bounds the number of models', () => {
    const list = Array.from({ length: 30 }, (_, i) => `openrouter:m/${i}`).join(',');
    const { models, warnings } = resolveModels({ ...KEYS, EXTRACT_MODELS: list });
    expect(models).toHaveLength(16);
    expect(warnings.some((w) => w.startsWith('more than 16 models configured'))).toBe(true);
  });
});

describe('resolveModels: EXTRACT_MODEL_CAPS', () => {
  it('overrides capabilities per key', () => {
    const { models, warnings } = resolveModels({
      ...KEYS,
      EXTRACT_MODELS: 'openrouter:google/gemini-2.5-flash,openrouter:acme/x',
      EXTRACT_MODEL_CAPS: JSON.stringify({
        'openrouter:google/gemini-2.5-flash': { maxOutputTokens: 16_000, strictSchema: true },
        'openrouter:acme/x': { contextTokens: 200_000, maxOutputTokens: 8_000, jsonMode: 'json_schema', strictSchema: false, inputCostPerMTok: 0.5 },
      }),
    });
    expect(models[0]).toMatchObject({ maxOutputTokens: 16_000, strictSchema: true, contextTokens: 1_000_000 });
    expect(models[1]).toMatchObject({ contextTokens: 200_000, maxOutputTokens: 8_000, jsonMode: 'json_schema', inputCostPerMTok: 0.5 });
    // Every defaultable field was overridden, so no "unknown model" warning.
    expect(warnings).toEqual([]);
  });

  it('rejects invalid override values and keys with warnings', () => {
    const { models, warnings } = resolveModels({
      ...KEYS,
      EXTRACT_MODELS: 'groq:llama-3.1-8b-instant',
      EXTRACT_MODEL_CAPS: JSON.stringify({
        'groq:llama-3.1-8b-instant': { contextTokens: -1, maxOutputTokens: 1.5, jsonMode: 'xml', strictSchema: 'yes', inputCostPerMTok: -2, model: 'other', provider: 'openai' },
        'groq:not-configured': { contextTokens: 1000 },
        nonsense: {},
        'openai:gpt-4.1-mini': 7,
      }),
    });
    expect(models[0]).toMatchObject({ ...KNOWN_MODELS['groq:llama-3.1-8b-instant'], model: 'llama-3.1-8b-instant', provider: 'groq' });
    expect(warnings).toEqual(
      expect.arrayContaining([
        'EXTRACT_MODEL_CAPS: groq:llama-3.1-8b-instant.contextTokens is invalid; ignored',
        'EXTRACT_MODEL_CAPS: groq:llama-3.1-8b-instant.maxOutputTokens is invalid; ignored',
        'EXTRACT_MODEL_CAPS: groq:llama-3.1-8b-instant.jsonMode is invalid; ignored',
        'EXTRACT_MODEL_CAPS: groq:llama-3.1-8b-instant.strictSchema is invalid; ignored',
        'EXTRACT_MODEL_CAPS: groq:llama-3.1-8b-instant.inputCostPerMTok is invalid; ignored',
        'EXTRACT_MODEL_CAPS: groq:llama-3.1-8b-instant.model cannot be overridden; ignored',
        'EXTRACT_MODEL_CAPS: groq:llama-3.1-8b-instant.provider cannot be overridden; ignored',
        'EXTRACT_MODEL_CAPS: ignoring entry "nonsense" (expected "provider:model")',
        'EXTRACT_MODEL_CAPS: entry "openai:gpt-4.1-mini" must be an object; ignored',
        'EXTRACT_MODEL_CAPS: no configured model groq:not-configured; entry unused',
      ]),
    );
  });

  it('ignores malformed JSON', () => {
    expect(resolveModels({ ...KEYS, EXTRACT_MODELS: 'groq:llama-3.1-8b-instant', EXTRACT_MODEL_CAPS: '{nope' }).warnings).toEqual([
      'EXTRACT_MODEL_CAPS is not valid JSON; ignored',
    ]);
    expect(resolveModels({ ...KEYS, EXTRACT_MODELS: 'groq:llama-3.1-8b-instant', EXTRACT_MODEL_CAPS: '[1]' }).warnings[0]).toMatch(
      /must be a JSON object/,
    );
  });

  it('clamps maxOutputTokens to contextTokens', () => {
    const { models, warnings } = resolveModels({
      ...KEYS,
      EXTRACT_MODELS: 'groq:llama-3.1-8b-instant',
      EXTRACT_MODEL_CAPS: JSON.stringify({ 'groq:llama-3.1-8b-instant': { contextTokens: 4_000, maxOutputTokens: 8_000 } }),
    });
    expect(models[0].maxOutputTokens).toBe(4_000);
    expect(warnings).toContain('groq:llama-3.1-8b-instant: maxOutputTokens exceeds contextTokens; clamped');
  });

  it('is not confused by prototype-like keys', () => {
    const { models } = resolveModels({
      ...KEYS,
      EXTRACT_MODELS: 'openrouter:constructor,openrouter:__proto__',
      EXTRACT_MODEL_CAPS: '{"__proto__":{"contextTokens":1},"openrouter:__proto__":{"contextTokens":99000}}',
    });
    expect(models.map((m) => [m.model, m.contextTokens])).toEqual([
      ['constructor', 32_000],
      ['__proto__', 99_000],
    ]);
  });
});

describe('resolveModels: legacy env', () => {
  it('uses OPENROUTER, GROQ, GEMINI, OPENAI in that order with default models', () => {
    const { models, warnings } = resolveModels({ ...KEYS });
    expect(models.map((m) => m.key)).toEqual([
      'openrouter:meta-llama/llama-3.3-70b-instruct:free',
      'groq:llama-3.3-70b-versatile',
      'gemini:gemini-2.5-flash-lite',
      'openai:gpt-4.1-nano',
    ]);
    expect(warnings).toEqual([]);
  });

  it('honours *_MODEL and GROQ_MODELS and only providers with keys', () => {
    const { models } = resolveModels({
      GROQ_API_KEY: KEYS.GROQ_API_KEY,
      OPENAI_API_KEY: KEYS.OPENAI_API_KEY,
      GROQ_MODELS: 'llama-3.3-70b-versatile, openai/gpt-oss-20b',
      GROQ_MODEL: 'ignored-when-list-set',
      OPENAI_MODEL: 'gpt-4o-mini',
      GEMINI_MODEL: 'no-key-so-ignored',
    });
    expect(models.map((m) => m.key)).toEqual(['groq:llama-3.3-70b-versatile', 'groq:openai/gpt-oss-20b', 'openai:gpt-4o-mini']);
  });

  it('treats a blank EXTRACT_MODELS as unset', () => {
    expect(resolveModels({ GROQ_API_KEY: KEYS.GROQ_API_KEY, EXTRACT_MODELS: '  ' }).models.map((m) => m.key)).toEqual([
      'groq:llama-3.3-70b-versatile',
    ]);
  });

  it('warns when nothing is configured', () => {
    const { models, warnings } = resolveModels({});
    expect(models).toEqual([]);
    expect(warnings[0]).toMatch(/^no model configured: set EXTRACT_MODELS or one of OPENROUTER_API_KEY/);
  });
});

describe('estimateCostUsd', () => {
  it('multiplies tokens by per-million rates', () => {
    expect(estimateCostUsd({ inputCostPerMTok: 0.3, outputCostPerMTok: 2.5 }, 1_000_000, 100_000)).toBeCloseTo(0.55, 10);
    expect(estimateCostUsd({}, 1_000, 1_000)).toBe(0);
    expect(estimateCostUsd({ inputCostPerMTok: 1 }, -5, Number.NaN)).toBe(0);
  });
});
