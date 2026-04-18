# ScrapeForge — Industry-Grade Testing Plan

## Part 1 — What "industry grade" actually means

A scraping API is industry-grade when it hits specific, measurable benchmarks across five dimensions:

1. **Functional correctness** — every endpoint behaves as documented
2. **Reliability** — graceful handling of failures, no data loss, predictable recovery
3. **Performance** — specific P50/P95/P99 latency targets, throughput under load
4. **Anti-bot resilience** — measured success rates on known-hard targets
5. **Output quality** — extraction accuracy vs ground truth

If you pass all tests in this document, you're competitive with ScrapingBee, ScraperAPI, and Zyte on their home turf.

---

## Part 2 — Understanding proxies (the mental model)

Most scrapers fail not because they can't parse HTML, but because the target website detects them and blocks the IP or serves a bot-detection page. Proxies are the defense against IP-based blocking.

**Without a proxy:** Your server → target site. The target sees your server's single IP. After N requests, you're blocked.

**With a proxy pool:** Your server → proxy (random IP) → target site. Each request appears to come from a different IP. The target can't distinguish your scraper from legitimate users.

**Three proxy types:**

| Type | Source of IPs | Cost | Success on protected sites | When to use |
|------|---------------|------|----------------------------|-------------|
| Datacenter | AWS, GCP, OVH server farms | ~$0.035/IP | 60-70% | Default — cheap, fast |
| Residential | Real home users (ISPs) | $2-4/GB | 90-95% | When datacenter fails |
| Mobile | 4G/5G carrier IPs | $4-8/GB | 98%+ | Hardest targets only |

**Why you haven't needed proxies yet:** You're testing on sites that don't aggressively detect bots (Wikipedia, example.com, blogs, documentation). Traffic volume is low enough that no target has rate-limited your IP.

**The quickest test to prove you need proxies:** Pick a protected site and scrape it 20 times in a row from your server. If the 15th request returns a 403 or CAPTCHA page but the 1st succeeded, you're getting rate-limited — you need proxies.

---

## Part 3 — Test target categorization

Keep this list handy. You'll hit these URLs repeatedly during testing.

### Tier 1 — Easy targets (should succeed 100% without proxies)

```
https://example.com
https://en.wikipedia.org/wiki/Web_scraping
https://news.ycombinator.com
https://httpbin.org/html
https://quotes.toscrape.com
https://books.toscrape.com
https://docs.python.org/3/
```

**Expected:** All succeed with Tier 1 (HTTP fetch). Latency under 500ms. No escalation needed.

### Tier 2 — Medium targets (mild protection)

```
https://github.com/trending
https://stackoverflow.com/questions
https://old.reddit.com/r/programming
https://www.ebay.com/sch/i.html?_nkw=laptop
https://medium.com
```

**Expected:** Most succeed with Tier 1-2. Some escalate to Tier 4. Success rate without proxies: 70-85%.

### Tier 3 — Hard targets (aggressive detection)

```
https://www.amazon.com/s?k=laptop
https://www.walmart.com/search?q=laptop
https://www.target.com
https://www.nike.com
https://www.homedepot.com
https://www.google.com/search?q=web+scraping
https://www.bing.com/search?q=web+scraping
```

**Expected:** Most fail without residential proxies. Cloudflare, DataDome, or PerimeterX block datacenter IPs. This is your baseline for whether you actually need proxy infrastructure.

### Tier 4 — Very hard targets (heavy bot protection)

```
https://www.linkedin.com/in/satyanadella
https://www.instagram.com/natgeo
https://www.zillow.com
https://www.glassdoor.com
https://www.indeed.com
https://www.booking.com
```

**Expected:** Requires residential/mobile proxies + stealth browser (Camoufox). Without these, expect under 10% success rate.

### Honeypot / detection benchmarks (CRITICAL)

These sites are specifically designed to detect bots and tell you EXACTLY what fingerprints you're leaking:

