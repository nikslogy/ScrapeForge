// End to end through the public entry point: env → registry → real
// providers (against a local server) → client → prompt/parse.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Budget,
  buildExtractionPrompt,
  CircuitBreaker,
  createDefaultModelClient,
  estimateTokens,
  type LlmCallError,
  parseExtractionResponse,
} from '../../src/extract/llm/index.js';
import { normalizeSchema } from '../../src/extract/schema/normalize.js';
import { chatCompletion, geminiResponse, sendJson, startMockServer, type MockServer } from './mock-server.js';

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

const schema = normalizeSchema({ title: 'string', price: 'number' });

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    OPENROUTER_API_KEY: 'sk-or-v1-e2e-secret-0001',
    GEMINI_API_KEY: 'AIza-e2e-secret-0002-xxxxxxxxxxxx',
    OPENROUTER_BASE_URL: `${server.baseUrl}/openrouter/v1`,
    GEMINI_BASE_URL: `${server.baseUrl}/gemini/v1beta`,
    EXTRACT_MODELS: 'openrouter:google/gemini-2.5-flash,gemini:gemini-2.5-flash',
    ...extra,
  };
}

describe('createDefaultModelClient', () => {
  it('runs prompt → provider → parse end to end', async () => {
    server.handle((req, res) => {
      const user = ((req.body.messages as Array<{ content: string }>)[1]).content;
      expect(user).toContain('[b2] £51.77');
      sendJson(
        res,
        200,
        chatCompletion(JSON.stringify({ records: [{ title: { v: 'A Light in the Attic', b: 'b1' }, price: { v: '£51.77', b: 'b2' } }] }), {
          usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0.0004 },
          provider: 'Google AI Studio',
        }),
      );
    });
    const client = createDefaultModelClient(env(), { breaker: new CircuitBreaker() });
    expect(client.warnings).toEqual([]);
    const p = buildExtractionPrompt({ schema, renderedBlocks: '[b1] # A Light in the Attic\n[b2] £51.77', url: 'https://books.test/1', shapeHint: 'object' });
    const budget = new Budget({ deadlineMs: Date.now() + 10_000, maxCostUsd: 0.05 });
    const { response, model, attempts } = await client.complete(
      { system: p.system, user: p.user, responseSchema: p.responseSchema, maxOutputTokens: 2_000 },
      { purpose: 'extract', budget, estimatedInputTokens: estimateTokens(p.system + p.user) },
    );
    expect(model.key).toBe('openrouter:google/gemini-2.5-flash');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ ok: true, resolvedProvider: 'Google AI Studio', costUsd: 0.0004 });
    expect(budget.spentUsd).toBeCloseTo(0.0004, 12);
    expect(server.requests[0].url).toBe('/openrouter/v1/chat/completions');

    const parsed = parseExtractionResponse(response.text, schema);
    expect(parsed.records).toEqual([{ title: { v: 'A Light in the Attic', b: 'b1' }, price: { v: '£51.77', b: 'b2' } }]);
    expect(parsed.warnings).toEqual([]);
  });

  it('falls back from OpenRouter (bad key) to Gemini and opens the breaker', async () => {
    server.handle((req, res) => {
      if (req.url.startsWith('/openrouter')) sendJson(res, 401, { error: { message: 'User not found.', code: 401 } });
      else sendJson(res, 200, geminiResponse([{ text: '{"records":[]}' }]));
    });
    const breaker = new CircuitBreaker();
    const client = createDefaultModelClient(env(), { breaker });
    const budget = new Budget({ deadlineMs: Date.now() + 10_000 });
    const result = await client.complete({ system: 's json', user: 'u', maxOutputTokens: 100 }, { purpose: 'extract', budget });
    expect(result.model.key).toBe('gemini:gemini-2.5-flash');
    expect(result.attempts.map((a) => a.errorCategory ?? 'ok')).toEqual(['auth', 'ok']);
    expect(breaker.isOpen('openrouter')).toBe(true);

    // The next request skips OpenRouter without calling it.
    server.requests.length = 0;
    await client.complete({ system: 's json', user: 'u', maxOutputTokens: 100 }, { purpose: 'extract', budget });
    expect(server.requests.map((r) => r.url)).toEqual(['/gemini/v1beta/models/gemini-2.5-flash:generateContent']);
  });

  it('retries json_schema rejections with json_object on the real wire format', async () => {
    server.handle((req, res) => {
      const format = req.body.response_format as { type: string } | undefined;
      if (format?.type === 'json_schema') sendJson(res, 400, { error: { message: 'json_schema response format is not supported' } });
      else sendJson(res, 200, chatCompletion('{"records":[]}'));
    });
    const client = createDefaultModelClient(env({ EXTRACT_MODELS: 'openrouter:google/gemini-2.5-flash' }), { breaker: new CircuitBreaker() });
    const p = buildExtractionPrompt({ schema, renderedBlocks: '[b1] x', url: 'https://x.test', shapeHint: 'auto' });
    const result = await client.complete(
      { system: p.system, user: p.user, responseSchema: p.responseSchema, maxOutputTokens: 500 },
      { purpose: 'extract', budget: new Budget({ deadlineMs: Date.now() + 10_000 }) },
    );
    expect(server.requests.map((r) => (r.body.response_format as { type: string }).type)).toEqual(['json_schema', 'json_object']);
    expect(result.model.jsonMode).toBe('json_object');
  });

  it('reports every failed attempt when all providers fail, without leaking keys', async () => {
    server.handle((_req, res) => sendJson(res, 503, 'upstream down: key=sk-or-v1-e2e-secret-0001'));
    const sleeps: number[] = [];
    const client = createDefaultModelClient(env(), {
      breaker: new CircuitBreaker(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    let error: LlmCallError | undefined;
    try {
      await client.complete({ system: 's', user: 'u', maxOutputTokens: 100 }, { purpose: 'extract', budget: new Budget({ deadlineMs: Date.now() + 20_000 }) });
    } catch (err) {
      error = err as LlmCallError;
    }
    expect(error?.category).toBe('overloaded');
    // One backoff retry per model.
    expect(error?.attempts?.map((a) => `${a.provider}:${a.errorCategory}`)).toEqual([
      'openrouter:overloaded',
      'openrouter:overloaded',
      'gemini:overloaded',
      'gemini:overloaded',
    ]);
    expect(sleeps).toHaveLength(2);
    expect(sleeps.every((ms) => ms >= 500 && ms < 1_500)).toBe(true);
    expect(JSON.stringify({ message: error?.message, attempts: error?.attempts })).not.toContain('e2e-secret');
  });

  it('surfaces configuration warnings and wires only configured providers', () => {
    const client = createDefaultModelClient(
      { GROQ_API_KEY: 'gsk_x', EXTRACT_MODELS: 'groq:mystery-model,openai:gpt-4.1-mini', EXTRACT_LLM_TIMEOUT_MS: 'abc' },
      { breaker: new CircuitBreaker() },
    );
    expect(client.models.map((m) => m.key)).toEqual(['groq:mystery-model']);
    expect(client.warnings).toEqual([
      expect.stringMatching(/^unknown model groq:mystery-model/),
      'skipping openai:gpt-4.1-mini: OPENAI_API_KEY is not set',
      'EXTRACT_LLM_TIMEOUT_MS is not a positive number; using the default',
    ]);
  });

  it('throws on an invalid base URL', () => {
    expect(() => createDefaultModelClient(env({ OPENROUTER_BASE_URL: 'javascript:alert(1)' }))).toThrow(/OPENROUTER_BASE_URL/);
  });
});
