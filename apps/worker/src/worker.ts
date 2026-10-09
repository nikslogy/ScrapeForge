import { AsyncLocalStorage } from 'node:async_hooks';
import { Worker, Job, UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import type { BrowserContext } from 'patchright';
import { Pool } from 'pg';
import {
  ScrapeJobData,
  ScrapeResult,
  QUEUE_NAMES,
  isCacheableResult,
  resultCacheKey,
  type ExtractionMetadata,
  type ScrapeOptions,
} from '@scrapeforge/shared';
import { SmartRouter } from './engine/router.js';
import { BrowserPool } from './browser/pool.js';
import { extractContent } from './extraction/pipeline.js';
import { calculateQualityScore } from './extraction/quality-scorer.js';
import {
  blockedFromQualitySignals,
  createDefaultModelClient,
  extractStructured,
  flushRecipeLearning,
  RecipeStore,
  type ExtractionOutcome,
  type ModelClient,
} from './extract/index.js';
import { deliverWebhook } from './delivery/webhook.js';
import { SseEmitter } from './delivery/sse-emitter.js';
import {
  scrapeRequestsTotal,
  scrapeDuration,
  scrapeCost,
  browserPoolSize,
  llmCostTotal,
  observeStages,
  observeTierAttempts,
  startMetricsServer,
} from './metrics.js';
import { StageTracer } from './tracing.js';

// --- Connections ---
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

const pg = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgres://scrapeforge:localdev123@localhost:5433/scrapeforge',
});

function parseBullConnection(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379'),
    password: parsed.password || undefined,
  };
}
const bullConnection = parseBullConnection(redisUrl);

// --- Browser Pool ---
const browserPool = new BrowserPool(
  parseInt(process.env.MAX_BROWSER_CONTEXTS || '5'),
  100,
  30 * 60 * 1000,
);
await browserPool.initialize();

// --- Job deadline ---
//
// Every job ends by options.timeout plus a small margin, whatever the router
// does: it gives each browser tier the full timeout (T1 + T2 + 2 × timeout
// for a page that hangs the browser). Past the deadline the job fails at once
// and what can be stopped is stopped: the content extraction is aborted, the
// pages of the job's browser contexts are closed (the tier fetch then fails
// and its context goes back to the pool), and no further context is handed
// to the job. Structured extraction stops at its own deadline (before
// options.timeout). The HTTP tiers end on their own timeouts.

// Leaves room for structured extraction, which may finish a recipe run up to
// ~1 s past its own deadline.
const JOB_DEADLINE_MARGIN_MS = 2_000;

class JobTimeoutError extends Error {
  readonly code = 'JOB_TIMEOUT' as const;

  constructor(timeoutMs: number, stage: string) {
    super(`Timeout: job timed out after ${timeoutMs} ms (+${JOB_DEADLINE_MARGIN_MS} ms margin) during ${stage}`);
    this.name = 'JobTimeoutError';
  }
}

interface JobScope {
  signal: AbortSignal;
  /** Browser contexts the job's router call holds right now. */
  contexts: Set<BrowserContext>;
}

// The router runs inside its job's scope, so the context callbacks below
// know which job asks (AsyncLocalStorage follows the router's awaits).
const jobScopes = new AsyncLocalStorage<JobScope>();