```
https://bot.sannysoft.com                    # Checks 20+ bot signals
https://abrahamjuliot.github.io/creepjs      # Comprehensive fingerprint test
https://fingerprint.com/demo                 # FingerprintJS detection
https://pixelscan.net                        # Commercial-grade detector
https://deviceandbrowserinfo.com/info_device # Shows what sites see
https://amiunique.org                        # Fingerprint uniqueness
```

**How to use:** Scrape each with your Tier 4 pipeline. Review the returned HTML/screenshot. Look for "Headless: YES", "WebDriver: YES", "Automation: detected". Every red flag is a fingerprint leak to fix. This is the single most valuable test for validating your stealth mode works.

---

## Part 4 — Testing categories

### A. Functional tests (does every feature work?)

Write an automated suite that hits every endpoint with every option combination. Use Node's built-in test runner or Vitest.

```typescript
// tests/integration/scrape.test.ts
import { test, expect } from 'vitest';

const API = 'http://localhost:3000';
const KEY = process.env.TEST_API_KEY;

async function scrape(body: any) {
  const res = await fetch(`${API}/v1/scrape`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${KEY}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

test('returns HTML when requested', async () => {
  const { data } = await scrape({ url: 'https://example.com', formats: ['html'] });
  expect(data.content.html).toContain('<html');
});

test('returns Markdown by default', async () => {
  const { data } = await scrape({ url: 'https://example.com' });
  expect(data.content.markdown).toBeTruthy();
});

test('respects custom headers', async () => {
  const { data } = await scrape({
    url: 'https://httpbin.org/headers',
    formats: ['html'],
    headers: { 'X-Custom': 'test123' },
  });
  expect(data.content.html).toContain('test123');
});

test('returns screenshot as base64', async () => {
  const { data } = await scrape({ url: 'https://example.com', screenshot: true });
  expect(data.content.screenshot).toMatch(/^[A-Za-z0-9+/]+=*$/);
});

test('caches repeated requests', async () => {
  const first = await scrape({ url: 'https://example.com', cacheTtl: 60 });
  const second = await scrape({ url: 'https://example.com', cacheTtl: 60 });
  expect(second.data.metadata.cached).toBe(true);
  expect(second.data.metadata.latencyMs).toBeLessThan(50);
});

test('returns 401 without API key', async () => {
  const res = await fetch(`${API}/v1/scrape`, { method: 'POST' });
  expect(res.status).toBe(401);
});

test('returns 400 for invalid URL', async () => {
  const { status } = await scrape({ url: 'not-a-url' });
  expect(status).toBe(400);
});

test('handles waitFor selector', async () => {
  const { data } = await scrape({
    url: 'https://example.com',
    waitFor: 'h1',
    formats: ['html'],
  });
  expect(data.statusCode).toBe(200);
});
```

Run with: `npx vitest tests/integration`

### B. Reliability tests (what breaks and how does it recover?)

These test failure modes. Run them manually — they simulate real production incidents.

**Test 1 — Worker crash during job:** Start a long scrape, kill the worker process with `kill -9 <pid>`. Verify: the job returns to the queue (BullMQ stalled job detection), a replacement worker picks it up, the client gets either a result or a proper error within timeout, no partial data is cached.

**Test 2 — Redis connection loss:** Block Redis via firewall while a job is processing. Verify: worker logs the error, worker doesn't crash (reconnects when Redis returns), in-flight jobs handled gracefully.

**Test 3 — Postgres unavailable:** Stop Postgres during operation. Verify: API keeps accepting requests (logging should be non-blocking), usage logs queue up and flush when DB returns, no 500 errors to clients just because logging failed.

**Test 4 — Browser hang:** Scrape a URL that never responds (e.g., `http://10.255.255.1:81`). Verify: timeout fires at the configured limit, browser context is released back to the pool, memory doesn't leak.

**Test 5 — Malformed HTML:** Scrape a page that returns broken HTML. Verify: extraction pipeline doesn't crash, quality score reflects poor content, user gets a response not a 500.

**Test 6 — Memory leak detection (7-day soak test):** Leave the worker running with steady 10 req/min load for 7 days. Monitor RSS memory in Grafana. A healthy system shows sawtooth pattern (GC cycles) with stable baseline. A leaking system shows monotonic growth — something is holding references.

