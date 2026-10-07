// One queue under test: a worker child plus the producer side exactly as the
// API wires it (apps/api/src/server.ts + routes/scrape.ts): a Queue and a
// QueueEvents on the same connection options, Queue.add with the route's job
// options, then job.waitUntilFinished(queueEvents, timeout).

import { randomBytes } from 'node:crypto';
import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import type { ScrapeJobData, ScrapeOptions } from '@scrapeforge/shared';
import { WorkerHandle } from './children.js';
import { wallNow, type OffsetEstimate } from './clock.js';
import { queuePhases, readProcessorTimes, type QueuePhases, type RawQueueSample } from './phases.js';
import { TIMES_FIELD, type ProcessorMode } from './protocol.js';
import { sleep } from './runner.js';

export interface QueueHarnessOptions {
  redisPort: number;
  queueName: string;
  mode: ProcessorMode;
  /** true: priority 1 as routes/scrape.ts sets for sync jobs; false: no priority option at all. */
  priority: boolean;
  resultBytes: number;
  url: string;
  cacheTtl: number;
  env: NodeJS.ProcessEnv;
  /** routes/scrape.ts passes body.timeout (default 60000). */
  waitTimeoutMs?: number;
  /** full mode: enables the browser tiers with this Chromium binary. */
  browserExecutablePath?: string;
}

export class QueueHarness {
  private constructor(
    readonly opts: QueueHarnessOptions,
    readonly worker: WorkerHandle,
    readonly queue: Queue<ScrapeJobData>,
    readonly events: QueueEvents,
    readonly clock: OffsetEstimate,
  ) {}

  static async open(opts: QueueHarnessOptions): Promise<QueueHarness> {
    const worker = WorkerHandle.spawn(opts.env);
    try {
      await worker.start({
        redisPort: opts.redisPort,
        queueName: opts.queueName,
        mode: opts.mode,
        // apps/worker/src/worker.ts defaults.
        concurrency: 5,
        stalledInterval: 15_000,
        maxStalledCount: 2,
        resultBytes: opts.resultBytes,
        browserExecutablePath: opts.browserExecutablePath,
      });
      const clock = await worker.measureClockOffset();
      // Same shape server.ts builds from REDIS_URL: host/port only.
      const connection = { host: '127.0.0.1', port: opts.redisPort };
      const queue = new Queue<ScrapeJobData>(opts.queueName, { connection });
      const events = new QueueEvents(opts.queueName, { connection });
      await queue.waitUntilReady();
      await events.waitUntilReady();
      return new QueueHarness(opts, worker, queue, events, clock);
    } catch (err) {
      await worker.stop();
      throw err;
    }
  }

  private jobData(jobId: string): { data: ScrapeJobData; opts: JobsOptions } {
    const options: ScrapeOptions & { url: string } = {
      url: this.opts.url,
      formats: ['markdown'],
      timeout: 60_000,
      proxy: 'auto',
      screenshot: false,
      mobile: false,
      blockResources: true,
      cacheTtl: this.opts.cacheTtl,
    };
    const data: ScrapeJobData = {
      jobId,
      userId: 'latency-user',
      apiKeyId: 'latency-key',
      url: this.opts.url,
      options,
      priority: 1,
      createdAt: new Date().toISOString(),
    };
    const opts: JobsOptions = {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
      ...(this.opts.priority ? { priority: 1 } : {}),
    };
    return { data, opts };
  }

  /** One API-style request: enqueue, then wait for the result. */
  async trip(): Promise<RawQueueSample> {
    const jobId = `job_${randomBytes(12).toString('base64url')}`;
    const { data, opts } = this.jobData(jobId);
    const addStart = wallNow();
    const job = await this.queue.add(jobId, data, opts);
    const addEnd = wallNow();
    const returnValue: unknown = await job.waitUntilFinished(this.events, this.opts.waitTimeoutMs ?? 60_000);
    const resolved = wallNow();
    return { jobId, addStart, addEnd, resolved, proc: readProcessorTimes(returnValue, TIMES_FIELD) };
  }

  /**
   * Phase split for finished samples. Waits briefly first: the worker's
   * 'completed' IPC message can arrive after the producer already resolved.
   */
  async phases(samples: readonly RawQueueSample[]): Promise<QueuePhases[]> {
    for (let i = 0; i < 20 && samples.some((s) => !this.worker.completedAt.has(s.jobId)); i++) {
      await sleep(50);
    }
    return samples.map((s) => queuePhases(s, this.clock.offsetMs, this.worker.completedAt.get(s.jobId)));
  }

  async close(): Promise<void> {
    await this.events.close();
    // Drop this run's jobs so later scenarios start from the same Redis state.
    await this.queue.obliterate({ force: true }).catch(() => {});
    await this.queue.close();
    await this.worker.stop();
  }
}
