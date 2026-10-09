// Result cache round trip: the API route reads `cache:*`, queues the job, the
// real worker processor (worker.ts, with its I/O dependencies stubbed) runs
// the real extraction engine and writes the cache, and the next request reads
// it back. Checks what may be cached and who may read it.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setOutboundPolicyForTests, type ScrapeJobData } from '@scrapeforge/shared';
import type { FakeHandler } from '../../src/extract/llm/index.js';
import { useFixturePolicy } from '../net/fixtures.js';

const h = vi.hoisted(() => {
  const kv = new Map<string, string>();
  const state = {
    kv,
    html: '',
    model: null as null | ((caps: unknown, req: unknown) => unknown),
    processors: [] as Array<(job: unknown) => Promise<unknown>>,
  };
  return state;
});

vi.mock('ioredis', () => ({
  Redis: class {
    async get(key: string) {
      return h.kv.get(key) ?? null;
    }
    async set(key: string, value: string) {
      h.kv.set(key, value);
      return 'OK';
    }
    async del(key: string) {
      return h.kv.delete(key) ? 1 : 0;
    }
    async quit() {}
  },
}));
vi.mock('pg', () => ({
  Pool: class {
    async query() {
      return { rows: [] };
    }
    async end() {}
  },
}));
vi.mock('bullmq', () => ({
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
      h.processors.push(processor);
    }
    on() {}
    async close() {}
  },
  UnrecoverableError: class extends Error {},
}));
vi.mock('../../src/browser/pool.js', () => ({
  BrowserPool: class {
    async initialize() {}
    async acquire() {
      throw new Error('no browser in this test');
    }
    release() {}
    async shutdown() {}
  },
}));
vi.mock('../../src/engine/router.js', () => ({
  SmartRouter: class {
    async route() {
      return { html: h.html, statusCode: 200, tierUsed: 1, proxyTier: 'none', latencyMs: 5, proxyCost: 0 };
    }
    async drainStrategyWrites() {}
  },
}));
vi.mock('../../src/extraction/pipeline.js', () => ({
  extractContent: async () => ({ markdown: '# page', extractionMethod: 'test', title: 'Page' }),
}));
vi.mock('../../src/delivery/webhook.js', () => ({ deliverWebhook: async () => undefined }));
vi.mock('../../src/delivery/sse-emitter.js', () => ({
  SseEmitter: class {
    async emit() {}
    async emitHeaders() {}
    async emitContent() {}
    async emitExtraction() {}
    async emitComplete() {}
    async emitError() {}
  },
}));
vi.mock('../../src/metrics.js', () => {
  const metric = { inc() {}, observe() {}, set() {} };
  return {
    scrapeRequestsTotal: metric,
    scrapeDuration: metric,
    scrapeCost: metric,
    browserPoolSize: metric,
    llmCostTotal: metric,
    observeStages() {},
    observeTierAttempts() {},
    startMetricsServer() {},
  };
});
vi.mock('../../src/extract/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/extract/index.js')>();
  const { fakeClient } = await import('../engine/helpers.js');
  const { client } = fakeClient(((caps, req) => {
    if (!h.model) throw new Error('unexpected model call');
    return h.model(caps, req);
  }) as FakeHandler);
  return { ...orig, createDefaultModelClient: () => client };
});

const { JSONLD_PRODUCT, PLAIN_PRODUCT, blockId } = await import('../engine/helpers.js');
const { extractRoutes } = await import('../../../api/src/routes/extract.js');
const { scrapeRoutes } = await import('../../../api/src/routes/scrape.js');

const URL_ = 'http://public.test/product';
const DESCRIPTION = 'The Acme Turbo Widget spins at 3,000 rpm and ships with a two-year warranty for home workshops.';
const SCHEMA = { name: 'string', price: 'number', description: 'string — product description' };

let app: FastifyInstance;
let currentUser = 'tenant-a';
let jobsRun = 0;

