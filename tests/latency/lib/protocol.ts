// IPC messages between the measuring process (API role) and the BullMQ
// worker child. Timestamps are wallNow() values on the sender's clock.

/**
 * - noop: returns immediately (pure queue overhead).
 * - redis-sim: the Redis traffic worker.ts generates around a scrape, with
 *   the fetch and extraction removed (progress updates, SSE publishes,
 *   domain-strategy bookkeeping, result + cache writes, ~50 KB return value).
 * - full: worker.ts's sequence with the real SmartRouter (Tier 1 against the
 *   local fixture), real Piscina extraction and the same Redis traffic.
 */
export type ProcessorMode = 'noop' | 'redis-sim' | 'full';

export interface WorkerChildConfig {
  redisPort: number;
  queueName: string;
  mode: ProcessorMode;
  /** worker.ts: WORKER_CONCURRENCY || MAX_BROWSER_CONTEXTS || 5 */
  concurrency: number;
  /** worker.ts: BULLMQ_STALLED_INTERVAL_MS || 15000 */
  stalledInterval: number;
  /** worker.ts: BULLMQ_MAX_STALLED_COUNT || 2 */
  maxStalledCount: number;
  /** JSON size of the simulated ScrapeResult (redis-sim). */
  resultBytes: number;
  /**
   * full mode: Chromium binary for a real BrowserPool (browser tiers enabled).
   * Without it the router's browser tiers fail fast.
   */
  browserExecutablePath?: string;
}

export interface AttemptTiming {
  tier: number;
  ms: number;
  outcome: string;
}

/** Stamped by the processor and carried back inside the job's return value. */
export interface ProcessorTimes {
  start: number;
  end: number;
  /** full mode: router.route() duration, ms. */
  routeMs?: number;
  /** full mode: extractContent() duration, ms. */
  extractMs?: number;
  /** full mode: tier the router accepted. */
  tierUsed?: number;
  /** full mode: every tier the router tried, in order (StageTracer). */
  attempts?: AttemptTiming[];
}

export const TIMES_FIELD = '__latency';

export type ParentMessage =
  | { type: 'start'; config: WorkerChildConfig }
  | { type: 'ping'; id: number; t0: number }
  | { type: 'stop' };

export type ChildMessage =
  | { type: 'ready'; importMs: Record<string, number> }
  | { type: 'pong'; id: number; t0: number; t1: number }
  /** Worker 'completed' event: moveToFinished has returned on the worker side. */
  | { type: 'completed'; jobId: string; t: number }
  | { type: 'failed'; jobId: string; message: string }
  | { type: 'error'; message: string }
  | { type: 'stopped' };
