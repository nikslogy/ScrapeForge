import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LlmCallError } from '../../src/extract/llm/errors.js';
import { isStrictCompatible } from '../../src/extract/llm/json-schema.js';
import { buildResponseSchema } from '../../src/extract/llm/prompt.js';
import {
  buildChatBody,
  OpenAICompatibleProvider,
  openAICompatibleFromEnv,
  RESPONSE_SCHEMA_NAME,
} from '../../src/extract/llm/providers/openai-compatible.js';
import { LlmError, type LlmRequest, type ModelCapabilities } from '../../src/extract/types.js';
import { normalizeSchema } from '../../src/extract/schema/normalize.js';
import { chatCompletion, sendJson, startMockServer, type MockServer } from './mock-server.js';

const KEY = 'sk-or-v1-0123456789abcdefSECRET';

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
    key: 'openrouter:google/gemini-2.5-flash',
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash',
    contextTokens: 1_000_000,
    maxOutputTokens: 8_192,
    jsonMode: 'json_schema',
    strictSchema: false,
    inputCostPerMTok: 1,
    outputCostPerMTok: 2,
    ...overrides,
  };
}

const schema = normalizeSchema({ title: 'string — book title', price: 'number' });
const responseSchema = buildResponseSchema(schema.fields);

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return { system: 'Return JSON.', user: '<page>[b1] hello</page>', maxOutputTokens: 1_000, responseSchema, ...overrides };
}

function provider(name: 'openrouter' | 'groq' | 'openai' = 'openrouter'): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({ name, apiKey: KEY, baseUrl: `${server.baseUrl}/v1/` });
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

