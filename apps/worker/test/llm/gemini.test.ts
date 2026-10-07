import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LlmCallError } from '../../src/extract/llm/errors.js';
import { buildResponseSchema } from '../../src/extract/llm/prompt.js';
import {
  buildGeminiBody,
  GeminiProvider,
  geminiFromEnv,
  mapGeminiFinishReason,
  toGeminiSchema,
} from '../../src/extract/llm/providers/gemini.js';
import { normalizeSchema } from '../../src/extract/schema/normalize.js';
import { LlmError, type LlmRequest, type ModelCapabilities } from '../../src/extract/types.js';
import { geminiResponse, sendJson, startMockServer, type MockServer } from './mock-server.js';

const KEY = 'AIzaSyD-TESTKEY-0123456789abcdefghijk';

let server: MockServer;
beforeAll(async () => {
  server = await startMockServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  server.requests.length = 0;
});

function caps(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    key: 'gemini:gemini-2.5-flash',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    contextTokens: 1_000_000,
    maxOutputTokens: 8_192,
    jsonMode: 'json_schema',
    strictSchema: false,
    inputCostPerMTok: 0.3,
    outputCostPerMTok: 2.5,
    ...overrides,
  };
}

const schema = normalizeSchema({
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Book title' },
    tags: { type: 'array', items: { type: 'string' } },
    specs: { type: 'object', properties: { weight: { type: 'number' } }, additionalProperties: false },
  },
  required: ['title'],
});
const responseSchema = buildResponseSchema(schema.fields);

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return { system: 'Return JSON.', user: '<page>[b1] hello</page>', maxOutputTokens: 2_000, responseSchema, ...overrides };
}

function provider(): GeminiProvider {
  return new GeminiProvider({ apiKey: KEY, baseUrl: `${server.baseUrl}/v1beta` });
}

async function failure(p: Promise<unknown>): Promise<LlmCallError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(LlmError);
    return err as LlmCallError;
  }
  throw new Error('expected the call to fail');
}

function walk(node: unknown, visit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (node && typeof node === 'object') {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((n) => walk(n, visit));
  }
}

