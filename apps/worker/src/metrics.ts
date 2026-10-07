import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import http from 'node:http';
import type { TraceSnapshot } from './tracing.js';

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: 'scrapeforge_worker_' });

export const scrapeRequestsTotal = new Counter({
  name: 'scrapeforge_scrape_requests_total',
  help: 'Total scrape requests processed',
  labelNames: ['tier', 'status', 'domain'] as const,
  registers: [registry],
});

export const scrapeDuration = new Histogram({
  name: 'scrapeforge_scrape_duration_seconds',
  help: 'Scrape duration in seconds',
  labelNames: ['tier'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const scrapeCost = new Histogram({
  name: 'scrapeforge_scrape_cost_per_request',
  help: 'Cost per scrape request in USD',
  labelNames: ['tier'] as const,
  buckets: [0.00001, 0.0001, 0.001, 0.01, 0.1],
  registers: [registry],
});

export const browserPoolSize = new Gauge({
  name: 'scrapeforge_browser_pool_size',
  help: 'Browser pool context count',
  labelNames: ['state'] as const,
  registers: [registry],
});

export const proxySuccessRate = new Gauge({
  name: 'scrapeforge_proxy_success_rate',
  help: 'Proxy success rate 0-1',
  labelNames: ['provider', 'tier'] as const,
  registers: [registry],
});

export const cacheHitRate = new Gauge({
  name: 'scrapeforge_cache_hit_rate',
  help: 'Cache hit rate 0-1',
  registers: [registry],
});

export const llmCostTotal = new Counter({
  name: 'scrapeforge_llm_cost_total',
  help: 'Total LLM cost in USD',
  registers: [registry],
});

// 1 ms .. 60 s: parse/validate stages live in the low milliseconds, fetches
// and LLM calls in seconds, browser escalations up to the job timeout.
const STAGE_BUCKETS = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60,
];

export const stageDuration = new Histogram({
  name: 'scrapeforge_stage_duration_seconds',
  help: 'Per-request time spent in each pipeline stage',
  labelNames: ['stage'] as const,
  buckets: STAGE_BUCKETS,
  registers: [registry],
});

export const tierAttemptDuration = new Histogram({
  name: 'scrapeforge_tier_attempt_duration_seconds',
  help: 'Duration of each router tier attempt by outcome',
  labelNames: ['tier', 'outcome'] as const,
  buckets: STAGE_BUCKETS,
  registers: [registry],
});

// Stage names come from code, but a label is unbounded by type. Cap the
// distinct values so a dynamic name can never blow up series cardinality.
const MAX_STAGE_LABELS = 64;
const knownStages = new Set<string>();

function stageLabel(stage: string): string {
  if (knownStages.has(stage)) return stage;
  if (knownStages.size >= MAX_STAGE_LABELS) return 'other';
  knownStages.add(stage);
  return stage;
}

function isDuration(ms: number): boolean {
  return Number.isFinite(ms) && ms >= 0;
}

/** Records every stage of one request's trace. Invalid durations are skipped. */
export function observeStages(snapshot: Pick<TraceSnapshot, 'stages'>): void {
  for (const [stage, ms] of Object.entries(snapshot.stages)) {
    if (isDuration(ms)) stageDuration.observe({ stage: stageLabel(stage) }, ms / 1000);
  }
}

const ATTEMPT_OUTCOMES = new Set(['accepted', 'rejected', 'error']);

/** Records every router tier attempt of one request's trace. */
export function observeTierAttempts(snapshot: Pick<TraceSnapshot, 'attempts'>): void {
  for (const a of snapshot.attempts) {
    // Same cardinality guard as stages: only real tiers and known outcomes.
    const validTier = Number.isInteger(a.tier) && a.tier >= 0 && a.tier <= 9;
    if (!validTier || !ATTEMPT_OUTCOMES.has(a.outcome) || !isDuration(a.ms)) continue;
    tierAttemptDuration.observe({ tier: String(a.tier), outcome: a.outcome }, a.ms / 1000);
  }
}

/**
 * Start a lightweight HTTP server on port 9091 to expose /metrics
 * for Prometheus to scrape from the worker process.
 */
export function startMetricsServer(port = 9091) {
  const server = http.createServer(async (_req, res) => {
    if (_req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': registry.contentType });
      res.end(await registry.metrics());
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port, () => {
    console.log(`Worker metrics server on :${port}/metrics`);
  });
}