describe('OpenAI-compatible provider: requests', () => {
  it('sends an OpenRouter request with attribution headers, usage accounting and json_schema', async () => {
    server.handle((_req, res) =>
      sendJson(res, 200, chatCompletion('{"records":[]}', { usage: { prompt_tokens: 50, completion_tokens: 7, cost: 0.00123 }, provider: 'Google', model: 'google/gemini-2.5-flash-001' })),
    );
    const res = await provider().complete(caps(), request());

    expect(res).toMatchObject({
      text: '{"records":[]}',
      finishReason: 'stop',
      inputTokens: 50,
      outputTokens: 7,
      costUsd: 0.00123,
      resolvedModel: 'google/gemini-2.5-flash-001',
      resolvedProvider: 'Google',
    });
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);

    const [sent] = server.requests;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent.headers['http-referer']).toBe('https://scrapeforge.io');
    expect(sent.headers['x-title']).toBe('ScrapeForge');
    expect(sent.body).toMatchObject({
      model: 'google/gemini-2.5-flash',
      max_tokens: 1_000,
      temperature: 0,
      usage: { include: true },
      provider: { require_parameters: true },
      messages: [
        { role: 'system', content: 'Return JSON.' },
        { role: 'user', content: '<page>[b1] hello</page>' },
      ],
      response_format: { type: 'json_schema', json_schema: { name: RESPONSE_SCHEMA_NAME, strict: false, schema: responseSchema } },
    });
    // The key travels only in the Authorization header.
    expect(sent.url).not.toContain(KEY);
    expect(sent.rawBody).not.toContain(KEY);
  });

  it('uses max_completion_tokens and no OpenRouter extras for OpenAI', async () => {
    server.handle((_req, res) => sendJson(res, 200, chatCompletion('{"records":[]}')));
    await provider('openai').complete(caps({ provider: 'openai', model: 'gpt-4.1-mini', strictSchema: true }), request());
    const [sent] = server.requests;
    expect(sent.body.max_completion_tokens).toBe(1_000);
    expect(sent.body).not.toHaveProperty('max_tokens');
    expect(sent.body).not.toHaveProperty('usage');
    expect(sent.body).not.toHaveProperty('provider');
    expect(sent.headers['http-referer']).toBeUndefined();
    expect((sent.body.response_format as { json_schema: { strict: boolean } }).json_schema.strict).toBe(true);
  });

  it('caps max tokens at the model limit', () => {
    const body = buildChatBody('groq', caps({ provider: 'groq', maxOutputTokens: 512 }), request({ maxOutputTokens: 100_000 }));
    expect(body.max_tokens).toBe(512);
  });

  it('sends json_object, or no response_format, per JSON mode', () => {
    const objectBody = buildChatBody('groq', caps({ provider: 'groq', jsonMode: 'json_object' }), request());
    expect(objectBody.response_format).toEqual({ type: 'json_object' });
    const noneBody = buildChatBody('openrouter', caps({ jsonMode: 'none' }), request());
    expect(noneBody).not.toHaveProperty('response_format');
    expect(noneBody).not.toHaveProperty('provider');
    // json_schema without a schema falls back to json_object.
    const noSchema = buildChatBody('openai', caps({ jsonMode: 'json_schema' }), request({ responseSchema: undefined }));
    expect(noSchema.response_format).toEqual({ type: 'json_object' });
  });

  it('sends strict:false when the schema cannot be strict', () => {
    const freeForm = normalizeSchema({ type: 'object', properties: { specs: { type: 'object' } } });
    const loose = buildResponseSchema(freeForm.fields);
    expect(isStrictCompatible(loose)).toBe(false);
    const body = buildChatBody('openai', caps({ provider: 'openai', strictSchema: true }), request({ responseSchema: loose }));
    expect((body.response_format as { json_schema: { strict: boolean } }).json_schema.strict).toBe(false);
  });

  it('passes temperature through', () => {
    expect(buildChatBody('groq', caps(), request({ temperature: 0.4 })).temperature).toBe(0.4);
  });

  it('accepts content parts and estimates usage when it is missing', async () => {
    server.handle((_req, res) =>
      sendJson(res, 200, {
        model: 'x',
        choices: [{ message: { content: [{ type: 'text', text: '{"records":' }, { type: 'text', text: '[]}' }] }, finish_reason: 'stop' }],
      }),
    );
    const res = await provider('groq').complete(caps({ provider: 'groq' }), request());
    expect(res.text).toBe('{"records":[]}');
    expect(res.inputTokens).toBeGreaterThan(0);
    expect(res.outputTokens).toBeGreaterThan(0);
    // No reported cost: registry rates apply.
    expect(res.costUsd).toBeCloseTo((res.inputTokens * 1 + res.outputTokens * 2) / 1e6, 12);
  });

  it('maps finish reasons', async () => {
    for (const [finish, expected] of [
      ['length', 'length'],
      ['content_filter', 'content_filter'],
      ['tool_calls', 'other'],
      [null, 'other'],
    ] as const) {
      server.handle((_req, res) => sendJson(res, 200, chatCompletion('{"records":[{"a"', { finish })));
      const res = await provider().complete(caps(), request());
      expect(res.finishReason).toBe(expected);
    }
  });

  it('returns a length-truncated response with empty content instead of empty_output', async () => {
    server.handle((_req, res) => sendJson(res, 200, chatCompletion('', { finish: 'length' })));
    const res = await provider().complete(caps(), request());
    expect(res.finishReason).toBe('length');
  });

  it('treats a structured-output refusal as content_filter', async () => {
    server.handle((_req, res) =>
      sendJson(res, 200, { model: 'gpt', choices: [{ message: { content: null, refusal: 'I cannot help' }, finish_reason: 'stop' }] }),
    );
    const res = await provider('openai').complete(caps({ provider: 'openai' }), request());
    expect(res.finishReason).toBe('content_filter');
  });

  it('keeps the key out of the provider object representation', () => {
    const p = provider();
    expect(JSON.stringify(p)).not.toContain(KEY);
    expect(String(Object.values(p))).not.toContain(KEY);
  });

  it('rejects invalid configuration', () => {
    expect(() => new OpenAICompatibleProvider({ name: 'groq', apiKey: '' })).toThrow(/API key/);
    let message = '';
    try {
      new OpenAICompatibleProvider({ name: 'groq', apiKey: 'gsk_abc\ndefSECRET' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe('Groq: the API key contains invalid characters');
    expect(() => new OpenAICompatibleProvider({ name: 'groq', apiKey: KEY, baseUrl: 'ftp://x' })).toThrow(/GROQ_BASE_URL/);
    expect(() => new OpenAICompatibleProvider({ name: 'groq', apiKey: KEY, baseUrl: 'not a url' })).toThrow(/GROQ_BASE_URL/);
    expect(() => new OpenAICompatibleProvider({ name: 'groq', apiKey: KEY, baseUrl: 'https://u:p@x.test/v1' })).toThrow(/credentials/);
  });

  it('builds from env only when the key is set', () => {
    expect(openAICompatibleFromEnv('openrouter', {})).toBeUndefined();
    expect(openAICompatibleFromEnv('openrouter', { OPENROUTER_API_KEY: '  ' })).toBeUndefined();
    expect(openAICompatibleFromEnv('openrouter', { OPENROUTER_API_KEY: KEY })).toBeInstanceOf(OpenAICompatibleProvider);
  });
});

describe('OpenAI-compatible provider: error classification', () => {
  const cases: Array<{ name: string; status: number; body: unknown; headers?: Record<string, string>; category: string }> = [
    {
      name: 'json_schema rejection',
      status: 400,
      body: { error: { message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.", type: 'invalid_request_error' } },
      category: 'unsupported_request',
    },
    { name: 'OpenRouter no endpoint for parameters', status: 404, body: { error: { message: 'No endpoints found that can handle the requested parameters.', code: 404 } }, category: 'unsupported_request' },
    { name: 'Groq json_validate_failed', status: 400, body: { error: { message: 'Failed to generate JSON.', code: 'json_validate_failed' } }, category: 'unsupported_request' },
    { name: '401', status: 401, body: { error: { message: 'No auth credentials found', code: 401 } }, category: 'auth' },
    { name: '403 moderation', status: 403, body: { error: { message: 'Your chosen model requires moderation and your input was flagged for "violence"', code: 403 } }, category: 'content_filter' },
    { name: '402', status: 402, body: { error: { message: 'Insufficient credits', code: 402 } }, category: 'quota' },
    { name: '429 per-minute', status: 429, body: { error: { message: 'Rate limit exceeded: free-models-per-min.', code: 429 } }, headers: { 'retry-after': '7' }, category: 'rate_limit' },
    { name: '429 per-day', status: 429, body: { error: { message: 'Rate limit exceeded: free-models-per-day. Add credits to unlock more requests per day', code: 429 } }, category: 'quota' },
    { name: '413', status: 413, body: { error: { message: 'Request too large for model llama-3.3-70b-versatile on tokens per minute (TPM): Limit 6000, Requested 9000' } }, category: 'input_too_large' },
    { name: 'context length 400', status: 400, body: { error: { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens." } }, category: 'input_too_large' },
    { name: '500', status: 500, body: 'Internal Server Error', category: 'overloaded' },
    { name: '529', status: 529, body: { error: { type: 'overloaded_error', message: 'Overloaded' } }, category: 'overloaded' },
    { name: '408', status: 408, body: '', category: 'overloaded' },
    { name: 'model not found', status: 404, body: { error: { message: 'Model does-not/exist is not a valid model ID', code: 404 } }, category: 'unknown' },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.category}`, async () => {
      server.handle((_req, res) => sendJson(res, c.status, c.body, c.headers));
      const err = await failure(provider().complete(caps(), request()));
      expect(err.category).toBe(c.category);
      expect(err.status).toBe(c.status);
      expect(err.provider).toBe('openrouter');
      expect(err.model).toBe('google/gemini-2.5-flash');
      expect(err.message).toContain(`HTTP ${c.status}`);
    });
  }

  it('captures Retry-After in seconds and caps it at 30 s', async () => {
    server.handle((_req, res) => sendJson(res, 429, { error: { message: 'Rate limit exceeded' } }, { 'retry-after': '7' }));
    const short = await failure(provider().complete(caps(), request()));
    expect(short.category).toBe('rate_limit');
    expect(short.retryAfterMs).toBe(7_000);

    server.handle((_req, res) => sendJson(res, 429, { error: { message: 'Rate limit exceeded' } }, { 'retry-after': '120' }));
    const long = await failure(provider().complete(caps(), request()));
    expect(long.retryAfterMs).toBe(30_000);
    expect(long.requestedRetryAfterMs).toBe(120_000);
  });

  it('reports account-level quota as provider scope', async () => {
    server.handle((_req, res) => sendJson(res, 402, { error: { message: 'This request requires more credits', code: 402 } }));
    expect((await failure(provider().complete(caps(), request()))).scope).toBe('provider');
    server.handle((_req, res) => sendJson(res, 429, { error: { message: 'free-models-per-day limit', code: 429 } }));
    expect((await failure(provider().complete(caps(), request()))).scope).toBe('model');
  });

  it('classifies errors embedded in a 200 body by their code and message', async () => {
    server.handle((_req, res) =>
      sendJson(res, 200, { error: { code: 429, message: 'Rate limit exceeded: free-models-per-min' }, usage: { prompt_tokens: 10, completion_tokens: 0 } }),
    );
    const rate = await failure(provider().complete(caps(), request()));
    expect(rate.category).toBe('rate_limit');
    expect(rate.status).toBe(429);
    expect(rate.message).toContain('in HTTP 200 body');
    expect(rate.inputTokens).toBe(10);

    server.handle((_req, res) =>
      sendJson(res, 200, { error: { code: 502, message: 'Provider returned error', metadata: { raw: 'upstream overloaded' } } }),
    );
    expect((await failure(provider().complete(caps(), request()))).category).toBe('overloaded');

    server.handle((_req, res) =>
      sendJson(res, 200, {
        model: 'm',
        choices: [{ message: { content: '' }, finish_reason: 'error', error: { code: 'server_error', message: 'upstream error' } }],
      }),
    );
    expect((await failure(provider().complete(caps(), request()))).category).toBe('overloaded');
  });

  it('reports empty content as empty_output with usage attached', async () => {
    server.handle((_req, res) => sendJson(res, 200, chatCompletion('   ', { usage: { prompt_tokens: 80, completion_tokens: 0, cost: 0.0001 } })));
    const err = await failure(provider().complete(caps(), request()));
    expect(err.category).toBe('empty_output');
    expect(err.inputTokens).toBe(80);
    expect(err.costUsd).toBe(0.0001);

    server.handle((_req, res) => sendJson(res, 200, { model: 'm', choices: [] }));
    expect((await failure(provider().complete(caps(), request()))).category).toBe('empty_output');
  });

  it('treats a non-JSON 200 body as unknown', async () => {
    server.handle((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>gateway</html>');
    });
    const err = await failure(provider().complete(caps(), request()));
    expect(err.category).toBe('unknown');
  });

  it('times out a slow response via the request signal', async () => {
    server.handle(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 2_000));
      if (!res.writableEnded) sendJson(res, 200, chatCompletion('{}'));
    });
    const started = Date.now();
    const err = await failure(provider().complete(caps(), request({ signal: AbortSignal.timeout(100) })));
    expect(err.category).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('reports connection failures as network errors', async () => {
    const closed = await startMockServer();
    const url = closed.baseUrl;
    await closed.close();
    const p = new OpenAICompatibleProvider({ name: 'groq', apiKey: KEY, baseUrl: url });
    const err = await failure(p.complete(caps({ provider: 'groq' }), request()));
    expect(err.category).toBe('network');
    expect(err.message).toMatch(/ECONNREFUSED|fetch failed/);
  });

  it('never puts the key or other secrets into error messages', async () => {
    server.handle((_req, res) =>
      sendJson(res, 401, {
        error: {
          message: `Incorrect API key provided: ${KEY}. Header was Authorization: Bearer ${KEY}; also api_key=abc123def456 and sk-proj-OTHERSECRET999 and AIzaSyA-1234567890abcdefghijklmnop`,
        },
      }),
    );
    const err = await failure(provider().complete(caps(), request()));
    expect(err.category).toBe('auth');
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain('SECRET');
    expect(err.message).not.toContain('abc123def456');
    expect(err.message).not.toContain('OTHERSECRET999');
    expect(err.message).not.toContain('AIzaSyA-1234567890');
    expect(JSON.stringify(err)).not.toContain(KEY);
  });

  it('bounds the error message length', async () => {
    server.handle((_req, res) => sendJson(res, 500, 'x'.repeat(200_000)));
    const err = await failure(provider().complete(caps(), request()));
    expect(err.message.length).toBeLessThan(420);
  });

  it('refuses to follow redirects (would replay the Authorization header)', async () => {
    server.handle((_req, res) => {
      res.writeHead(307, { location: 'http://127.0.0.1:1/steal' });
      res.end();
    });
    const err = await failure(provider().complete(caps(), request()));
    expect(err.category).toBe('network');
    expect(server.requests).toHaveLength(1);
  });
});
