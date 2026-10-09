// The latency harness's worker child must write the result cache the way
// worker.ts does: under the shared resultCacheKey (tenant, credentials,
// schema, spend cap, fetch-shaping options) and only when the result may be
// cached (an extraction only when complete). Otherwise the queue scenarios
// measure Redis traffic, and serve cache entries, that production never would.

import { createServer } from 'node:net';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCacheKey, resultCacheKey, type ScrapeJobData, type ScrapeOptions } from '@scrapeforge/shared';
import { WorkerHandle } from '../../../../tests/latency/lib/children.js';
import { ensureRedis, shutdownRedis } from '../../../../tests/latency/lib/redis-instance.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

const QUEUE = `glue-cache-${Math.random().toString(36).slice(2)}`;
let port = 0;
let startedRedis = false;
let admin: Redis;
let queue: Queue<ScrapeJobData>;
let worker: WorkerHandle;

beforeAll(async () => {
  port = await freePort();
  startedRedis = await ensureRedis(port);
  admin = new Redis(port, '127.0.0.1', { maxRetriesPerRequest: null });
  queue = new Queue<ScrapeJobData>(QUEUE, { connection: { host: '127.0.0.1', port } });
  worker = WorkerHandle.spawn({ ...process.env });
  await worker.start({ redisPort: port, queueName: QUEUE, mode: 'redis-sim', concurrency: 2, stalledInterval: 15_000, maxStalledCount: 2, resultBytes: 1024 });
}, 60_000);

afterAll(async () => {
  await worker?.stop();
  await queue?.close();
  admin?.disconnect();
  if (startedRedis) shutdownRedis(port);
});

let seq = 0;
async function runJob(userId: string, url: string, options: ScrapeOptions): Promise<void> {
  const jobId = `job_${++seq}`;
  const data: ScrapeJobData = { jobId, userId, apiKeyId: 'k1', url, options, priority: 2, createdAt: new Date().toISOString() };
  await queue.add('scrape', data, { jobId });
  const until = Date.now() + 20_000;
  while (!worker.completedAt.has(jobId)) {
    if (Date.now() > until) throw new Error(`${jobId} did not complete; failures: ${JSON.stringify(worker.failures)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('latency worker child: result cache', () => {
  it('caches a plain scrape under the shared, tenant-scoped key', async () => {
    const url = 'https://example.com/a';
    const options: ScrapeOptions = { formats: ['markdown'], cacheTtl: 60, headers: { Authorization: 'Bearer t' } };
    await runJob('tenant-a', url, options);
    expect(await admin.exists(resultCacheKey('tenant-a', url, options))).toBe(1);
    // Not under the old key that ignored tenant and credentials.
    expect(await admin.exists(`cache:${createCacheKey(url, { formats: options.formats, proxy: options.proxy, extractSchema: options.extractSchema })}`)).toBe(0);
    expect(await admin.exists(resultCacheKey('tenant-b', url, options))).toBe(0);
  });

  it('does not cache an extraction that is not complete', async () => {
    const url = 'https://example.com/b';
    const options: ScrapeOptions = { formats: ['markdown'], cacheTtl: 60, extractSchema: { type: 'object', properties: { title: { type: 'string' } } } };
    await runJob('tenant-a', url, options);
    expect(await admin.exists(resultCacheKey('tenant-a', url, options))).toBe(0);
    expect(await admin.keys('cache:*')).toEqual([resultCacheKey('tenant-a', 'https://example.com/a', { formats: ['markdown'], cacheTtl: 60, headers: { Authorization: 'Bearer t' } })]);
  });
});
