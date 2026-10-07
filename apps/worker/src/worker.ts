import { Worker, Job, UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import {
  ScrapeJobData,
  ScrapeResult,
  QUEUE_NAMES,
  createCacheKey,
} from '@scrapeforge/shared';
import { SmartRouter } from './engine/router.js';
import { BrowserPool } from './browser/pool.js';
import { extractContent } from './extraction/pipeline.js';
import { calculateQualityScore } from './extraction/quality-scorer.js';
import { AiExtractor } from './extraction/ai-extractor.js';
import { deliverWebhook } from './delivery/webhook.js';
import { SseEmitter } from './delivery/sse-emitter.js';
import {
  scrapeRequestsTotal,
  scrapeDuration,
  scrapeCost,
  browserPoolSize,
  llmCostTotal,
  startMetricsServer,
} from './metrics.js';

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

// --- AI Extractor + SSE ---
const aiExtractor = new AiExtractor(redis);
const sseEmitter = new SseEmitter(redis);

// --- Cost lookup (compute only, proxy cost comes from router) ---
const TIER_COMPUTE_COST: Record<number, number> = {
  1: 0.000_01,
  2: 0.000_02,
  3: 0.000_10,
  4: 0.000_50,
  5: 0.000_80,
};

// --- Job Processor ---
async function processScrapeJob(job: Job<ScrapeJobData>): Promise<ScrapeResult> {
  const { jobId, url, options, userId, apiKeyId } = job.data;

  console.log(`[${jobId}] Processing: ${url}`);
  await job.updateProgress(10);
  await sseEmitter.emit(jobId, 'started', { url, jobId });

  try {
    // ── Stage 1: Scrape ────────────────────────────────
    const rr = await router.route(url, options);
    await job.updateProgress(40);
    await sseEmitter.emitHeaders(jobId, rr.statusCode, {});

    // ── Stage 2: Content extraction ────────────────────
    const extracted = await extractContent(
      rr.html,
      url,
      options.formats || ['markdown'],
    );
    await job.updateProgress(60);

    const firstFormat = Object.keys(extracted)[0] as string | undefined;
    if (firstFormat) {
      await sseEmitter.emitContent(jobId, firstFormat, String((extracted as any)[firstFormat] || ''));
    }

    // ── Stage 3: AI extraction (if schema provided) ────
    let llmCost = 0;
    if (options.extractSchema && Object.keys(options.extractSchema).length > 0) {
      try {
        const aiResult = await aiExtractor.extract(rr.html, url, options.extractSchema);
        extracted.json = aiResult.data;
        llmCost = aiResult.llmCost;
        console.log(`[${jobId}] AI extraction via ${aiResult.route}, cost $${llmCost.toFixed(6)}`);
        await sseEmitter.emitExtraction(jobId, aiResult.data);
      } catch (aiErr) {
        console.warn(`[${jobId}] AI extraction failed:`, (aiErr as Error).message);
      }
    }
    await job.updateProgress(80);

    // ── Stage 4: Quality scoring + cost ────────────────
    const quality = calculateQualityScore(
      rr.html,
      rr.statusCode,
      rr.tierUsed,
      rr.latencyMs,
    );

    const computeCost = TIER_COMPUTE_COST[rr.tierUsed] ?? 0.0005;
    const totalCost = computeCost + rr.proxyCost + llmCost;

    const {
      extractionMethod,
      title: extractedTitle,
      description: extractedDescription,
      ...contentFields
    } = extracted;

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
      },
    };

    // ── Stage 5: Cache + persist ───────────────────────
    //
    // Cache key incorporates `extractSchema` so two callers with different
    // schemas don't collide on the same URL. We also refuse to cache an
    // "extract" request that came back with no JSON (LLM rate-limit /
    // truncation) — otherwise a poisoned entry would mask the failure on
    // every subsequent call for the cacheTtl window.
    if (options.cacheTtl && options.cacheTtl > 0) {
      const askedForJson = Boolean(options.extractSchema);
      const json = result.content.json;
      // Listing-page extractions now produce arrays — an empty array is just
      // as poisoned as an empty object, so check both shapes.
      const jsonIsEmpty =
        !json ||
        (Array.isArray(json) ? json.length === 0 : Object.keys(json).length === 0);
      const poisoned = askedForJson && jsonIsEmpty;

      if (!poisoned) {
        const cacheKeyStr = `cache:${createCacheKey(url, {
          formats: options.formats,
          proxy: options.proxy,
          extractSchema: options.extractSchema,
        })}`;
        await redis.set(cacheKeyStr, JSON.stringify(result), 'EX', options.cacheTtl);
      }
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

    // ── Stage 6: Webhook delivery ──────────────────────
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
      `[${jobId}] Completed in ${rr.latencyMs}ms (Tier ${rr.tierUsed}, proxy ${rr.proxyTier}, quality ${quality.score}, llm $${llmCost.toFixed(6)})`,
    );
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[${jobId}] Failed:`, errorMessage);
    scrapeRequestsTotal.inc({ tier: '0', status: 'failed', domain: new URL(url).hostname });

    const permanent = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|SSRF|private.*address|All tiers exhausted/i.test(errorMessage);


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
