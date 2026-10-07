import { describe, expect, it } from 'vitest';
import {
  capRetryAfter,
  classifyFailure,
  LlmCallError,
  MAX_ERROR_SNIPPET,
  parseRetryAfter,
  scrubSecrets,
  snippet,
  toLlmError,
} from '../../src/extract/llm/errors.js';
import { LlmError } from '../../src/extract/types.js';

const caps = { provider: 'groq', model: 'llama' } as const;

describe('classifyFailure', () => {
  const table: Array<[number, string, string, string?]> = [
    [401, 'Invalid API Key', 'auth', 'provider'],
    [403, '{"error":{"message":"Forbidden"}}', 'auth', 'provider'],
    [403, 'Your input was flagged by moderation', 'content_filter'],
    [403, 'Key limit exceeded', 'quota', 'provider'],
    [402, 'Payment Required', 'quota', 'provider'],
    [400, 'Your credit balance is too low to access the API', 'quota', 'provider'],
    [429, 'Rate limit reached for model on tokens per minute (TPM): Limit 6000', 'rate_limit'],
    [429, 'Rate limit reached for model on requests per day (RPD): Limit 1000', 'quota', 'model'],
    [429, 'Rate limit reached on tokens per day (TPD)', 'quota', 'model'],
    [429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}', 'quota', 'provider'],
    [429, 'GenerateContentInputTokensPerModelPerMinute-FreeTier RESOURCE_EXHAUSTED exceeded your current quota', 'rate_limit'],
    [429, 'monthly limit reached', 'quota', 'model'],
    [429, 'Too Many Requests', 'rate_limit'],
    [413, 'Payload Too Large', 'input_too_large'],
    [400, 'prompt is too long: 250000 tokens > 200000 maximum', 'input_too_large'],
    [400, 'Please reduce the length of the messages or completion.', 'input_too_large'],
    [400, "'response_format.type' : value is not one of the allowed values ['text','json_object']", 'unsupported_request'],
    [400, 'This model does not support structured outputs', 'unsupported_request'],
    [400, 'Parameter X is not supported', 'unsupported_request'],
    [422, 'Parameter X is not supported', 'unknown'],
    [404, 'No endpoints found that can handle the requested parameters', 'unsupported_request'],
    [400, 'API key not valid. Please pass a valid API key. API_KEY_INVALID', 'auth', 'provider'],
    [408, '', 'overloaded'],
    [500, 'maximum context length', 'overloaded'],
    [502, 'Bad gateway', 'overloaded'],
    [503, '', 'overloaded'],
    [529, 'Overloaded', 'overloaded'],
    [0, 'The server is overloaded', 'overloaded'],
    [400, 'Invalid prompt: your prompt was flagged as potentially violating our usage policy', 'content_filter'],
    [404, 'model not found', 'unknown'],
    [400, 'The specified schema produces a constraint that has too many states for serving.', 'unsupported_request'],
    [400, '', 'unknown'],
  ];
  it.each(table)('HTTP %i %j → %s', (status, body, category, scope) => {
    const c = classifyFailure(status, body);
    expect(c.category).toBe(category);
    if (scope) expect(c.scope).toBe(scope);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds, ms and HTTP dates', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '5' }))).toBe(5_000);
    expect(parseRetryAfter(new Headers({ 'retry-after': '1.5' }))).toBe(1_500);
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '250' }))).toBe(250);
    const now = Date.parse('2026-10-07T12:00:00Z');
    expect(parseRetryAfter(new Headers({ 'retry-after': 'Wed, 07 Oct 2026 12:00:20 GMT' }), '', now)).toBe(20_000);
    expect(parseRetryAfter(new Headers({ 'retry-after': 'Wed, 07 Oct 2026 11:00:00 GMT' }), '', now)).toBe(0);
  });

  it('reads Gemini RetryInfo from the body and ignores garbage', () => {
    expect(parseRetryAfter(new Headers(), '{"retryDelay": "33s"}')).toBe(33_000);
    expect(parseRetryAfter(new Headers({ 'retry-after': 'soon' }))).toBeUndefined();
    expect(parseRetryAfter(new Headers({ 'retry-after': '-3' }))).toBeUndefined();
    expect(parseRetryAfter(undefined, '')).toBeUndefined();
  });

  it('caps at 30 s', () => {
    expect(capRetryAfter(120_000)).toBe(30_000);
    expect(capRetryAfter(-1)).toBe(0);
    expect(capRetryAfter(undefined)).toBeUndefined();
  });
});

describe('scrubSecrets / snippet', () => {
  it('removes credential-looking strings', () => {
    const text = [
      'Incorrect API key provided: sk-proj-abcdefghij123456',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      'https://x.test/v1?key=AIzaSyA1234567890abcdefghijklmnopqrs&alt=json',
      'groq gsk_ABCDEFGHIJKLMNOP1234',
      '"api_key": "plainsecret99"',
      'token=tok123 password: hunter2',
    ].join('\n');
    const out = scrubSecrets(text);
    for (const secret of ['abcdefghij123456', 'eyJhbGciOiJIUzI1NiJ9', 'AIzaSyA1234567890', 'gsk_ABCDEFGHIJKLMNOP1234', 'plainsecret99', 'tok123', 'hunter2']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('alt=json');
  });

  it('removes explicitly known secrets of any shape', () => {
    expect(scrubSecrets('echo: my-weird-key-123!', ['my-weird-key-123!'])).toBe('echo: [redacted]');
    // Too short to be a key: left alone rather than redacting common words.
    expect(scrubSecrets('the key', ['key'])).toBe('the key');
  });

  it('leaves ordinary error text readable', () => {
    const msg = 'Rate limit reached for model `llama-3.3-70b-versatile` on tokens per minute (TPM): Limit 6000, Used 5000, Requested 2000. max_tokens: 4096';
    expect(scrubSecrets(msg)).toBe(msg);
  });

  it('collapses whitespace and bounds length', () => {
    expect(snippet('  a \n\n b  ')).toBe('a b');
    const long = snippet('word '.repeat(10_000));
    expect(long.length).toBe(MAX_ERROR_SNIPPET + 1);
    expect(long.endsWith('…')).toBe(true);
  });

  it('is fast on huge bodies', () => {
    const body = `${'sk-'.repeat(200_000)}${'Bearer '.repeat(100_000)}`;
    const started = performance.now();
    snippet(body);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('toLlmError', () => {
  it('passes LlmErrors through', () => {
    const e = new LlmError('x', 'quota', 'groq', 'llama');
    expect(toLlmError(e, caps)).toBe(e);
  });

  it('maps aborts to timeout', () => {
    expect(toLlmError(new DOMException('aborted', 'AbortError'), caps).category).toBe('timeout');
    expect(toLlmError(new DOMException('t', 'TimeoutError'), caps).category).toBe('timeout');
    expect(toLlmError(new Error('whatever'), caps, AbortSignal.abort()).category).toBe('timeout');
  });

  it('maps other failures to network with the cause and no secrets', () => {
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNRESET' }) });
    const e = toLlmError(err, caps);
    expect(e).toBeInstanceOf(LlmCallError);
    expect(e.category).toBe('network');
    expect(e.message).toBe('groq llama: request failed: fetch failed (ECONNRESET)');
    expect(toLlmError(new Error('bad url https://x.test/?key=SECRETSECRET'), caps, undefined, []).message).not.toContain('SECRETSECRET');
    expect(toLlmError('string thrown', caps).category).toBe('network');
  });
});
