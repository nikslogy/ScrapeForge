import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const scrapeDuration = new Trend('scrape_duration');

const API_URL = __ENV.API_URL || 'http://localhost:3000';
const API_KEY = __ENV.API_KEY || 'sf_live_REPLACE_ME';

const TEST_URLS = [
  'https://example.com',
  'https://httpbin.org/html',
  'https://jsonplaceholder.typicode.com/posts/1',
  'https://httpbin.org/get',
  'https://www.example.org',
];

export const options = {
  scenarios: {
    // Ramp-up: 100 → 500 → 1000 concurrent
    load_test: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '1m', target: 100 },
        { duration: '30s', target: 500 },
        { duration: '1m', target: 500 },
        { duration: '30s', target: 1000 },
        { duration: '1m', target: 1000 },
        { duration: '30s', target: 0 },
      ],
    },
  },

  thresholds: {
    http_req_duration: ['p(95)<5000'],
    errors: ['rate<0.05'],
  },
};

export default function () {
  const url = TEST_URLS[Math.floor(Math.random() * TEST_URLS.length)];

  const payload = JSON.stringify({
    url,
    formats: ['markdown'],
    cacheTtl: 60,
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    timeout: '30s',
  };

  const start = Date.now();
  const res = http.post(`${API_URL}/v1/scrape`, payload, params);
  const duration = Date.now() - start;

  scrapeDuration.add(duration);

  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'has content': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.content && Object.keys(body.content).length > 0;
      } catch {
        return false;
      }
    },
    'latency < 5s': () => duration < 5000,
  });

  errorRate.add(!ok);
  sleep(0.5 + Math.random() * 0.5);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
    'tests/load/results.json': JSON.stringify(data, null, 2),
  };
}

function textSummary(data, opts) {
  return JSON.stringify(
    {
      total_requests: data.metrics.http_reqs?.values?.count || 0,
      p95_duration_ms: data.metrics.http_req_duration?.values?.['p(95)'] || 0,
      error_rate: data.metrics.errors?.values?.rate || 0,
      avg_scrape_ms: data.metrics.scrape_duration?.values?.avg || 0,
    },
    null,
    2,
  );
}
