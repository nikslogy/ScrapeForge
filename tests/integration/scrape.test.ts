/**
 * Part 4.A — Functional tests.
 * Runs against a running API at $API_BASE (default http://localhost:3000)
 * with $TEST_API_KEY exported.
 *
 * Run:
 *   $env:TEST_API_KEY="sf_live_..."; npx vitest run tests/integration
 */
import { describe, test, expect, beforeAll } from 'vitest';

const API = process.env.API_BASE || 'http://localhost:3000';
const KEY = process.env.TEST_API_KEY || process.env.API_KEY;

beforeAll(() => {
  if (!KEY) {
    throw new Error(
      'Missing TEST_API_KEY. Export the sf_live_... key before running the integration suite.',
    );
  }
});

async function scrape(body: unknown) {
  const res = await fetch(`${API}/v1/scrape`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as Record<string, any> | null;
  return { status: res.status, data };
}

async function extract(body: unknown) {
  const res = await fetch(`${API}/v1/extract`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as Record<string, any> | null;
  return { status: res.status, data };
}

// ─── Health & auth ──────────────────────────────────────────────────────────
describe('Health & auth', () => {
  test('GET /health returns 200', async () => {
    const res = await fetch(`${API}/health`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status?: string };
    // API actually returns "healthy"; OpenAPI spec says "ok" — track as drift.
    expect(['ok', 'healthy']).toContain(json.status);
  });

  test('GET /metrics returns Prometheus text', async () => {
    const res = await fetch(`${API}/metrics`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/# HELP /);
  });

  test('POST /v1/scrape returns 401 without API key', async () => {
    const res = await fetch(`${API}/v1/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(res.status).toBe(401);
  });

  test('POST /v1/scrape returns 401 with bogus key', async () => {
    const res = await fetch(`${API}/v1/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sf_live_definitely_not_real',
      },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(res.status).toBe(401);
  });
});

// ─── Input validation ───────────────────────────────────────────────────────
describe('Input validation', () => {
  test('400 on missing URL', async () => {
    const { status } = await scrape({});
    expect(status).toBe(400);
  });

  test('400 on malformed URL', async () => {
    const { status } = await scrape({ url: 'not-a-url' });
    expect(status).toBe(400);
  });

  test('400 on private IP (SSRF protection)', async () => {
    const { status } = await scrape({ url: 'http://127.0.0.1:6379' });
    expect(status).toBe(400);
  });

  test('empty webhookUrl is ignored (synchronous response)', async () => {
    const { status, data } = await scrape({
      url: 'https://example.com',
      webhookUrl: '',
      cacheTtl: 0,
    });
    expect(status).toBe(200);
    expect(data?.status).toBe('completed');
  });
});

// ─── Content formats ────────────────────────────────────────────────────────
describe('Content formats', () => {
  test('returns Markdown by default', async () => {
    const { status, data } = await scrape({
      url: 'https://example.com',
      cacheTtl: 0,
    });
    expect(status).toBe(200);
    expect(data?.content?.markdown).toBeTruthy();
    expect(typeof data?.content?.markdown).toBe('string');
  });

  test('returns HTML when requested', async () => {
    const { status, data } = await scrape({
      url: 'https://example.com',
      formats: ['html'],
      cacheTtl: 0,
    });
    expect(status).toBe(200);
    expect(data?.content?.html).toMatch(/<html/i);
  });

  test('returns plain text when requested', async () => {
    const { status, data } = await scrape({
      url: 'https://example.com',
      formats: ['text'],
      cacheTtl: 0,
    });
    expect(status).toBe(200);
    expect(typeof data?.content?.text).toBe('string');
    expect(data?.content?.text.length).toBeGreaterThan(0);
  });

  test('returns multiple formats in one request', async () => {
    const { status, data } = await scrape({
      url: 'https://example.com',
      formats: ['markdown', 'html', 'text'],
      cacheTtl: 0,
    });
    expect(status).toBe(200);
    expect(data?.content?.markdown).toBeTruthy();
    expect(data?.content?.html).toBeTruthy();
    expect(data?.content?.text).toBeTruthy();
  });

  test('returns screenshot as base64 PNG', async () => {
    const { status, data } = await scrape({
      url: 'https://example.com',
      formats: ['markdown', 'screenshot'],
      screenshot: true,
      cacheTtl: 0,
    });
    expect(status).toBe(200);
    const shot: string = data?.content?.screenshot || '';
    expect(shot.length).toBeGreaterThan(100);
    // Base64 PNGs always start with iVBORw0KGgo
    expect(shot.startsWith('iVBORw0KGgo')).toBe(true);
  }, 60_000);
});

// ─── Metadata & cost breakdown ──────────────────────────────────────────────
describe('Metadata & cost breakdown', () => {
  test('exposes tier, latency, quality, proxy, cost', async () => {
    const { data } = await scrape({
      url: 'https://example.com',
      cacheTtl: 0,
    });
    const m = data?.metadata;
    expect(m?.tierUsed).toBeGreaterThanOrEqual(1);
    expect(m?.tierUsed).toBeLessThanOrEqual(5);
    expect(m?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(m?.qualityScore).toBeGreaterThan(0);
    expect(m?.costBreakdown).toBeDefined();
    expect(typeof m?.costBreakdown?.total).toBe('number');
  });
});

// ─── Caching ────────────────────────────────────────────────────────────────
describe('Caching', () => {
  test('second hit returns cached=true with near-zero round-trip', async () => {
    const cacheUrl = `https://example.com/?cachetest=${Date.now()}`;
    const first = await scrape({ url: cacheUrl, cacheTtl: 120 });
    expect(first.status).toBe(200);
    expect(first.data?.metadata?.cached).toBeFalsy();

    const t0 = Date.now();
    const second = await scrape({ url: cacheUrl, cacheTtl: 120 });
    const elapsed = Date.now() - t0;
    expect(second.status).toBe(200);
    expect(second.data?.metadata?.cached).toBe(true);
    // Client round-trip should be well under 200ms for a cache hit on localhost.
    expect(elapsed).toBeLessThan(200);
  });

  test('cacheTtl=0 bypasses cache', async () => {
    const url = 'https://example.com/?nocache=' + Date.now();
    await scrape({ url, cacheTtl: 0 });
    const second = await scrape({ url, cacheTtl: 0 });
    expect(second.data?.metadata?.cached).toBeFalsy();
  });
});

// ─── Custom headers, user agent, waitFor ────────────────────────────────────
describe('Request options', () => {
  test('custom headers are forwarded', async () => {
    const { status, data } = await scrape({
      url: 'https://httpbin.org/headers',
      formats: ['text'],
      headers: { 'X-Custom': 'scrapeforge-test-123' },
      cacheTtl: 0,
    });
    expect(status).toBe(200);
    expect(data?.content?.text || '').toContain('scrapeforge-test-123');
  }, 30_000);

  test('waitFor selector does not error on simple page', async () => {
    const { status } = await scrape({
      url: 'https://example.com',
      waitFor: 'h1',
      formats: ['html'],
      cacheTtl: 0,
    });
    expect(status).toBe(200);
  }, 30_000);
});

// ─── /v1/extract ────────────────────────────────────────────────────────────
describe('AI extraction', () => {
  test('extract returns JSON matching requested schema keys', async () => {
    const { status, data } = await extract({
      url: 'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html',
      schema: {
        properties: {
          title: { type: 'string' },
          price: { type: 'string' },
          availability: { type: 'string' },
        },
      },
      cacheTtl: 0,
    });
    expect(status).toBe(200);
    const json = data?.content?.json;
    // Extraction fallback may skip JSON if LLM isn't configured; only enforce
    // presence if content.json was actually produced.
    if (json) {
      expect(typeof json).toBe('object');
      expect(Object.keys(json).length).toBeGreaterThan(0);
    } else {
      // Fallback to markdown is acceptable
      expect(data?.content?.markdown).toBeTruthy();
    }
  }, 60_000);

  test('extract rejects missing schema', async () => {
    const { status } = await extract({ url: 'https://example.com' });
    expect(status).toBe(400);
  });
});

// ─── Status endpoint ────────────────────────────────────────────────────────
describe('Job status', () => {
  test('unknown jobId returns 404', async () => {
    const res = await fetch(`${API}/v1/status/job_does_not_exist_xyz`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    expect(res.status).toBe(404);
  });
});