beforeAll(async () => {
  await import('../../src/worker.js');
  expect(h.processors.length).toBeGreaterThan(0);
  const processor = h.processors[0];
  app = Fastify();
  const queue = {
    add: async (_name: string, data: ScrapeJobData) => ({
      waitUntilFinished: async () => {
        jobsRun++;
        return processor({ data, updateProgress: async () => undefined });
      },
    }),
  };
  app.decorate('redis', { get: async (key: string) => h.kv.get(key) ?? null } as never);
  app.decorate('queues', { realtime: queue, standard: queue } as never);
  app.decorate('queueEvents', { realtime: {} } as never);
  app.addHook('onRequest', async (request) => {
    (request as unknown as { user: unknown }).user = { userId: currentUser, apiKeyId: `key-${currentUser}` };
  });
  await app.register(scrapeRoutes);
  await app.register(extractRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  const { flushRecipeLearning } = await import('../../src/extract/index.js');
  await flushRecipeLearning();
});

beforeEach(() => {
  useFixturePolicy();
  h.kv.clear();
  h.html = JSONLD_PRODUCT;
  h.model = null;
  currentUser = 'tenant-a';
  jobsRun = 0;
});

afterEach(() => setOutboundPolicyForTests(null));

/** A model that answers the description from its block (name and price come from JSON-LD). */
function describingModel(): FakeHandler {
  const b = blockId(JSONLD_PRODUCT, DESCRIPTION, URL_);
  return () => ({
    text: JSON.stringify({ records: [{ description: { v: DESCRIPTION, b } }] }),
    finishReason: 'stop',
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.0001,
    latencyMs: 1,
  });
}

function cacheKeys(): string[] {
  return [...h.kv.keys()].filter((k) => k.startsWith('cache:'));
}

async function post(path: '/extract' | '/scrape', body: Record<string, unknown>, user = currentUser) {
  currentUser = user;
  const res = await app.inject({ method: 'POST', url: path, payload: { url: URL_, ...body } });
  expect(res.statusCode).toBe(200);
  return res.json() as { metadata: { cached: boolean; extraction?: { status: string } } };
}

describe('result cache', () => {
  it('does not cache a partial extraction (spend cap 0 leaves a field to the model)', async () => {
    const first = await post('/extract', { schema: SCHEMA, maxLlmCostUsd: 0 });
    expect(first.metadata.extraction?.status).toBe('partial');
    expect(cacheKeys()).toEqual([]);

    // A later request with a budget is not served the degraded result.
    h.model = describingModel() as never;
    const second = await post('/extract', { schema: SCHEMA, maxLlmCostUsd: 0.05 });
    expect(second.metadata.cached).toBe(false);
    expect(second.metadata.extraction?.status).toBe('complete');
    expect(jobsRun).toBe(2);
  });

  it('does not cache a failed extraction', async () => {
    h.html = PLAIN_PRODUCT;
    const res = await post('/extract', { schema: { colour: 'string — colour name' }, maxLlmCostUsd: 0 });
    expect(res.metadata.extraction?.status).toBe('failed');
    expect(cacheKeys()).toEqual([]);
  });

  it('caches a complete extraction and serves it to the same tenant only', async () => {
    h.model = describingModel() as never;
    const first = await post('/extract', { schema: SCHEMA });
    expect(first.metadata.extraction?.status).toBe('complete');
    expect(cacheKeys()).toHaveLength(1);

    const again = await post('/extract', { schema: SCHEMA });
    expect(again.metadata.cached).toBe(true);
    expect(jobsRun).toBe(1);

    const other = await post('/extract', { schema: SCHEMA }, 'tenant-b');
    expect(other.metadata.cached).toBe(false);
    expect(jobsRun).toBe(2);
  });

  it('keys extraction results by the spend cap', async () => {
    h.model = describingModel() as never;
    await post('/extract', { schema: SCHEMA, maxLlmCostUsd: 0.05 });
    expect((await post('/extract', { schema: SCHEMA, maxLlmCostUsd: 0.05 })).metadata.cached).toBe(true);
    expect((await post('/extract', { schema: SCHEMA, maxLlmCostUsd: 0.01 })).metadata.cached).toBe(false);
    expect((await post('/extract', { schema: SCHEMA })).metadata.cached).toBe(false);
  });

  it('still caches plain scrapes, scoped to the tenant', async () => {
    await post('/scrape', { formats: ['markdown'] });
    expect(cacheKeys()).toHaveLength(1);
    expect((await post('/scrape', { formats: ['markdown'] })).metadata.cached).toBe(true);
    expect((await post('/scrape', { formats: ['markdown'] }, 'tenant-b')).metadata.cached).toBe(false);
    // An empty extractSchema is a plain scrape.
    expect((await post('/scrape', { formats: ['markdown'], extractSchema: {} }, 'tenant-b')).metadata.cached).toBe(false);
  });

  it('/scrape with a schema follows the extraction rules and shares nothing with /extract of another tenant', async () => {
    await post('/scrape', { formats: ['markdown'], extractSchema: SCHEMA, maxLlmCostUsd: 0 });
    expect(cacheKeys()).toEqual([]);
    h.model = describingModel() as never;
    await post('/scrape', { formats: ['markdown'], extractSchema: SCHEMA });
    expect(cacheKeys()).toHaveLength(1);
    expect((await post('/scrape', { formats: ['markdown'], extractSchema: SCHEMA })).metadata.cached).toBe(true);
  });

  it('keys results by custom headers and cookies (they may carry credentials)', async () => {
    const auth = { headers: { Authorization: 'Bearer secret-a', 'Accept-Language': 'en' }, cookies: [{ name: 'sid', value: 'abc' }] };
    await post('/scrape', { formats: ['markdown'], ...auth });
    expect(cacheKeys()).toHaveLength(1);
    // The key never contains the credentials themselves.
    expect(cacheKeys()[0]).not.toMatch(/secret|abc/);

    // Same credentials (header names in another case and order): hit.
    const same = { headers: { 'accept-language': 'en', authorization: 'Bearer secret-a' }, cookies: [{ name: 'sid', value: 'abc' }] };
    expect((await post('/scrape', { formats: ['markdown'], ...same })).metadata.cached).toBe(true);

    // No credentials, other credentials, or another tenant with the same ones: miss.
    expect((await post('/scrape', { formats: ['markdown'] })).metadata.cached).toBe(false);
    expect((await post('/scrape', { formats: ['markdown'], ...auth, cookies: [{ name: 'sid', value: 'xyz' }] })).metadata.cached).toBe(false);
    expect((await post('/scrape', { formats: ['markdown'], ...auth, headers: { Authorization: 'Bearer secret-b' } })).metadata.cached).toBe(false);
    expect((await post('/scrape', { formats: ['markdown'], ...auth }, 'tenant-b')).metadata.cached).toBe(false);
  });
});
