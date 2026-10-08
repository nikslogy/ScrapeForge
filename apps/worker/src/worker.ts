import { Worker, Job, UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import {
  ScrapeJobData,
  ScrapeResult,
  QUEUE_NAMES,
  createCacheKey,
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

// --- Smart Router ---
const router = new SmartRouter(
  redis,
  () => browserPool.acquire(),
  (ctx) => browserPool.release(ctx),
);

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

// --- Job Processor ---
async function processScrapeJob(job: Job<ScrapeJobData>): Promise<ScrapeResult> {
  const { jobId, url, options, userId, apiKeyId } = job.data;
  const jobStart = Date.now();
  const tracer = new StageTracer();

  console.log(`[${jobId}] Processing: ${url}`);
  await job.updateProgress(10);
  await sseEmitter.emit(jobId, 'started', { url, jobId });

  try {
    // ── Stage 1: Scrape ────────────────────────────────
    const rr = await tracer.time('fetch', () => router.route(url, options, tracer));
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
    const timeoutMs = options.timeout ?? 60_000;
    const deadlineMs = jobStart + timeoutMs - Math.min(DEADLINE_SAFETY_MARGIN_MS, timeoutMs * 0.1);
    const includeEvidence = options.includeEvidence === true;
    const sourceBlocked = blockedFromQualitySignals(quality, rr.statusCode);

    const [extracted, outcome] = await Promise.all([
      tracer.time('content', () => extractContent(rr.html, url, options.formats || ['markdown'])),
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
    ]);
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
    // The cache key includes `extractSchema` (and includeEvidence when set)
    // so different requests never collide. A failed extraction (block page,
    // provider outage, nothing found) is never cached: it would mask the
    // failure on every later call for the cacheTtl window.
    if (options.cacheTtl && options.cacheTtl > 0 && extraction?.status !== 'failed') {
      const cacheKeyStr = `cache:${createCacheKey(url, {
        formats: options.formats,
        proxy: options.proxy,
        extractSchema: options.extractSchema,
        includeEvidence: includeEvidence || undefined,
      })}`;
      await redis.set(cacheKeyStr, JSON.stringify(result), 'EX', options.cacheTtl);
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
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[${jobId}] Failed:`, errorMessage);
    scrapeRequestsTotal.inc({ tier: '0', status: 'failed', domain: new URL(url).hostname });
    const trace = tracer.snapshot();
    observeStages(trace);
    observeTierAttempts(trace);

    // Retrying cannot help: bad hosts, blocked (private) destinations, exhausted tiers.
    const permanent =
      /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|SSRF|OUTBOUND_BLOCKED|Blocked by SSRF guard|DNS lookup failed|private.*address|All tiers exhausted/i.test(
        errorMessage,
      );

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
