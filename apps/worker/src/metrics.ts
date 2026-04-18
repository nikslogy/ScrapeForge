import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import http from 'node:http';

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
