// BullMQ worker process for the queue scenarios. Mirrors apps/worker/src/
// worker.ts: same Worker options, same per-job Redis traffic (redis-sim), or
// the same processing sequence with the real router and extraction pool
// (full). worker.ts itself cannot be imported: it connects to Postgres and
// launches Chromium at import time.

import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { isCacheableResult, resultCacheKey, type ScrapeJobData, type ScrapeResult } from '@scrapeforge/shared';
import { SseEmitter } from '../../../apps/worker/src/delivery/sse-emitter.js';
import { wallNow } from './clock.js';
import { scrapeResult } from './fixtures.js';
import {
  TIMES_FIELD,
  type ChildMessage,
  type ParentMessage,
  type ProcessorTimes,
  type WorkerChildConfig,
} from './protocol.js';

type RouterModule = typeof import('../../../apps/worker/src/engine/router.js');
type PipelineModule = typeof import('../../../apps/worker/src/extraction/pipeline.js');
type ScorerModule = typeof import('../../../apps/worker/src/extraction/quality-scorer.js');
type TracingModule = typeof import('../../../apps/worker/src/tracing.js');
type BrowserPoolInstance = Awaited<ReturnType<typeof import('./browser.js')['openBrowserPool']>>;

interface FullDeps {
  router: InstanceType<RouterModule['SmartRouter']>;
  pipeline: PipelineModule;
  scorer: ScorerModule;
  tracing: TracingModule;
  browserPool?: BrowserPoolInstance;
}

type Processor = (job: Job<ScrapeJobData>) => Promise<Record<string, unknown>>;

