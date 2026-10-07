import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Steady-state load test.
// Goal: report p50 / p95 / p99 latency and failure rate at realistic SaaS
// concurrency levels (something an early customer base would actually throw
// at us), NOT the chaotic 0→1000 ramp which only reports saturation limits.

const errorRate = new Rate('errors');
const clientLatency = new Trend('client_latency');

const API_URL = __ENV.API_URL || 'http://localhost:3000';
const API_KEY = __ENV.API_KEY || 'sf_live_REPLACE_ME';
const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || '90s';

// Use a small pool of cacheable URLs so after a brief warmup the cache hits
// dominate — which is how real traffic against a scraping SaaS actually
// behaves once a customer's crawl pattern stabilises.
const TEST_URLS = [
  'https://example.com',
  'https://httpbin.org/html',
  'https://jsonplaceholder.typicode.com/posts/1',
  'https://www.example.org',
  'https://quotes.toscrape.com',
];

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<8000'],
    http_req_failed: ['rate<0.05'],
  },
};

export default function () {
  const url = TEST_URLS[Math.floor(Math.random() * TEST_URLS.length)];
  const payload = JSON.stringify({
    url,
    formats: ['markdown'],
    cacheTtl: 300,
  });
  const params = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    timeout: '30s',
  };
  const t0 = Date.now();
  const res = http.post(`${API_URL}/v1/scrape`, payload, params);
  const ms = Date.now() - t0;
  clientLatency.add(ms);

  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'has content': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body?.content && Object.keys(body.content).length > 0;
      } catch {
        return false;
      }
    },
  });
  errorRate.add(!ok);
  sleep(0.2 + Math.random() * 0.3);
}

export function handleSummary(data) {
  const h = data.metrics.http_req_duration?.values || {};
  const f = data.metrics.http_req_failed?.values || {};
  const rps =
    (data.metrics.http_reqs?.values?.count || 0) /
    Math.max(1, (data.state?.testRunDurationMs || 0) / 1000);

  const summary = {
    vus: VUS,
    duration: DURATION,
    total_requests: data.metrics.http_reqs?.values?.count || 0,
    throughput_rps: Number(rps.toFixed(1)),
    http_req_duration_ms: {
      avg: Math.round(h.avg || 0),
      p50: Math.round(h.med || 0),
      p90: Math.round(h['p(90)'] || 0),
      p95: Math.round(h['p(95)'] || 0),
      p99: Math.round(h['p(99)'] || 0),
      max: Math.round(h.max || 0),
    },
    http_req_failed_rate: Number((f.rate || 0).toFixed(4)),
    check_pass_rate: Number((1 - (data.metrics.errors?.values?.rate || 0)).toFixed(4)),
  };

  return {
    stdout: '\n' + JSON.stringify(summary, null, 2) + '\n',
    '/scripts/steady-results.json': JSON.stringify({ summary, metrics: data.metrics }, null, 2),
  };
}