### C. Performance tests (is it fast enough?)

Run each test 100 times and compute percentiles. Industry-grade targets:

| Operation | P50 | P95 | P99 |
|-----------|-----|-----|-----|
| Tier 1 cached response | under 20ms | under 50ms | under 100ms |
| Tier 1 fresh fetch | under 500ms | under 2s | under 5s |
| Tier 4 browser (simple) | under 3s | under 8s | under 15s |
| Tier 4 browser (SPA) | under 5s | under 12s | under 20s |
| AI extraction (cached script) | under 100ms | under 500ms | under 1s |
| AI extraction (LLM call) | under 3s | under 8s | under 15s |

Quick latency benchmark with `hey`:

```bash
# Install: go install github.com/rakyll/hey@latest
hey -n 100 -c 10 \
  -m POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","formats":["markdown"]}' \
  https://api.yourdomain.com/v1/scrape
```

Output gives you P50, P95, P99 directly.

### D. Load tests (does it survive heavy traffic?)

Use k6 for realistic load simulation. Create `tests/load/mixed-traffic.js`:

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const successRate = new Rate('success_rate');
const errorRate = new Rate('error_rate');
const latency = new Trend('request_latency');

export const options = {
  scenarios: {
    gradual_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 50 },     // Ramp to 50 users
        { duration: '5m', target: 50 },     // Stay at 50
        { duration: '2m', target: 200 },    // Ramp to 200
        { duration: '5m', target: 200 },    // Stay at 200
        { duration: '2m', target: 500 },    // Stress test
        { duration: '5m', target: 500 },
        { duration: '2m', target: 0 },      // Ramp down
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<5000'],   // 95% under 5s
    http_req_failed: ['rate<0.05'],       // Error rate under 5%
  },
};

const URLS = [
  'https://example.com',
  'https://en.wikipedia.org/wiki/Web_scraping',
  'https://news.ycombinator.com',
  'https://quotes.toscrape.com',
  'https://books.toscrape.com',
];