function send(msg: ChildMessage): void {
  // After the parent disconnects, send() would emit an unhandled 'error'.
  if (process.connected) process.send?.(msg);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function timedImport<T>(importMs: Record<string, number>, name: string, load: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const mod = await load();
  importMs[name] = performance.now() - t0;
  return mod;
}

async function loadFullDeps(
  redis: Redis,
  importMs: Record<string, number>,
  browserExecutablePath: string | undefined,
): Promise<FullDeps> {
  const routerMod = await timedImport(importMs, 'router', () => import('../../../apps/worker/src/engine/router.js'));
  // Includes the esbuild bundle and Piscina pool creation (threads pre-spawned).
  const pipeline = await timedImport(importMs, 'pipeline', () => import('../../../apps/worker/src/extraction/pipeline.js'));
  const scorer = await timedImport(importMs, 'qualityScorer', () => import('../../../apps/worker/src/extraction/quality-scorer.js'));
  const tracing = await timedImport(importMs, 'tracing', () => import('../../../apps/worker/src/tracing.js'));

  let browserPool: BrowserPoolInstance | undefined;
  if (browserExecutablePath) {
    const browser = await import('./browser.js');
    const t0 = performance.now();
    browserPool = await browser.openBrowserPool(browserExecutablePath);
    importMs.browserPoolInit = performance.now() - t0;
  }
  const pool = browserPool;
  // Without a browser, T4/T5 fail fast if the router ever escalates.
  const router = new routerMod.SmartRouter(
    redis,
    pool ? () => pool.acquire() : () => Promise.reject(new Error('browser tiers are disabled in this run')),
    pool ? (ctx) => pool.release(ctx) : () => {},
  );
  return { router, pipeline, scorer, tracing, browserPool };
}

/** The Redis writes worker.ts makes after a successful scrape (cache + result). */
/**
 * worker.ts's stage 4: the shared tenant-scoped cache key, and only results
 * that may be cached (an extraction only when complete; neither processor
 * here runs one, so a job with a schema is never cached).
 */
async function storeResult(redis: Redis, job: ScrapeJobData, result: ScrapeResult | Record<string, unknown>): Promise<void> {
  const { options } = job;
  const extraction = (result.metadata as { extraction?: { status?: string } } | undefined)?.extraction;
  if (options.cacheTtl && isCacheableResult(options, extraction?.status)) {
    await redis.set(resultCacheKey(job.userId, job.url, options), JSON.stringify(result), 'EX', options.cacheTtl);
  }
  await redis.set(`result:${job.jobId}`, JSON.stringify(result), 'EX', 3600);
}

/** SmartRouter's per-request domain bookkeeping on a cache miss (GET, then GET + SET). */
async function simulateRouterBookkeeping(redis: Redis, url: string): Promise<void> {
  const key = `domain:${new URL(url).hostname}`;
  await redis.get(key);
  const existing = await redis.get(key);
  const sampleSize = existing ? (JSON.parse(existing) as { sampleSize: number }).sampleSize + 1 : 1;
  await redis.set(
    key,
    JSON.stringify({ tier: 1, proxyTier: 'datacenter', successRate: 1, avgLatencyMs: 100, sampleSize, lastUpdated: new Date().toISOString() }),
    'EX',
    86400,
  );
}

function noopProcessor(): Processor {
  return async () => {
    const start = wallNow();
    const times: ProcessorTimes = { start, end: wallNow() };
    return { [TIMES_FIELD]: times };
  };
}

function redisSimProcessor(redis: Redis, sse: SseEmitter, resultBytes: number): Processor {
  // Built once: generating 50 KB of text per job would be measured as
  // processor time that the real worker does not spend.
  const template = scrapeResult('job_template', 'https://example.com/', resultBytes);
  return async (job) => {
    const start = wallNow();
    const { jobId, url } = job.data;
    await job.updateProgress(10);
    await sse.emit(jobId, 'started', { url, jobId });
    await simulateRouterBookkeeping(redis, url); // router.route(): fetch removed
    await job.updateProgress(40);
    await sse.emitHeaders(jobId, 200, {});
    // extractContent(): removed
    await job.updateProgress(60);
    const content = template.content as { markdown: string };
    await sse.emitContent(jobId, 'markdown', content.markdown);
    await job.updateProgress(80);
    const result = { ...template, jobId, url };
    await storeResult(redis, job.data, result);
    await sse.emitComplete(jobId, result);
    await job.updateProgress(100);
    const times: ProcessorTimes = { start, end: wallNow() };
    return { ...result, [TIMES_FIELD]: times };
  };
}

// worker.ts's classification of errors that must not be retried
// (isPermanentFailure): exhausted tiers only when not all failures were transient.
const PERMANENT_ERROR = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|SSRF|OUTBOUND_BLOCKED|Blocked by SSRF guard|DNS lookup failed|private.*address/i;

function isPermanentFailure(error: unknown, message: string): boolean {
  const e = error as { code?: unknown; transient?: unknown } | null;
  if (e?.code === 'TIERS_EXHAUSTED') return e.transient !== true;
  return PERMANENT_ERROR.test(message);
}

/**
 * worker.ts's failure path: store a failed result, emit the SSE error, and
 * stop BullMQ from retrying permanent failures (otherwise attempts: 3 with
 * exponential backoff would add 1 s + 2 s of waiting to every failed job).
 */
async function failJob(redis: Redis, sse: SseEmitter, job: ScrapeJobData, error: unknown): Promise<never> {
  const message = errorMessage(error);
  const failResult: ScrapeResult = {
    jobId: job.jobId,
    url: job.url,
    status: 'failed',
    content: {},
    metadata: {
      tierUsed: 0,
      proxyTier: 'none',
      latencyMs: 0,
      cached: false,
      qualityScore: 0,
      costBreakdown: { compute: 0, proxy: 0, captcha: 0, llm: 0, total: 0 },
    },
    error: message,
  };
  await redis.set(`result:${job.jobId}`, JSON.stringify(failResult), 'EX', 3600);
  await sse.emitError(job.jobId, message);
  if (isPermanentFailure(error, message)) throw new UnrecoverableError(message);
  throw error;
}

function fullProcessor(redis: Redis, sse: SseEmitter, deps: FullDeps): Processor {
  const run = fullProcessorBody(redis, sse, deps);
  return async (job) => {
    try {
      return await run(job);
    } catch (err) {
      return failJob(redis, sse, job.data, err);
    }
  };
}

function fullProcessorBody(redis: Redis, sse: SseEmitter, deps: FullDeps): Processor {
  return async (job) => {
    const start = wallNow();
    const { jobId, url, options } = job.data;
    await job.updateProgress(10);
    await sse.emit(jobId, 'started', { url, jobId });

    const tracer = new deps.tracing.StageTracer();
    const r0 = performance.now();
    const rr = await deps.router.route(url, options, tracer);
    const routeMs = performance.now() - r0;
    const attempts = tracer.snapshot().attempts.map(({ tier, ms, outcome }) => ({ tier, ms, outcome }));
    await job.updateProgress(40);
    await sse.emitHeaders(jobId, rr.statusCode, {});

    const e0 = performance.now();
    const extracted = await deps.pipeline.extractContent(rr.html, url, options.formats || ['markdown']);
    const extractMs = performance.now() - e0;
    await job.updateProgress(60);
    const firstFormat = Object.keys(extracted)[0] as keyof typeof extracted | undefined;
    if (firstFormat) await sse.emitContent(jobId, firstFormat, String(extracted[firstFormat] || ''));
    await job.updateProgress(80);

    const quality = deps.scorer.calculateQualityScore(rr.html, rr.statusCode, rr.tierUsed, rr.latencyMs);
    const { extractionMethod, title, description, ...contentFields } = extracted;
    const result: ScrapeResult = {
      jobId,
      url,
      status: 'completed',
      statusCode: rr.statusCode,
      content: { ...contentFields, screenshot: rr.screenshot },
      metadata: {
        tierUsed: rr.tierUsed,
        proxyTier: rr.proxyTier,
        latencyMs: rr.latencyMs,
        cached: false,
        qualityScore: quality.score,
        extractionMethod: extractionMethod || 'unknown',
        title,
        description,
        costBreakdown: { compute: 0.00001, proxy: rr.proxyCost, captcha: 0, llm: 0, total: 0.00001 + rr.proxyCost },
      },
    };
    await storeResult(redis, job.data, result);
    // worker.ts also fires an un-awaited Postgres insert here; not reproduced.
    await sse.emitComplete(jobId, result as unknown as Record<string, unknown>);
    await job.updateProgress(100);

    const times: ProcessorTimes = { start, end: wallNow(), routeMs, extractMs, tierUsed: rr.tierUsed, attempts };
    return { ...result, [TIMES_FIELD]: times };
  };
}

async function start(config: WorkerChildConfig): Promise<() => Promise<void>> {
  const importMs: Record<string, number> = {};
  const connection = { host: '127.0.0.1', port: config.redisPort };
  const redis = new Redis(config.redisPort, '127.0.0.1', { maxRetriesPerRequest: null });
  const sse = new SseEmitter(redis);

  let processor: Processor;
  let deps: FullDeps | undefined;
  if (config.mode === 'noop') processor = noopProcessor();
  else if (config.mode === 'redis-sim') processor = redisSimProcessor(redis, sse, config.resultBytes);
  else {
    deps = await loadFullDeps(redis, importMs, config.browserExecutablePath);
    processor = fullProcessor(redis, sse, deps);
  }

  const worker = new Worker<ScrapeJobData>(config.queueName, processor, {
    connection,
    concurrency: config.concurrency,
    stalledInterval: config.stalledInterval,
    maxStalledCount: config.maxStalledCount,
  });
  worker.on('completed', (job) => send({ type: 'completed', jobId: String(job.id), t: wallNow() }));
  worker.on('failed', (job, err) => send({ type: 'failed', jobId: String(job?.id), message: err.message }));
  worker.on('error', (err) => send({ type: 'error', message: errorMessage(err) }));
  await worker.waitUntilReady();
  send({ type: 'ready', importMs });

  return async () => {
    await worker.close();
    await redis.quit();
    if (deps) await deps.pipeline.shutdownExtractionPool();
    await deps?.browserPool?.shutdown();
  };
}

if (!process.send) {
  console.error('worker-child must be started with an IPC channel (child_process.fork)');
  process.exit(2);
}

let stop: (() => Promise<void>) | undefined;
let stopping = false;

async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await stop?.();
  } catch (err) {
    send({ type: 'error', message: `shutdown: ${errorMessage(err)}` });
  }
  send({ type: 'stopped' });
  process.exit(code);
}

process.on('message', (msg: ParentMessage) => {
  if (msg.type === 'ping') {
    send({ type: 'pong', id: msg.id, t0: msg.t0, t1: wallNow() });
  } else if (msg.type === 'start') {
    start(msg.config).then(
      (fn) => {
        stop = fn;
      },
      (err: unknown) => {
        send({ type: 'error', message: `start: ${errorMessage(err)}` });
        void shutdown(1);
      },
    );
  } else if (msg.type === 'stop') {
    void shutdown(0);
  }
});
process.on('disconnect', () => void shutdown(0));
