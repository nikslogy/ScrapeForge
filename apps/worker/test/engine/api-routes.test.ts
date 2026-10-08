// API side of the extraction engine: request options, schema limits and
// queue retry policy of /v1/extract and /v1/scrape.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setOutboundPolicyForTests } from '@scrapeforge/shared';
import { extractRoutes, jobRetryOptions, MAX_SCHEMA_BYTES, schemaDepth, schemaLimitIssue } from '../../../api/src/routes/extract.js';
import { scrapeRoutes } from '../../../api/src/routes/scrape.js';
import { normalizeSchema } from '../../src/extract/schema/index.js';
import { useFixturePolicy } from '../net/fixtures.js';

interface Queued {
  data: { options: Record<string, unknown> };
  opts: Record<string, unknown>;
}

const queued: Queued[] = [];
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  const queue = {
    add: vi.fn(async (_name: string, data: unknown, opts: unknown) => {
      queued.push({ data: data as Queued['data'], opts: opts as Record<string, unknown> });
      // Sync callers wait on the job: finish it at once with a stub result.
      return { waitUntilFinished: async () => ({ status: 'completed', echo: (data as Queued['data']).options }) };
    }),
  };
  app.decorate('redis', { get: async () => null } as never);
  app.decorate('queues', { realtime: queue, standard: queue } as never);
  app.decorate('queueEvents', { realtime: {} } as never);
  app.addHook('onRequest', async (request) => {
    (request as unknown as { user: unknown }).user = { userId: 'u1', apiKeyId: 'k1' };
  });
  await app.register(scrapeRoutes);
  await app.register(extractRoutes);
  await app.ready();
});

afterAll(() => app.close());

beforeEach(() => {
  useFixturePolicy();
  queued.length = 0;
});

afterEach(() => setOutboundPolicyForTests(null));

function nested(levels: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < levels; i++) schema = { type: 'object', properties: { child: schema } };
  return schema;
}

describe('schema limits', () => {
  it('counts schema levels, not JSON levels', () => {
    expect(schemaDepth({ title: 'string' })).toBe(0);
    expect(schemaDepth({ type: 'object', properties: { a: { type: 'string' } } })).toBe(1);
    expect(schemaDepth({ type: 'array', items: { type: 'object', properties: { a: { type: 'string', enum: [[[[1]]]] } } } })).toBe(2);
    expect(schemaDepth(nested(10))).toBe(10);
    expect(schemaDepth(nested(11))).toBe(11);
    // Pathological array nesting is bounded without recursion.
    let deep: unknown = 'x';
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(schemaDepth({ a: deep })).toBe(Number.POSITIVE_INFINITY);
  });

  it('agrees with the worker: what passes here at the limit is accepted there', () => {
    expect(() => normalizeSchema(nested(9))).not.toThrow();
    expect(schemaLimitIssue(nested(9))).toBeNull();
    expect(schemaLimitIssue(nested(11))).toMatch(/deeper than 10/);
    expect(() => normalizeSchema(nested(11))).toThrow(/nesting/);
  });

  it('rejects schemas over 64 KB', () => {
    const big = { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(MAX_SCHEMA_BYTES) } } };
    expect(schemaLimitIssue(big)).toMatch(/larger than 65536 bytes/);
    expect(schemaLimitIssue({ a: 'string' })).toBeNull();
  });
});

describe.each([
  ['/extract', 'schema'],
  ['/scrape', 'extractSchema'],
] as const)('POST %s', (path, schemaKey) => {
  const post = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: path, payload: { url: 'http://public.test/page', [schemaKey]: { title: 'string' }, ...body } });

  it('rejects a too-deep or too-large schema with 400 before queueing', async () => {
    for (const schema of [nested(12), { a: { type: 'string', description: 'y'.repeat(70_000) } }]) {
      const res = await post({ [schemaKey]: schema });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Validation failed');
      expect(JSON.stringify(res.json().details)).toMatch(/deeper than 10|larger than 65536/);
    }
    expect(queued).toHaveLength(0);
  });

  it('passes includeEvidence (default false) and maxLlmCostUsd (0..1) to the worker', async () => {
    const res = await post({ includeEvidence: true, maxLlmCostUsd: 0.02, webhookUrl: 'https://public.test/hook' });
    expect(res.statusCode).toBe(202);
    expect(queued[0].data.options).toMatchObject({ includeEvidence: true, maxLlmCostUsd: 0.02 });

    await post({ webhookUrl: 'https://public.test/hook' });
    expect(queued[1].data.options.includeEvidence).toBe(false);
    expect(queued[1].data.options.maxLlmCostUsd).toBeUndefined();

    for (const bad of [{ maxLlmCostUsd: 2 }, { maxLlmCostUsd: -0.1 }, { includeEvidence: 'yes' }]) {
      expect((await post(bad)).statusCode).toBe(400);
    }
  });

  it('retries sync jobs once quickly and webhook jobs with backoff', async () => {
    const sync = await post({});
    expect(sync.statusCode).toBe(200);
    expect(queued[0].opts).toMatchObject({ attempts: 2, backoff: { type: 'fixed', delay: 250 } });
    await post({ webhookUrl: 'https://public.test/hook' });
    expect(queued[1].opts).toMatchObject({ attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
  });
});

describe('jobRetryOptions', () => {
  it('is the documented policy', () => {
    expect(jobRetryOptions(true)).toEqual({ attempts: 2, backoff: { type: 'fixed', delay: 250 } });
    expect(jobRetryOptions(false)).toEqual({ attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
  });
});
