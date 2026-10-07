// End-to-end checks of the harness plumbing against a throwaway redis-server:
// worker child, IPC timestamps, the producer's job options, and the 'full'
// processor wired to the real router and extraction pool.

import { createServer } from 'node:net';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { childExecArgv } from '../lib/children.js';
import { compactPage, smallPage } from '../lib/fixtures.js';
import { startFixtureServer, type FixtureServer } from '../lib/fixture-server.js';
import { PHASES } from '../lib/phases.js';
import { QueueHarness, type QueueHarnessOptions } from '../lib/queue-harness.js';
import { ensureRedis, shutdownRedis } from '../lib/redis-instance.js';
import { bullmqScriptNames, tallyCommands, withCommandLog } from '../lib/redis-monitor.js';

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

let port = 0;
let startedRedis = false;
let fixture: FixtureServer;
let admin: Redis;

beforeAll(async () => {
  port = await freePort();
  startedRedis = await ensureRedis(port);
  admin = new Redis(port, '127.0.0.1', { maxRetriesPerRequest: null });
  fixture = await startFixtureServer({ '/small': smallPage(), '/compact': compactPage() });
}, 30_000);

afterAll(async () => {
  admin?.disconnect();
  await fixture?.close();
  if (startedRedis) shutdownRedis(port);
});

function options(overrides: Partial<QueueHarnessOptions>): QueueHarnessOptions {
  return {
    redisPort: port,
    queueName: `test-${Math.random().toString(36).slice(2)}`,
    mode: 'noop',
    priority: true,
    resultBytes: 2048,
    url: 'https://example.com/',
    cacheTtl: 0,
    env: { ...process.env, SCRAPEFORGE_ALLOW_PRIVATE_NETWORK: '1' },
    ...overrides,
  };
}

describe('childExecArgv', () => {
  it('keeps an existing tsx loader and adds one otherwise', () => {
    const underTsx = ['--import', 'file:///x/node_modules/tsx/dist/loader.mjs'];
    expect(childExecArgv(underTsx)).toEqual(underTsx);
    const added = childExecArgv(['--no-warnings']);
    expect(added.slice(0, 2)).toEqual(['--no-warnings', '--import']);
    expect(added[2]).toMatch(/^file:\/\/.*tsx/);
  });
});

describe('QueueHarness', () => {
  it('measures noop round trips with consistent phases', async () => {
    const harness = await QueueHarness.open(options({}));
    try {
      expect(Math.abs(harness.clock.offsetMs)).toBeLessThan(5);
      const samples = [];
      for (let i = 0; i < 10; i++) samples.push(await harness.trip());
      const phases = await harness.phases(samples);
      for (const p of phases) {
        for (const k of PHASES) expect(Number.isFinite(p[k])).toBe(true);
        expect(p.total).toBeGreaterThan(0);
        expect(p.total).toBeGreaterThanOrEqual(p.process);
        expect(p.finalize + p.notify).toBeCloseTo(p.afterProcess, 6);
        // Timestamps from two processes: allow clock noise, not reordering.
        expect(p.pickup).toBeGreaterThan(-2);
      }
      const job = await harness.queue.getJob(samples[0].jobId);
      expect(job?.opts.priority).toBe(1);
      expect(job?.opts.attempts).toBe(3);
      expect(job?.opts.removeOnComplete).toEqual({ age: 3600 });
    } finally {
      await harness.close();
    }
  }, 60_000);

  it('omits the priority option entirely when asked', async () => {
    const harness = await QueueHarness.open(options({ priority: false }));
    try {
      const sample = await harness.trip();
      const job = await harness.queue.getJob(sample.jobId);
      expect(job?.opts.priority ?? 0).toBe(0);
    } finally {
      await harness.close();
    }
  }, 60_000);

  it('reproduces the worker Redis traffic in redis-sim mode', async () => {
    const harness = await QueueHarness.open(options({ mode: 'redis-sim', cacheTtl: 3600, resultBytes: 10_000 }));
    try {
      const { result, entries } = await withCommandLog(port, () => harness.trip());
      const stored = await admin.get(`result:${result.jobId}`);
      expect(stored).not.toBeNull();
      expect(Buffer.byteLength(stored!)).toBeGreaterThanOrEqual(10_000);
      expect(await admin.ttl(`result:${result.jobId}`)).toBeGreaterThan(3000);
      const counts = tallyCommands(entries, bullmqScriptNames());
      // A script's first use on a fresh server may go out as EVAL instead of EVALSHA.
      const scriptCalls = (name: string) => (counts.client[`evalsha ${name}`] ?? 0) + (counts.client[`eval ${name}`] ?? 0);
      expect(scriptCalls('updateProgress')).toBeGreaterThanOrEqual(5);
      expect(scriptCalls('updateProgress')).toBeLessThanOrEqual(6);
      expect(counts.client.publish).toBe(4);
      // result + cache + router domain strategy
      expect(counts.client.set).toBe(3);
      expect(scriptCalls('addPrioritizedJob')).toBeGreaterThanOrEqual(1);
    } finally {
      await harness.close();
    }
  }, 60_000);

  it('runs the real router and extraction in full mode', async () => {
    await admin.del('domain:127.0.0.1');
    const harness = await QueueHarness.open(options({ mode: 'full', url: `${fixture.baseUrl}/compact` }));
    try {
      const sample = await harness.trip();
      expect(sample.proc.tierUsed).toBe(1);
      expect(sample.proc.attempts).toEqual([expect.objectContaining({ tier: 1, outcome: 'accepted' })]);
      expect(sample.proc.extractMs).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  }, 60_000);

  it('surfaces the router escalation of the classic example.com page (browser disabled)', async () => {
    await admin.del('domain:127.0.0.1');
    const harness = await QueueHarness.open(options({ mode: 'full', url: `${fixture.baseUrl}/small` }));
    try {
      // worker.ts marks "All tiers exhausted" unrecoverable: one attempt, no backoff.
      const t0 = performance.now();
      await expect(harness.trip()).rejects.toThrow(/T1:low quality 0\.50.*T2:low quality 0\.50/);
      expect(performance.now() - t0).toBeLessThan(900);
      const [failedJob] = await harness.queue.getFailed(0, 0);
      expect(failedJob?.attemptsMade).toBe(1);
      const stored = await admin.get(`result:${failedJob?.id}`);
      expect(JSON.parse(stored ?? '{}')).toMatchObject({ status: 'failed' });
    } finally {
      await harness.close();
    }
  }, 60_000);
});