function acquireForJob(): Promise<BrowserContext> {
  const scope = jobScopes.getStore();
  if (!scope) return browserPool.acquire();
  const { signal } = scope;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<BrowserContext>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    browserPool.acquire().then(
      (ctx) => {
        signal.removeEventListener('abort', onAbort);
        // Granted after the job gave up waiting: straight back to the pool.
        if (signal.aborted) return browserPool.release(ctx);
        scope.contexts.add(ctx);
        resolve(ctx);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function releaseForJob(ctx: BrowserContext): void {
  jobScopes.getStore()?.contexts.delete(ctx);
  browserPool.release(ctx);
}

/** Ends what the job's browser contexts are doing; the tier fetch then releases them. */
function closeJobPages(scope: JobScope): void {
  for (const ctx of scope.contexts) {
    let pages: { close(): Promise<void> }[] = [];
    try {
      pages = ctx.pages();
    } catch {
      /* context already closed */
    }
    for (const page of pages) void page.close().catch(() => {});
  }
}

/** `work`, or a rejection with the deadline error as soon as `signal` aborts. */
function beforeDeadline<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  // Whatever `work` does after the deadline must not become an unhandled rejection.
  work.catch(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

// --- Smart Router ---
const router = new SmartRouter(redis, acquireForJob, releaseForJob);

// --- Structured extraction engine + SSE ---
// One model client per process (its circuit breaker is process-wide). Its
// configuration warnings are logged once; they never contain API keys.
let modelClient: ModelClient | null = null;
try {
  modelClient = createDefaultModelClient(process.env);
  for (const w of modelClient.warnings) console.warn(`[extract] ${w}`);
  console.log(`[extract] models: ${modelClient.models.map((m) => m.key).join(', ') || 'none (schema extraction limited to structured data and recipes)'}`);
} catch (err) {
  console.error(`[extract] model client disabled: ${(err as Error).message}`);
}

// Recipes live in the worker's Redis (keys recipe:v1:*, 14-day TTL).
const recipeStore = new RecipeStore({
  get: (key) => redis.get(key),
  set: (key, value, mode, ttlSec) => redis.set(key, value, mode, ttlSec),
  del: (key) => redis.del(key),
});

const DEFAULT_MAX_LLM_COST_USD = 0.05;
const MAX_LLM_COST_USD = (() => {
  const raw = process.env.EXTRACT_MAX_COST_USD;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_LLM_COST_USD;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0) return value;
  console.warn(`[extract] EXTRACT_MAX_COST_USD is not a non-negative number; using ${DEFAULT_MAX_LLM_COST_USD}`);
  return DEFAULT_MAX_LLM_COST_USD;
})();

// The extraction deadline leaves this much of the job timeout for writing
// and delivering the result.
const DEADLINE_SAFETY_MARGIN_MS = 2_000;

const sseEmitter = new SseEmitter(redis);

// --- Cost lookup (compute only, proxy cost comes from router) ---
const TIER_COMPUTE_COST: Record<number, number> = {
  1: 0.000_01,
  2: 0.000_02,
  3: 0.000_10,
  4: 0.000_50,
  5: 0.000_80,
};

// --- Extraction helpers ---

function extractionMetadata(outcome: ExtractionOutcome, includeEvidence: boolean): ExtractionMetadata {
  const models = [...new Set(outcome.llm.attempts.map((a) => a.resolvedModel ?? `${a.provider}:${a.model}`))];
  const meta: ExtractionMetadata = {
    status: outcome.status,
    method: outcome.method,
    schemaValid: outcome.schemaValid,
    missing: outcome.missing,
    warnings: outcome.warnings,
    scope: outcome.scope,
    llm: {
      calls: outcome.llm.calls,
      inputTokens: outcome.llm.inputTokens,
      outputTokens: outcome.llm.outputTokens,
      costUsd: outcome.llm.costUsd,
      models,
    },
  };
  if (outcome.schemaErrors) meta.schemaErrors = outcome.schemaErrors;
  if (includeEvidence) meta.evidence = outcome.evidence;
  return meta;
}

/** Metadata for an engine crash (a bug, never a page or model problem). */
function engineErrorMetadata(url: string): ExtractionMetadata {
  return {
    status: 'failed',
    method: 'none',
    schemaValid: false,
    missing: [],
    warnings: ['engine_error'],
    scope: { url, snapshotHash: '', description: 'page-snapshot', blocksTotal: 0, blocksSentToModel: 0, recordsDetected: 0, truncated: false },
    llm: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, models: [] },
  };
}

function wantsExtraction(options: ScrapeOptions): options is ScrapeOptions & { extractSchema: Record<string, unknown> } {
  return Boolean(options.extractSchema) && Object.keys(options.extractSchema as object).length > 0;
}

function llmSpendCap(options: ScrapeOptions): number {
  const requested = options.maxLlmCostUsd;
  return typeof requested === 'number' && Number.isFinite(requested) && requested >= 0
    ? Math.min(requested, MAX_LLM_COST_USD)
    : MAX_LLM_COST_USD;
}

/**
 * Failures a retry cannot fix: bad hosts, blocked (private) destinations,
 * and exhausted tiers when some tier got a block or unusable page. Tiers that
 * all failed transiently (target briefly down, timeouts, rate limits) are
 * retried, as is a missed job deadline. The router's TiersExhaustedError is
 * matched by its code, like the pool error, so another module copy counts.
 */
function isPermanentFailure(error: unknown, message: string): boolean {
  const e = error as { code?: unknown; transient?: unknown } | null;
  if (e?.code === 'TIERS_EXHAUSTED') return e.transient !== true;
  return /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|SSRF|OUTBOUND_BLOCKED|Blocked by SSRF guard|DNS lookup failed|private.*address/i.test(
    message,
  );
}

// --- Job Processor ---
async function processScrapeJob(job: Job<ScrapeJobData>): Promise<ScrapeResult> {
  const { jobId, url, options, userId, apiKeyId } = job.data;
  const jobStart = Date.now();
  const tracer = new StageTracer();
  const timeoutMs = options.timeout ?? 60_000;

  console.log(`[${jobId}] Processing: ${url}`);
  await job.updateProgress(10);
  await sseEmitter.emit(jobId, 'started', { url, jobId });

  // Fetch + content + structured extraction end by timeout + margin.
  const deadline = new AbortController();
  const scope: JobScope = { signal: deadline.signal, contexts: new Set() };
  let stage = 'fetch';
  const deadlineTimer = setTimeout(() => {
    deadline.abort(new JobTimeoutError(timeoutMs, stage));
    closeJobPages(scope);
  }, Math.max(0, jobStart + timeoutMs + JOB_DEADLINE_MARGIN_MS - Date.now()));

  try {
    // ── Stage 1: Scrape ────────────────────────────────
    const rr = await tracer.time('fetch', () =>
      beforeDeadline(deadline.signal, jobScopes.run(scope, () => router.route(url, options, tracer))),
    );
    stage = 'content and structured extraction';
    await job.updateProgress(40);
    await sseEmitter.emitHeaders(jobId, rr.statusCode, {});

    // Quality first: the extraction engine needs to know about block pages.
    const quality = calculateQualityScore(
      rr.html,
      rr.statusCode,
      rr.tierUsed,
      rr.latencyMs,
    );

    // ── Stage 2: content + structured extraction (both only need rr.html) ──
    const deadlineMs = jobStart + timeoutMs - Math.min(DEADLINE_SAFETY_MARGIN_MS, timeoutMs * 0.1);
    const includeEvidence = options.includeEvidence === true;
    const sourceBlocked = blockedFromQualitySignals(quality, rr.statusCode);

    const [extracted, outcome] = await beforeDeadline(deadline.signal, Promise.all([
      tracer.time('content', () =>
        extractContent(rr.html, url, options.formats || ['markdown'], { signal: deadline.signal }),
      ),
      wantsExtraction(options)
        ? tracer.time('extract', async (): Promise<ExtractionOutcome | null> => {
            try {
              return await extractStructured(
                {
                  html: rr.html,
                  url,
                  schema: options.extractSchema,
                  // Recipes are scoped per customer; jobs always carry a userId from auth.
                  tenantId: userId || 'anonymous',
                  deadlineMs,
                  maxCostUsd: llmSpendCap(options),
                  includeEvidence,
                },
                { modelClient, recipeStore, tracer, ...(sourceBlocked ? { sourceBlocked } : {}) },
              );
            } catch (err) {
              console.error(`[${jobId}] Extraction engine error:`, (err as Error).message);
              return null;
            }
          })
        : Promise.resolve(null),
    ]));
    clearTimeout(deadlineTimer);
    await job.updateProgress(80);

    const firstFormat = Object.keys(extracted)[0] as string | undefined;
    if (firstFormat) {
      await sseEmitter.emitContent(jobId, firstFormat, String((extracted as any)[firstFormat] || ''));
    }

    let extraction: ExtractionMetadata | undefined;
    const llmCost = outcome?.llm.costUsd ?? 0;
    if (wantsExtraction(options)) {
      if (outcome) {
        extraction = extractionMetadata(outcome, includeEvidence);
        if (outcome.data !== null) {
          extracted.json = outcome.data;
          await sseEmitter.emitExtraction(jobId, outcome.data);
        }
        console.log(
          `[${jobId}] Extraction ${outcome.status} via ${outcome.method}: ${outcome.llm.calls} model call(s), $${llmCost.toFixed(6)}`,
        );
      } else {
        extraction = engineErrorMetadata(url);
      }
    }

    // ── Stage 3: cost ──────────────────────────────────
    const computeCost = TIER_COMPUTE_COST[rr.tierUsed] ?? 0.0005;
    const totalCost = computeCost + rr.proxyCost + llmCost;

    const {
      extractionMethod,
      title: extractedTitle,
      description: extractedDescription,
      ...contentFields
    } = extracted;

    const trace = tracer.snapshot();
    const result: ScrapeResult = {
      jobId,
      url,
      status: 'completed',
      statusCode: rr.statusCode,
      content: {
        ...contentFields,
        screenshot: rr.screenshot,
      },
      metadata: {
        tierUsed: rr.tierUsed,
        proxyTier: rr.proxyTier,
        latencyMs: rr.latencyMs,
        cached: false,
        qualityScore: quality.score,
        extractionMethod: extractionMethod || 'unknown',
        title: extractedTitle,
        description: extractedDescription,
        costBreakdown: {
          compute: computeCost,
          proxy: rr.proxyCost,
          captcha: 0,
          llm: llmCost,
          total: totalCost,
        },
        ...(extraction ? { extraction } : {}),
        timings: { stages: trace.stages, attempts: trace.attempts, totalMs: trace.totalMs },
      },
    };

    // ── Stage 4: Cache + persist ───────────────────────
    //
    // Same key as the API's cache read (resultCacheKey: tenant, credentials,
    // schema, spend cap...). Only complete extractions are cached: a partial
    // or failed one may come from this request's limits or a transient
    // provider problem and would be served for the whole cacheTtl.
    if (options.cacheTtl && isCacheableResult(options, extraction?.status)) {
      await redis.set(resultCacheKey(userId, url, options), JSON.stringify(result), 'EX', options.cacheTtl);
    }

    await redis.set(`result:${jobId}`, JSON.stringify(result), 'EX', 3600);

    logRequest(pg, {
      userId,
      apiKeyId,
      jobId,
      url,
      domain: new URL(url).hostname,
      tierUsed: rr.tierUsed,
      proxyTier: rr.proxyTier,
      statusCode: rr.statusCode,
      latencyMs: rr.latencyMs,
      qualityScore: quality.score,
      totalCost,
    }).catch((err) => console.error('Log write failed:', err));

    // ── Metrics ──────────────────────────────────────
    const domain = new URL(url).hostname;
    scrapeRequestsTotal.inc({ tier: String(rr.tierUsed), status: 'completed', domain });
    scrapeDuration.observe({ tier: String(rr.tierUsed) }, rr.latencyMs / 1000);
    scrapeCost.observe({ tier: String(rr.tierUsed) }, totalCost);
    if (llmCost > 0) llmCostTotal.inc(llmCost);
    observeStages(trace);
    observeTierAttempts(trace);

    // ── Stage 5: Webhook delivery ──────────────────────
    if (options.webhookUrl) {
      deliverWebhook(
        options.webhookUrl,
        jobId,
        result as unknown as Record<string, unknown>,
        'scrape.completed',
        apiKeyId,
      ).catch((err) => console.error(`[${jobId}] Webhook delivery error:`, err));
    }

    await sseEmitter.emitComplete(jobId, result as unknown as Record<string, unknown>);
    await job.updateProgress(100);

    console.log(
      `[${jobId}] Completed in ${trace.totalMs}ms (Tier ${rr.tierUsed}, proxy ${rr.proxyTier}, quality ${quality.score}, llm $${llmCost.toFixed(6)})`,
    );
    return result;
  } catch (caught) {
    clearTimeout(deadlineTimer);
    // Past the deadline, whatever the aborted work threw is a consequence of it.
    const error: unknown = deadline.signal.aborted ? deadline.signal.reason : caught;
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[${jobId}] Failed:`, errorMessage);
    scrapeRequestsTotal.inc({ tier: '0', status: 'failed', domain: new URL(url).hostname });
    const trace = tracer.snapshot();
    observeStages(trace);
    observeTierAttempts(trace);

    const permanent = isPermanentFailure(error, errorMessage);

    const failResult: ScrapeResult = {
      jobId,
      url,
      status: 'failed',
      content: {},
      metadata: {
        tierUsed: 0,
        proxyTier: 'none',
        latencyMs: 0,
        cached: false,
        qualityScore: 0,
        costBreakdown: { compute: 0, proxy: 0, captcha: 0, llm: 0, total: 0 },
        timings: { stages: trace.stages, attempts: trace.attempts, totalMs: trace.totalMs },
      },
      error: errorMessage,
    };

    await redis.set(`result:${jobId}`, JSON.stringify(failResult), 'EX', 3600);

    if (options.webhookUrl) {
      deliverWebhook(
        options.webhookUrl,
        jobId,
        failResult as unknown as Record<string, unknown>,
        'scrape.failed',
        apiKeyId,
      ).catch(() => {});
    }

    await sseEmitter.emitError(jobId, errorMessage);
    if (permanent) throw new UnrecoverableError(errorMessage);
    throw error;
  }
}

// --- Start Workers ---
// Default concurrency to MAX_BROWSER_CONTEXTS so heavy SPAs can't queue
// past the API's sync-mode timeout. Extraction is offloaded to a Piscina
// pool, so the main thread is no longer a bottleneck here.
// stalledInterval defaults to 30s in BullMQ, which combined with the API's
// default sync timeout can make a crashed-worker scrape look like a hard
// timeout to the caller instead of a recovery. 15s is aggressive but still
// well above any legitimate long-running scrape heartbeat.
const workerOptions = {
  connection: bullConnection,
  concurrency: parseInt(
    process.env.WORKER_CONCURRENCY ||
      process.env.MAX_BROWSER_CONTEXTS ||
      '5',
  ),
  stalledInterval: parseInt(process.env.BULLMQ_STALLED_INTERVAL_MS || '15000'),
  maxStalledCount: parseInt(process.env.BULLMQ_MAX_STALLED_COUNT || '2'),
};

const workers: Worker[] = [];

for (const queueName of Object.values(QUEUE_NAMES)) {
  const worker = new Worker(queueName, processScrapeJob, workerOptions);

  worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed:`, err.message);
  });

  workers.push(worker);
  console.log(`Worker listening on queue: ${queueName}`);
}

console.log(
  `ScrapeForge worker ready — ${workers.length} queues, concurrency ${workerOptions.concurrency}`,
);

// --- Graceful Shutdown ---
async function shutdown() {
  console.log('Shutting down workers...');
  await Promise.all(workers.map((w) => w.close()));
  // Background recipe learning and domain-strategy writes go to Redis: let
  // them finish (bounded) before the connection closes.
  await Promise.race([
    Promise.all([flushRecipeLearning(), router.drainStrategyWrites()]),
    new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
  ]);
  await browserPool.shutdown();
  await redis.quit();
  await pg.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// --- Helpers ---
startMetricsServer(9091);

async function logRequest(pool: Pool, data: Record<string, unknown>) {
  await pool.query(
    `INSERT INTO request_logs
       (user_id, api_key_id, job_id, url, domain, tier_used, proxy_tier, status_code, latency_ms, quality_score, total_cost, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'completed')`,
    [
      data.userId,
      data.apiKeyId,
      data.jobId,
      data.url,
      data.domain,
      data.tierUsed,
      data.proxyTier,
      data.statusCode,
      data.latencyMs,
      data.qualityScore,
      data.totalCost,
    ],
  );
}
