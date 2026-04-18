import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: 'scrapeforge_api_' });

export const httpRequestsTotal = new Counter({
  name: 'scrapeforge_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'scrapeforge_http_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const scrapeJobsQueued = new Counter({
  name: 'scrapeforge_jobs_queued_total',
  help: 'Jobs enqueued',
  labelNames: ['queue', 'mode'] as const,
  registers: [registry],
});

export const cacheHits = new Counter({
  name: 'scrapeforge_cache_hits_total',
  help: 'Cache hit count',
  registers: [registry],
});

export const cacheMisses = new Counter({
  name: 'scrapeforge_cache_misses_total',
  help: 'Cache miss count',
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: 'scrapeforge_queue_depth',
  help: 'Current queue depth',
  labelNames: ['queue'] as const,
  registers: [registry],
});