describe('Gemini provider', () => {
  it('sends the key in a header, never in the URL, and maps the response', async () => {
    server.handle((_req, res) =>
      sendJson(
        res,
        200,
        geminiResponse([{ text: 'thinking…', thought: true }, { text: '{"records":' }, { text: '[]}' }], {
          usage: { promptTokenCount: 1_000, candidatesTokenCount: 100, thoughtsTokenCount: 50 },
        }),
      ),
    );
    const res = await provider().complete(caps(), request());
    expect(res.text).toBe('{"records":[]}');
    expect(res.finishReason).toBe('stop');
    expect(res.inputTokens).toBe(1_000);
    // Thinking tokens are billed as output.
    expect(res.outputTokens).toBe(150);
    expect(res.costUsd).toBeCloseTo((1_000 * 0.3 + 150 * 2.5) / 1e6, 12);
    expect(res.resolvedModel).toBe('gemini-2.5-flash-001');

    const [sent] = server.requests;
    expect(sent.url).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
    expect(sent.url).not.toContain('key=');
    expect(sent.headers['x-goog-api-key']).toBe(KEY);
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.body.systemInstruction).toEqual({ parts: [{ text: 'Return JSON.' }] });
    expect(sent.body.contents).toEqual([{ role: 'user', parts: [{ text: '<page>[b1] hello</page>' }] }]);
    const config = sent.body.generationConfig as Record<string, unknown>;
    expect(config).toMatchObject({ temperature: 0, maxOutputTokens: 2_000, responseMimeType: 'application/json' });
    expect(config.responseSchema).toBeDefined();
  });

  it('strips a "models/" prefix from the model id', async () => {
    server.handle((_req, res) => sendJson(res, 200, geminiResponse([{ text: '{}' }])));
    await provider().complete(caps({ model: 'models/gemini-2.5-flash' }), request());
    expect(server.requests[0].url).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
  });

  it('converts the envelope schema to the Gemini subset', () => {
    const converted = toGeminiSchema(responseSchema);
    expect(converted).not.toBeNull();
    walk(converted, (o) => {
      expect(o).not.toHaveProperty('additionalProperties');
      expect(o).not.toHaveProperty('$schema');
      if (typeof o.type === 'string') expect(o.type).toMatch(/^(OBJECT|ARRAY|STRING|NUMBER|INTEGER|BOOLEAN)$/);
      if (o.type !== undefined) expect(Array.isArray(o.type)).toBe(false);
    });
    const records = (converted as { properties: { records: { items: { properties: Record<string, unknown>; required: string[] } } } }).properties.records;
    expect(records.items.required).toEqual(['title', 'tags', 'specs']);
    expect(records.items.properties.title).toEqual({
      type: 'OBJECT',
      properties: { v: { type: 'STRING', nullable: true }, b: { type: 'STRING', nullable: true } },
      propertyOrdering: ['v', 'b'],
      required: ['v', 'b'],
    });
  });

  it('sends JSON mode without a schema when conversion is impossible', () => {
    const freeForm = buildResponseSchema(normalizeSchema({ type: 'object', properties: { blob: { type: 'object' } } }).fields);
    expect(toGeminiSchema(freeForm)).toBeNull();
    const body = buildGeminiBody(caps(), request({ responseSchema: freeForm }));
    const config = body.generationConfig as Record<string, unknown>;
    expect(config.responseMimeType).toBe('application/json');
    expect(config).not.toHaveProperty('responseSchema');
  });

  it('honours JSON modes', () => {
    const objectMode = buildGeminiBody(caps({ jsonMode: 'json_object' }), request()).generationConfig as Record<string, unknown>;
    expect(objectMode.responseMimeType).toBe('application/json');
    expect(objectMode).not.toHaveProperty('responseSchema');
    const none = buildGeminiBody(caps({ jsonMode: 'none' }), request()).generationConfig as Record<string, unknown>;
    expect(none).not.toHaveProperty('responseMimeType');
  });

  it('converts unions, enums and rejects $ref / untyped values', () => {
    expect(toGeminiSchema({ anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'null' }] })).toEqual({
      type: 'STRING',
      enum: ['a', 'b'],
      nullable: true,
    });
    expect(toGeminiSchema({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toEqual({
      anyOf: [{ type: 'STRING' }, { type: 'NUMBER' }],
    });
    expect(toGeminiSchema({ $ref: '#/$defs/x' })).toBeNull();
    expect(toGeminiSchema({})).toBeNull();
    expect(toGeminiSchema({ type: ['string', 'number'] })).toBeNull();
    expect(toGeminiSchema({ type: 'array' })).toBeNull();
    // A property named __proto__ stays an own key.
    const proto = toGeminiSchema(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'));
    expect(Object.keys((proto as { properties: object }).properties)).toEqual(['__proto__']);
    // Deep nesting is bounded.
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 40; i++) deep = { type: 'array', items: deep };
    expect(toGeminiSchema(deep)).toBeNull();
  });

  it('maps finish reasons and blocked prompts', async () => {
    expect(mapGeminiFinishReason('MAX_TOKENS')).toBe('length');
    expect(mapGeminiFinishReason('SAFETY')).toBe('content_filter');
    expect(mapGeminiFinishReason('RECITATION')).toBe('content_filter');
    expect(mapGeminiFinishReason('OTHER')).toBe('other');

    server.handle((_req, res) => sendJson(res, 200, geminiResponse([{ text: '{"records":[{"ti' }], { finish: 'MAX_TOKENS' })));
    expect((await provider().complete(caps(), request())).finishReason).toBe('length');

    server.handle((_req, res) => sendJson(res, 200, geminiResponse([], { finish: 'SAFETY' })));
    expect((await provider().complete(caps(), request())).finishReason).toBe('content_filter');

    server.handle((_req, res) => sendJson(res, 200, { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 10 } }));
    expect((await provider().complete(caps(), request())).finishReason).toBe('content_filter');
  });

  it('reports empty content as empty_output', async () => {
    server.handle((_req, res) => sendJson(res, 200, geminiResponse([{ text: '' }])));
    const err = await failure(provider().complete(caps(), request()));
    expect(err.category).toBe('empty_output');
    expect(err.inputTokens).toBe(200);
  });

  it('classifies Gemini errors', async () => {
    const cases: Array<[number, unknown, string]> = [
      [400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 'auth'],
      [403, { error: { code: 403, message: 'Permission denied', status: 'PERMISSION_DENIED' } }, 'auth'],
      [
        429,
        {
          error: {
            code: 429,
            message: 'You exceeded your current quota, please check your plan and billing details.',
            status: 'RESOURCE_EXHAUSTED',
            details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
          },
        },
        'quota',
      ],
      [400, { error: { code: 400, message: 'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).' } }, 'input_too_large'],
      [400, { error: { code: 400, message: 'Invalid JSON payload received. Unknown name "propertyOrdering" at generation_config.response_schema' } }, 'unsupported_request'],
      [503, { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }, 'overloaded'],
      [500, { error: { code: 500, message: 'Internal error' } }, 'overloaded'],
    ];
    for (const [status, body, category] of cases) {
      server.handle((_req, res) => sendJson(res, status, body));
      const err = await failure(provider().complete(caps(), request()));
      expect(err.category, JSON.stringify(body)).toBe(category);
      expect(err.message).not.toContain(KEY);
    }
  });

  it('reads RetryInfo from a per-minute 429 body', async () => {
    server.handle((_req, res) =>
      sendJson(res, 429, {
        error: {
          code: 429,
          message: 'You exceeded your current quota. Please retry in 12.5s.',
          status: 'RESOURCE_EXHAUSTED',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateContentInputTokensPerModelPerMinute-FreeTier' }] },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' },
          ],
        },
      }),
    );
    const err = await failure(provider().complete(caps(), request()));
    expect(err.category).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(12_000);
  });

  it('times out slow responses', async () => {
    server.handle(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 2_000));
      if (!res.writableEnded) sendJson(res, 200, geminiResponse([{ text: '{}' }]));
    });
    const err = await failure(provider().complete(caps(), request({ signal: AbortSignal.timeout(100) })));
    expect(err.category).toBe('timeout');
  });

  it('builds from env only with a key and rejects a bad base URL', () => {
    expect(geminiFromEnv({})).toBeUndefined();
    expect(geminiFromEnv({ GEMINI_API_KEY: KEY })).toBeInstanceOf(GeminiProvider);
    expect(() => geminiFromEnv({ GEMINI_API_KEY: KEY, GEMINI_BASE_URL: 'https://x.test/v1beta?key=1' })).toThrow(/GEMINI_BASE_URL/);
    expect(JSON.stringify(provider())).not.toContain(KEY);
  });
});
