// API request validation for outbound URLs: /v1/scrape and /v1/extract
// resolve `url` and `webhookUrl` before queueing anything.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setOutboundPolicyForTests } from '@scrapeforge/shared';
import { scrapeRoutes } from '../../../api/src/routes/scrape.js';
import { extractRoutes } from '../../../api/src/routes/extract.js';
import { useFixturePolicy } from './fixtures.js';

const queued: unknown[] = [];
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  const queue = {
    add: vi.fn(async (_name: string, data: unknown) => {
      queued.push(data);
      return {};
    }),
  };
  // Fakes for the parts of Redis/BullMQ the routes touch before queueing.
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

const SCHEMA = { title: 'string' };

describe.each([
  ['/scrape', {}],
  ['/extract', { schema: SCHEMA }],
] as const)('POST %s', (path, extra) => {
  const post = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: path, payload: { ...extra, ...body } });

  it.each([
    'http://127.0.0.2/',
    'http://0x7f.2:6379/', // 127.0.0.2 (127.0.0.1 is the fixture's "public" address)
    'http://167772161/', // 10.0.0.1
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://localhost:3000/',
    'http://internal.test/',
    'http://mixed.test/',
    'file:///etc/passwd',
  ])('rejects url %s as private', async (url) => {
    const res = await post({ url });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'URL targets a private or reserved address range.' });
    expect(queued).toHaveLength(0);
  });

  it('rejects an unresolvable url host', async () => {
    const res = await post({ url: 'http://nowhere.test/' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Could not resolve host.' });
  });

  it.each(['http://127.0.0.2:9000/hook', 'http://internal.test/hook', 'http://localhost/hook'])(
    'rejects webhookUrl %s as private',
    async (webhookUrl) => {
      const res = await post({ url: 'http://public.test/', webhookUrl });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'webhookUrl targets a private or reserved address range.' });
      expect(queued).toHaveLength(0);
    },
  );

  it('rejects an unresolvable webhookUrl host', async () => {
    const res = await post({ url: 'http://public.test/', webhookUrl: 'http://nowhere.test/hook' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Could not resolve webhookUrl host.' });
  });

  it('queues a public url with a public webhook', async () => {
    const res = await post({ url: 'http://public.test/page', webhookUrl: 'https://public.test/hook' });
    expect(res.statusCode).toBe(202);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ url: 'http://public.test/page' });
  });
});