export default function () {
  const url = URLS[Math.floor(Math.random() * URLS.length)];
  const payload = JSON.stringify({ url, formats: ['markdown'], cacheTtl: 0 });

  const res = http.post(
    'https://api.yourdomain.com/v1/scrape',
    payload,
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${__ENV.API_KEY}`,
      },
    }
  );

  const success = check(res, {
    'status is 200': (r) => r.status === 200,
    'has content': (r) => r.body.includes('markdown'),
    'under 10s': (r) => r.timings.duration < 10000,
  });

  successRate.add(success);
  errorRate.add(!success);
  latency.add(res.timings.duration);

  sleep(1);
}
```

Run with:
```bash
k6 run -e API_KEY=sf_live_xxx tests/load/mixed-traffic.js
```

**Pass criteria:**
- Error rate under 5% at 500 concurrent users
- P95 latency under 10 seconds
- No memory leaks in Grafana (flat RSS after load ends)
- Browser pool doesn't exhaust
- Queue depth stays below 1000

### E. Anti-bot resilience tests (the real benchmark)

This is the hardest test and the one that separates amateur scrapers from industry-grade. Build an automated harness that hits hard targets and measures success rate over time.

```typescript
// tests/antibot/success-rate-harness.ts
const HARD_TARGETS = {
  amazon: 'https://www.amazon.com/s?k=laptop',
  walmart: 'https://www.walmart.com/search?q=laptop',
  target: 'https://www.target.com',
  nike: 'https://www.nike.com',
  google: 'https://www.google.com/search?q=web+scraping',
  linkedin: 'https://www.linkedin.com/in/satyanadella',
  cloudflare: 'https://nowsecure.nl',
};

async function runTest(runs = 10) {
  const results: Record<string, any> = {};

  for (const [name, url] of Object.entries(HARD_TARGETS)) {
    const latencies: number[] = [];
    let successes = 0;
    const errors: string[] = [];
    const tiers: number[] = [];

    for (let i = 0; i < runs; i++) {
      try {
        const res = await scrape({ url, formats: ['html'] });
        if (res.metadata.qualityScore > 0.7) {
          successes++;
        } else {
          errors.push(`Low quality: ${res.metadata.qualityScore}`);
        }
        latencies.push(res.metadata.latencyMs);
        tiers.push(res.metadata.tierUsed);
      } catch (err: any) {
        errors.push(err.message);
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    results[name] = {
      successRate: `${(successes / runs * 100).toFixed(0)}%`,
      avgLatency: `${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0)}ms`,
      avgTier: (tiers.reduce((a, b) => a + b, 0) / tiers.length).toFixed(1),
      errorSample: errors.slice(0, 3),
    };
  }

  console.table(results);
}

runTest(10);
```

**Benchmark success rates (industry comparison, 2026):**

| Target | ScrapingBee | ScraperAPI | Bright Data | Your target |
|--------|-------------|------------|-------------|-------------|
| Amazon | ~85% | ~90% | ~97% | over 80% |
| Walmart | ~75% | ~85% | ~95% | over 70% |
| Google SERP | ~90% | ~92% | ~99% | over 85% |
| LinkedIn | ~40% | ~60% | ~85% | over 50% |
| Cloudflare test | ~60% | ~80% | ~95% | over 70% |

If your platform hits these numbers without proxies, it means the sites haven't yet seen your IP. Once your IP gets blacklisted (inevitable at volume), you'll drop to 10-30% success rates. That's when proxies become mandatory.

### F. Quality tests (is the output actually good?)

Scraping without quality validation is garbage-in-garbage-out. Test extraction quality against known-good ground truth.

**Test 1 — Markdown conversion fidelity:** Scrape a Wikipedia article, extract to Markdown. Manually verify all headings preserved with correct levels, tables converted correctly, links preserved, code blocks preserved, no navigation or footer junk leaked in.

**Test 2 — Article extraction (Readability):** Scrape a news article from a complex site (NYTimes, BBC). Verify the title is extracted, author name captured, publication date present, body text is the article (not ads or comments), no sidebar content mixed in.

**Test 3 — AI extraction accuracy (gold standard test):** This is critical. Build a ground-truth dataset. Pick 20 product pages from `books.toscrape.com` and manually create expected JSON:

```json
{
  "url": "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html",
  "expected": {
    "title": "A Light in the Attic",
    "price": 51.77,
    "availability": "In stock",
    "rating": 3
  }
}
```

Run `/v1/extract` with a schema for each URL. Compare output to ground truth field-by-field. Track accuracy:
- Title match: over 95% expected
- Price match (numerical): over 98% expected
- Availability: over 95% expected
- Rating: over 90% expected

If field accuracy drops below thresholds, your prompt engineering or schema design needs work.

**Test 4 — Quality score calibration:** Verify your quality scorer actually works. Create a test set of 20 known-good scrapes (score should be over 0.8) and 20 known-failed scrapes / CAPTCHA pages (score should be under 0.4). If the scorer can't distinguish them, it's useless and needs recalibration.

### G. Router intelligence tests

Your smart router is the core value prop. Test that it actually makes smart decisions.

**Test 1 — Tier escalation on failure:** Scrape a site that fails Tier 1 (a Cloudflare-protected site returning 403 to HTTP). Verify the router attempts Tier 1 first (check logs), escalates to Tier 4 on failure, eventually succeeds, and caches the decision.

**Test 2 — Domain strategy cache:** Scrape the same protected domain 10 times. Verify the first request tries Tier 1 → fails → escalates → succeeds at Tier 4, and requests 2-10 skip Tier 1 and go straight to Tier 4. Check Redis: `redis-cli GET domain:<domain>` should show the cached tier.

**Test 3 — Cost efficiency (the money shot):** Compare total cost across 1000 mixed-difficulty requests:
- Run 1: disable smart router, force all requests to Tier 4
- Run 2: with smart router enabled

Smart router should be 60-80% cheaper because 80% of requests stay at Tier 1. If the cost difference is less than 50%, your router isn't routing efficiently.

### H. Competitive benchmarks (the reality check)

Hit identical URLs on your platform AND competitors. Get free-tier API keys for ScrapingBee, ScraperAPI, and Firecrawl. Run the same 100 URLs through each platform.

Create a comparison spreadsheet:

| URL | You | ScrapingBee | ScraperAPI | Firecrawl |
|-----|-----|-------------|------------|-----------|
| example.com | 200ms ✓ | 400ms ✓ | 300ms ✓ | 500ms ✓ |
| amazon.com | fail | 2s ✓ | 3s ✓ | 4s ✓ |
| linkedin.com | fail | fail | 8s ✓ | fail |

This brutal honesty is the only way to know where you stand. If you match or beat competitors on easy/medium targets but fail on hard ones — that tells you proxies and stealth are your main gap, not core engineering.

---

## Part 5 — Industry-grade pass/fail thresholds

You can legitimately call your platform "industry grade" when:

**Functional**
- 100% of documented endpoints work
- All output formats produce valid data
- All error codes documented and returned correctly

**Reliability**
- 99.5%+ uptime over 30 days
- Worker crashes don't lose jobs (verified via kill -9)
- No memory leaks over 7 days of continuous operation

**Performance**
- P95 latency on cached requests: under 100ms
- P95 latency on Tier 1 requests: under 2s
- P95 latency on Tier 4 requests: under 12s
- Throughput: over 50 req/s on a single 4GB droplet (Tier 1-2 mix)

**Scale**
- Handles 500 concurrent users with under 5% error rate
- Queue depth stays below 1000 under sustained load
- Memory stays under 85% of allocated RAM

**Anti-bot**
- 85%+ success rate on Tier 2 targets (medium)
- 70%+ success rate on Tier 3 targets (hard) WITH proxies
- 50%+ success rate on Tier 4 targets WITH residential proxies + stealth

**Quality**
- Markdown conversion fidelity over 95% on standard articles
- Readability extraction accuracy over 90% on news sites
- AI extraction field-level accuracy over 90% on structured data
- Quality score correctly identifies blocked pages over 95% of the time

If you hit all of these, you're competitive with paid services. If you miss some, you know exactly what to fix next.

---

## Part 6 — Recommended testing tools

| Purpose | Tool | Why |
|---------|------|-----|
| Load testing | k6 | JavaScript-scriptable, great output |
| API exploration | Bruno or Postman | Manual endpoint testing |
| Quick benchmarks | hey | Simple HTTP load generator |
| Monitoring | Grafana (you have this) | Real-time metrics |
| Bot detection | bot.sannysoft.com, creepjs | Fingerprint leak detection |
| Process monitoring | htop, btop | Memory/CPU during tests |
| Network monitoring | iftop, nload | Bandwidth tracking |
| Memory leak hunting | clinic.js doctor | Node.js heap analysis |

---

## Part 7 — Concrete 2-week testing plan

**Week 1 — Foundation testing**
- Days 1-2: Run all functional tests, fix any failures
- Days 3-4: Reliability tests (crash scenarios, connection loss, timeouts)
- Day 5: Performance baseline (latency percentiles at rest)

**Week 2 — Stress and real-world**
- Days 1-2: Load testing at increasing concurrency levels
- Days 3-4: Anti-bot resilience tests on hard targets
- Day 5: Competitive benchmarks vs ScrapingBee, ScraperAPI, Firecrawl

At the end of 2 weeks, you should have: a spreadsheet showing success rates on every target, load test reports showing max concurrency handled, a list of known failures with root causes, and evidence of how you compare to competitors.

---

## Part 8 — The honesty principle

Testing is not about finding zero bugs — it's about knowing exactly what your system can and can't do. A platform that succeeds on 80% of hard targets with documented limitations is more professional than one that claims 100% and silently fails.

The moment you can confidently say "we hit 82% success rate on Amazon, 71% on LinkedIn, P95 latency is 4.2s, and we survive 500 concurrent users" — that's when you have something enterprise customers will pay for. Log everything, measure everything, and be honest about the boundaries.
