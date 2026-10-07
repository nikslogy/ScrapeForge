# Phase 0: where does the time go on the sync scrape path?

Measurement only: no product code was changed for this investigation.

- Results: [`results/queue-overhead-2026-10-07.json`](results/queue-overhead-2026-10-07.json) (final run, 615 s)
- Re-run (about 10 min; starts and stops its own `redis-server` on port 6391): `npx tsx tests/latency/queue-overhead.ts`.
  If a run is killed, its Redis keeps running; stop it with `redis-cli -p 6391 shutdown nosave`.
- Tables from a results file: `npx tsx tests/latency/summarize.ts tests/latency/results/<file>.json`
- Retained-memory probe (about 2 min): `node --expose-gc --import tsx tests/latency/memory-probe.ts` writes
  [`results/memory-probe-2026-10-07.json`](results/memory-probe-2026-10-07.json)
- Harness unit/integration tests: `npx vitest run --config tests/latency/vitest.config.ts`
- Typecheck: `npx tsc --noEmit -p tests/latency`

The hypothesis under test: a fresh scrape of example.com through `POST /v1/scrape` took about 2.4 s at p50
([docs/testing-report.md](../../docs/testing-report.md), April run, concurrency 5), while a plain fetch should take
a few hundred ms.

## Summary

1. **BullMQ and QueueEvents add no fixed delay.** The full round trip, with the exact options the API and worker
   use, takes **1.1–1.5 ms p50 and 2.0–2.9 ms p95** sequentially, and 3.3–4.4 ms p50 at 20 concurrent requests.
   With all of `worker.ts`'s per-job Redis traffic added (5 progress updates, 4 SSE publishes, router bookkeeping,
   result and cache writes of ~50 KB each), it is **4.4 ms p50**. After the worker and QueueEvents sit idle for
   10 s, a job takes **2.2–4.5 ms**. Setting a priority makes no meaningful difference.
2. **Under the current code, an example.com-shaped page costs ~1.8 s locally because the router escalates it to
   two browser tiers.** The classic 1,256-byte example.com page scores 0.50 in the quality gate, under the 0.55
   threshold, so it is rejected at T1, T2 and also T4. Only the terminal stealth tier T5 accepts it. End to end on
   loopback, with no network at all, that takes **1,844 ms p50** (T4 1,064 ms + T5 763 ms). The same request for a
   page the gate accepts takes **25 ms p50**. On the internet, add the network time of 2 HTTP fetches and 2 browser
   navigations. The per-domain strategy cache never short-circuits this (see below).
   *Caveat:* this gate arrived in commit `0bf7f9d`, after the April measurement, so it cannot explain the April
   2.4 s. It does mean today's code is at about 1.8 s or more for that page regardless of network.
3. **The browser tier has about 1 s of fixed waiting, even for a static 512-byte page.** `tier4Fetch` takes
   **1,072 ms** against **108 ms** for a bare `goto` + `content()`.
4. **Large pages are bound by extraction.** A 500 KB page takes **1,072 ms p50** in the extraction pool (turndown
   442 ms, JSDOM 213 ms, Readability 175 ms, three cheerio parses). At 5 concurrent jobs it is 2,337 ms, because
   there are only 3 threads.
5. **Extraction leaks memory.** After forced GC, `extractContent` still retains **~0.66 MB per small page and
   ~13.7 MB per 500 KB page**. The pool process grew from 98 MB to 6.4 GB over one run and returned to 170 MB only
   when the pool was destroyed. An earlier run of this harness was **OOM-killed at 13.4 GB**. jsdom 25.0.1 retains
   ~0.5 MB per instance even after `window.close()`. Readability over linkedom retained 0.1 MB per 500 KB page.
6. **Smaller items:** Piscina's queue is unfair when saturated (p99 9x worse at 20 in flight). The first extraction
   after boot takes 1.2 s. Each job makes ~29 Redis round trips. Completed results are kept in Redis 4 times.

## Method

```
 producer process (API role)              worker child process             fixture child process
 Queue + QueueEvents, same shape as       BullMQ Worker with worker.ts      node:http on 127.0.0.1
 server.ts; Queue.add with the            options; processor = noop |       /small   classic example.com (1,256 B)
 routes/scrape.ts job options; then       redis-sim | full                  /compact compact example.com (512 B)
 job.waitUntilFinished(events, 60000)                                       /large   500 KB content page
              \__________ redis-server 7.0.15 :6391 (no persistence) __________/
```

- **Exact options.**
  - `Queue.add(jobId, data, { jobId, priority: 1, attempts: 3, backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 3600 }, removeOnFail: { age: 86400 } })`
  - `new Worker(q, fn, { concurrency: 5, stalledInterval: 15000, maxStalledCount: 2 })`
  - All other settings are BullMQ 5.74.0 defaults: `drainDelay` 5 s, `lockDuration` 30 s, QueueEvents
    `blockingTimeout` 10 s.
- **Phases of a job, measured on two clocks.** Both processes timestamp with
  `performance.timeOrigin + performance.now()`. The worker−producer offset was measured over IPC at
  0.002–0.009 ms (rtt ≤ 0.07 ms) and subtracted.
  - `enqueue` = `Queue.add`
  - `pickup` = add resolved → processor called
  - `process` = processor body
  - `finalize` = processor returned → worker `completed` event (`moveToFinished`)
  - `notify` = `completed` → `waitUntilFinished` resolved
  - `afterProcess` = finalize + notify
  - `overhead` = total − process

  `notify` can be slightly negative, because the producer's XREAD can learn of the completion before the worker
  processes its own reply. `afterProcess` is the robust figure.
- **Load model.** Closed loop with `c` virtual clients (1, 5, 20). Warm-up requests are discarded: 50 by default,
  5–10 for browser and large-page runs. Percentiles are nearest-rank, so every reported value was actually observed.
- **Real product code vs replicated.**
  - Real: `SmartRouter`, `tier1Fetch`, `tier4Fetch`, `tier4StealthFetch`, `BrowserPool`, `extractContent` (Piscina
    pool and its esbuild bundle), `calculateQualityScore`, `SseEmitter`, `createCacheKey`, `StageTracer`, and the
    outbound guard.
  - Replicated: `worker.ts` itself cannot be imported, because it connects to Postgres and launches Chromium at import
    time. Its processor sequence is reproduced step for step in `lib/worker-child.ts`, without the un-awaited
    Postgres insert.
  - The browser is the local Chromium 141 (`/opt/pw-browsers/chromium-1194`), injected through a `chromium.launch`
    shim (`lib/browser.ts`). Patchright 1.59 pins Chromium 147.
- **Redis command counts** come from `MONITOR`, on separate 20-job samples (5 for browser runs) whose timings are
  discarded.
- **Machine.**
  - Ubuntu 24.04.5 LTS on Linux 6.18 (Firecracker VM), 4 vCPU Intel Xeon @ 2.10 GHz, 15.7 GiB RAM.
  - Node v22.22.0, Redis 7.0.15, bullmq 5.74.0, ioredis 5.10.1, piscina 5.1.4 (3 threads =
    `availableParallelism() − 1`), impit 0.13.0, jsdom 25.0.1.
  - The machine was shared with other sessions: load average was 1.4–1.8 at the start of the final run. Treat single
    milliseconds as noise.

## Results

Times are in ms. *seq* = 1 client.

### A. Baselines

| | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|
| no-op async call, seq / c20 | 0.000 / 0.01 | 0.000 / 0.01 | 0.00 / 0.03 | 1.39 / 0.93 |
| Redis PING (ioredis, loopback), seq / c5 / c20 | 0.06 / 0.09 / 0.12 | 0.15 / 0.17 / 0.24 | 0.51 / 0.26 / 0.30 | 4.13 / 6.18 / 0.38 |
| `JSON.stringify` / `JSON.parse` of a 51 KB ScrapeResult | 0.146 / 0.033 | 0.201 / 0.052 | 0.453 / 0.103 | 2.23 / 0.40 |

### B / D. BullMQ round trip, no-op processor: priority 1 (B) vs no priority (D)

B and D were run alternately, twice each, so that drift over time could not pass for a priority effect.

| run | total p50 | p95 | p99 | max | enqueue p50 | pickup p50 | after-process p50 | jobs/s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| B pass 1, seq | 1.48 | 2.85 | 4.66 | 10.01 | 0.44 | 0.49 | 0.53 | 580 |
| D pass 1, seq | 1.32 | 2.34 | 4.47 | 8.37 | 0.37 | 0.45 | 0.49 | 662 |
| B pass 2, seq | 1.24 | 2.01 | 3.89 | 11.17 | 0.33 | 0.43 | 0.44 | 718 |
| D pass 2, seq | 1.10 | 2.05 | 5.03 | 8.75 | 0.31 | 0.33 | 0.43 | 776 |
| B pass 1 / 2, c5 | 1.67 / 1.45 | 4.68 / 3.60 | 9.07 / 7.67 | 12.82 / 8.09 | | | | 2,320 / 2,745 |
| D pass 1 / 2, c5 | 1.80 / 1.50 | 4.61 / 3.74 | 5.32 / 8.46 | 12.53 / 12.55 | | | | 2,292 / 2,624 |
| B pass 1 / 2, c20 | 3.33 / 4.37 | 7.18 / 8.44 | 11.40 / 10.38 | 13.71 / 11.41 | | | | 4,863 / 4,078 |
| D pass 1 / 2, c20 | 4.32 / 3.45 | 9.51 / 8.31 | 11.38 / 13.44 | 12.21 / 14.68 | | | | 3,878 / 4,906 |

- The first job after both sides connected (the cold case) took 3.9–9.3 ms.
- Each job costs **11 client round trips**: `addPrioritizedJob` or `addStandardJob`, `isFinished`, 3 `moveToActive`,
  2 `BZPOPMIN`, 3 `XREAD`, and `moveToFinished`. Those scripts run a further 61 commands inside Lua.
- Unprioritised jobs are about 0.15 ms faster at sequential p50 in both passes. At c5 and c20 the sign flips
  between passes. **Priority does not affect wake-up latency.**

### C. As B, with `worker.ts`'s Redis traffic in the processor (fetch and extraction removed)

| level | total p50 | p95 | p99 | max | enqueue | pickup | process | after-process | jobs/s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| seq | 4.43 | 6.85 | 9.52 | 22.11 | 0.47 | 0.33 | 2.44 | 1.12 | 209 |
| c5 | 9.57 | 13.83 | 17.72 | 20.32 | 0.34 | 0.77 | 6.77 | 1.26 | 504 |
| c20 | 33.51 | 39.49 | 42.34 | 43.10 | 0.35 | 24.48 (queued behind worker concurrency 5) | 7.03 | 1.33 | 587 |

- **Commands per job:** 29.4 client round trips: 7.4 `XREAD`, 5 `updateProgress`, 4 `PUBLISH`, 3 `SET`, 2 `GET`,
  plus the BullMQ scripts.
- **Redis memory retained per job: 155 KB** for a 51 KB result. The result is held 4 times:
  - in the job hash (59 KB, kept 1 h by `removeOnComplete: { age: 3600 }`)
  - in the `completed` event of the events stream
  - under `result:{jobId}` (57 KB, 1 h)
  - under `cache:*`
- The events stream reached its ~10,000-entry cap at **65 MB**.

### E. Idle wake-up: worker and QueueEvents idle about 10 s, then one job (x8)

Idle periods were 9,862–10,141 ms, jittered to cross both the BZPOPMIN (5 s) and XREAD (10 s) timeout boundaries.

| | p50 | max |
|---|---:|---:|
| total | 3.82 | 4.49 |
| pickup | 1.23 | 1.62 |

That is about 2 ms slower than the warm case (B, 1.2–1.5 ms) and nowhere near seconds. **There is no `drainDelay`
penalty.**

### F. Extraction (`apps/worker/src/extraction/pipeline.ts` `extractContent`, markdown)

The small page is the classic example.com page, extracted by `largest-block`. The large page is 512,593 B,
extracted by `readability` into 410 KB of markdown.

| run | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|
| pool small, seq | 14.67 | 22.61 | 29.60 | 34.46 |
| pool small, c5 | 32.61 | 63.45 | 76.83 | 88.39 |
| pool small, c20 | 68.28 | 211.57 | **1,217.95** | **1,683.99** |
| pool small, c20, behind a FIFO gate (≤ 3 in Piscina) | 111.41 | 128.75 | **136.41** | **142.94** |
| pool large, seq | **1,071.66** | 1,519.71 | 1,719.17 | 1,719.17 |
| pool large, c5 | 2,336.79 | 3,139.03 | 3,514.46 | 3,514.46 |
| pool large, c5, behind a FIFO gate | 2,259.20 | 3,126.39 | 3,417.39 | 3,417.39 |
| same code on the main thread: small / large, seq | 14.62 / 919.67 | 23.14 / 1,075.67 | 27.53 / 1,232.39 | 35.28 / 1,232.39 |

- **Startup.**
  - `import pipeline.ts`: 67 ms. This covers the esbuild bundle and pool creation; threads are pre-spawned.
  - **First call: 1,165 ms.** Each thread must first load jsdom, cheerio, Readability and turndown, which cost
    814 ms on the main thread.
  - A burst of 6 calls right after that took 164 ms.
- **Components at p50, main thread, small / large page:**
  - `new JSDOM`: 3.9 / 213
  - `Readability.parse`: 4.9 / 175
  - `turndown` of the article: 0.12 / **442**
  - `cheerio.load`: 0.06 / 39. The pipeline calls it 3x on the Readability path and up to 8x on the fallback
    paths (`pipeline-impl.ts:127, 212, 257, 291, 324, 340, 346`).
- **Process RSS** (the pool threads run in this process):

  | point in the run | RSS |
  |---|---:|
  | start | 98 MB |
  | after ~1,000 small extractions | 1,197 MB |
  | after 100 large | 5,061 MB |
  | after 50 more large | 6,409 MB |
  | after pool destroyed | **170 MB** |

  `memory-probe.ts` measures heap still in use after forced full GC. That is retained memory, not uncollected
  garbage:

  | case | retained per call | call p50 |
  |---|---:|---:|
  | `pipeline-impl` `extractContent`, small page (x300) | **656 KB** | 15 ms |
  | `pipeline-impl` `extractContent`, 500 KB page (x15) | **13.7 MB** | 999 ms |
  | `new JSDOM(small)`, without / with `window.close()` (x300) | 527 / 503 KB | 4 ms |
  | JSDOM + Readability, 500 KB page (x15) | 13.2 MB | 385 ms |
  | linkedom `parseHTML` + Readability, 500 KB page (x15) | **0.1 MB** | **74 ms** |

  A one-off check gave the same JSDOM retention under plain `node` without the tsx loader, so tsx is not the cause.
  An earlier run of this harness, with 300 large-page extractions, was killed by the cgroup OOM killer at 13.4 GB
  RSS. That is why large-page sample sizes are now capped at 50.

### G. Tier 1 fetch of the local fixture (plain HTTP on loopback)

| run | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|
| `tier1Fetch` small, seq / c5 / c20 | 1.57 / 1.83 / 4.14 | 2.55 / 3.61 / 10.35 | 4.18 / 7.52 / 13.90 | 8.79 / 9.33 / 14.01 |
| `tier1Fetch` large (500 KB), seq / c5 / c20 | 2.86 / 8.44 / 33.69 | 5.73 / 15.63 / 46.48 | 8.21 / 19.45 / 57.54 | 14.23 / 24.11 / 61.91 |
| raw `new Impit().fetch` small, seq | 0.95 | 1.64 | 2.90 | 3.57 |
| Node `fetch` (undici) small, seq | 0.72 | 1.18 | 2.80 | 13.77 |
| `assertPublicUrl`: cache hit / per-call lookup (DNS stubbed) | 0.002 / 0.006 | 0.004 / 0.012 | 0.010 / 0.036 | 5.0 / 3.6 |

- The first request on a new Impit client took 75 ms.
- The redirect and SSRF wrapper adds about 0.6 ms over raw Impit.

### Q. Router acceptance gate (`router.ts:111` `assessTier`, threshold 0.55)

| page | bytes | score | decision |
|---|---:|---:|---|
| classic example.com | 1,256 | **0.50** | **rejected**: "Very low visible text (202 chars)", which is −0.5 because the HTML is ≥ 1 KB (`quality-scorer.ts:49-53`) |
| compact example.com | 512 | 0.80 | accepted at T1 (the short-page carve-out applies under 1 KB, `quality-scorer.ts:36`) |
| 500 KB content page | 512,593 | 1.00 | accepted at T1 |

### I. Browser tiers against the local fixture

| run | p50 | p95 | max |
|---|---:|---:|---:|
| bare `newPage` + `goto(domcontentloaded)` + `content()` + close | **108** | 136 | 142 |
| `tier4Fetch` compact, seq | **1,072** | 1,097 | 1,106 |
| `tier4Fetch` compact, c5 | 1,335 | 1,576 | 1,638 |
| `tier4Fetch` classic, seq | 1,075 | 1,098 | 1,098 |
| `tier4Fetch` large, seq | 1,399 | 1,414 | 1,422 |
| `tier4StealthFetch` compact, seq (n=10) | 693 | 952 | 952 |

`BrowserPool.initialize()`, which launches Chromium and creates 3 contexts, took 315–421 ms.

### H. The whole worker path through the queue

This uses the real router and extraction, with `cacheTtl: 0` as in the April `tier1-example` scenario.

| page / level | total p50 | p95 | p99 | max | route p50 | extract p50 | queue overhead p50 |
|---|---:|---:|---:|---:|---:|---:|---:|
| compact, seq | **25.0** | 36.7 | 46.9 | 54.1 | 3.1 (T1 2.2) | 15.7 | 2.2 |
| compact, c5 | 51.1 | 81.5 | 94.1 | 111.8 | 4.8 | 37.8 | 3.2 |
| compact, c20 | 158.2 | 185.6 | 197.3 | 199.5 | 3.8 | 29.1 | 119.7 (waiting for 1 of 5 worker slots) |
| large, seq | 1,070 | 1,267 | 1,459 | 1,459 | 18.6 | 1,017 | 10.0 |
| large, c5 | 2,090 | 2,727 | 2,852 | 2,852 | 25.0 | 2,026 | 14.2 |
| **classic, browser enabled, seq** | **1,844** | 2,056 | 2,195 | 2,195 | **1,818** | 24.7 | 2.6 |
| classic, browser enabled, c5 | 2,047 | 2,792 | 2,888 | 2,888 | 2,025 | 19.2 | 2.8 |

- **Classic page, all 20 sequential jobs:** 4 attempts each. T1 rejected (2.2 ms), T2 rejected (2.1), T4 rejected
  (1,064), and T5 accepted as terminal (763). `tierUsed` = 5.
- **Cold first job after the worker starts:** 1,222 ms for compact, 2,304 ms for large, 2,275 ms for classic. This
  is extraction-thread warm-up.
- **Worker module import:** `router.ts` takes 350–490 ms (it pulls in patchright and the tiers); `pipeline.ts` takes
  54–67 ms.
- **Redis:** 29 client commands per job (35 for classic, because the router's domain bookkeeping makes a GET and a
  SET per tier attempt). 1.39 MB is retained per job for the 500 KB page. The events stream reached 56 MB after
  121 large jobs.

## Where the time goes

Locally, with no network, each case breaks down as follows:

| request | queue + Redis | route (fetch + gate) | extraction | total p50 |
|---|---:|---:|---:|---:|
| page accepted at T1, ~1 KB | ~2–5 ms | ~3 ms | ~15 ms | 25 ms |
| classic example.com (1,256 B) | ~3 ms | **~1,820 ms** (T4 1,064 + T5 763) | ~25 ms | 1,844 ms |
| 500 KB page | ~10 ms | ~19 ms | **~1,017 ms** | 1,070 ms |

What is missing locally is network time: DNS, TCP and TLS setup, and RTT. That applies once per HTTP tier attempt
and once (plus sub-resources) per browser navigation.

**About the April 2.4 s.** It cannot be attributed from here.
- At that commit (`91d8e6c`), the router accepted any T1 response that passed `isValidContent`. There was no quality
  gate, so example.com would not have escalated.
- Nothing on the local path for an accepted small page costs more than ~25 ms.
- The cached path in the same report was 14 ms p50, which bounds the API's own overhead (auth query, rate-limiter
  MULTI, cache GET, Fastify).
- The remaining ~2.4 s was therefore network or fetch time on that machine, or something that no longer exists in
  the code. `tests/perf/percentiles.ts` never printed which tier served each response, so there is no way to tell
  which.

What this investigation does show is that **today's code adds ~1.8 s for any page with ≥ 1 KB of markup and
< 500 chars of visible text**, the classic example.com among them. That holds whether or not the network is fast.

## Does BullMQ or QueueEvents add a fixed delay?

No. Measured: B, D and E above. Statically, in bullmq 5.74.0 `dist/esm`:

- **`drainDelay` is a timeout, not a polling period.** `drainDelay: 5` (`classes/worker.js:32`) is the timeout of
  the idle worker's `BZPOPMIN` on the queue's marker key (`worker.js:436, 486`).
- **Adding a job wakes the worker immediately.** Both `addPrioritizedJob` and `addStandardJob` `ZADD` the marker
  (`commands/includes/addBaseMarkerIfNeeded.lua:7`, reached via `addJobWithPriority.lua:13` and
  `addJobInTargetList.lua:10`). So a waiting worker wakes as soon as a job is added, whether or not it has a
  priority.
- **QueueEvents wakes on the completed event.** `XREAD BLOCK 10000` (`classes/queue-events.js:27, 84`) returns as
  soon as `moveToFinished` XADDs the event (`commands/moveToFinished-14.lua:198`). That event carries the full
  return value, which every QueueEvents subscriber `JSON.parse`s (`queue-events.js:100`).
- **`waitUntilFinished` does not poll.** It (`classes/job.js:862-906`) registers listeners, then runs one
  `isFinished` check.
- **`stalledInterval` only matters when something crashes.** It is 15 s in `worker.ts:290` and only matters when a
  worker dies mid-job.

## Fixed sleeps and timeouts on the worker path

Line numbers are as of this run; other sessions were editing these files at the same time.

| location | what | cost on the happy path |
|---|---|---|
| `apps/worker/src/engine/tier4-browser.ts:205` | `waitForLoadState('networkidle', { timeout: 4_000 })` | ≥ 500 ms by definition (no requests for 500 ms), up to 4 s |
| `apps/worker/src/engine/tier4-browser.ts:210` | `page.waitForTimeout(400)` | **fixed 400 ms** |
| `apps/worker/src/engine/tier4-browser.ts:28-49, 209` | auto-scroll: `setInterval` every 60 ms, 4,000 px or 2.5 s hard cap | ≥ 60 ms, up to 2.5 s |
| `apps/worker/src/engine/tier4-browser.ts:190-193` / `:200` | `goto` timeout ≤ 20 s / `waitForSelector` ≤ 8 s | timeouts only |
| `apps/worker/src/engine/tier4-stealth.ts:99` | `waitForTimeout(300 + random·700)` | **fixed 300–1,000 ms** |
| `apps/worker/src/engine/tier4-stealth.ts:106` | `networkidle`, timeout 12 s | ≥ 500 ms, up to 12 s |
| `apps/worker/src/engine/tier4-stealth.ts:90-92` / `:103` | `goto` timeout `options.timeout` or 30 s / selector ≤ 10 s | timeouts only |
| `apps/worker/src/engine/tier3-light.ts:44-55` | Lightpanda `goto` ≤ 20 s, selector ≤ 8 s, `networkidle` ≤ 5 s | only when `LIGHTPANDA_URL` is set (not measured) |
| `apps/worker/src/engine/tier1-http.ts:54`, `tier2-tls.ts:75`, `router.ts:247, 269` | `AbortSignal.timeout`, capped at 15 s per HTTP tier | timeouts only |
| `apps/worker/src/engine/router.ts:23, 111-136` | 0.55 quality gate on T1–T4 | **sends short legitimate pages to T4 + T5 (~1.8 s)** |
| `apps/worker/src/engine/router.ts:211, 558-583` | cached tier is used only at success rate ≥ 0.5 over ≥ 3 samples | one escalation chain records 3 failures and 1 success, so the rate converges to 0.25 and the cache never engages |
| `apps/api/src/routes/scrape.ts:100-101` | `attempts: 3`, exponential backoff of 1 s, then 2 s | non-permanent failures keep the HTTP caller waiting through 3 attempts plus 3 s of backoff. `worker.ts:238, 270` exempts "All tiers exhausted" and a few other patterns (no retry) |
| `apps/api/src/routes/scrape.ts:17, 108` | sync wait `timeout`, default 60 s | timeout only |
| `packages/shared/src/net.ts:329, 332` | DNS timeout 5 s; verdict cache 30 s | one real lookup per host per 30 s (not measurable offline) |
| `apps/worker/src/engine/captcha-solver.ts:146` | `sleep(3000)` per poll, up to 40 polls | not called from the router or worker today |
| `apps/worker/src/delivery/webhook.ts:11-12, 162` | retry backoff from 1 s, 10 s timeout | async; not on the sync path |

## Recommended fixes, ranked by expected gain

1. **Stop escalating short, clean pages to the browser.** Expected gain is about 1.8 s locally per affected request,
   plus 2 fewer HTTP fetches and 2 fewer browser navigations of network time. Evidence: H classic vs compact
   (1,844 vs 25 ms p50), Q, I.
   - The −0.5 "very low visible text" penalty (`quality-scorer.ts:49-53`) alone pushes a page with no block signals
     below 0.55. Make it insufficient on its own: lower it, or require a second signal such as block keywords or a
     low text-to-HTML ratio.
   - If T1 and T2 return the same body and the only failure is text length, accept it. A browser cannot make static
     text longer: T4 rendered the same 202 chars and was rejected again.
   - Make the domain strategy learn the outcome. Record the accepting tier rather than one failure per skipped tier
     (`router.ts:558-583`), so a domain that always ends at T5 at least stops paying for T1, T2 and T4.
2. **Replace fixed browser waits with readiness checks.** Expected gain is up to ~0.9 s per T4 attempt and
   0.3–1.0 s per T5 attempt, on every browser-tier request: JS-heavy and hard domains go straight to the browser.
   Evidence: I (1,072 vs 108 ms on a static page).
   - Drop the fixed `waitForTimeout(400)` and make the stealth tier's random delay opt-in.
   - Skip auto-scroll when `scrollHeight` ≤ viewport height.
   - Replace `networkidle` (≥ 500 ms quiet) with a shorter quiet window or DOM-stability check, bounded by the
     remaining deadline. This is Phase 3's "readiness-based browser waits".
3. **Parse once with linkedom for Readability, and investigate turndown.** Expected gain is about 0.3 s per large
   page from the parse plus up to ~0.4 s if turndown is fixed. This also removes most of the extraction memory
   growth (item 4). Evidence: memory probe, linkedom + Readability 74 ms and 0.1 MB retained vs JSDOM + Readability
   385 ms and 13.2 MB on 500 KB; F components.
   - `pipeline-impl.ts` parses the page with cheerio 3 to 8 times, plus JSDOM.
   - Turndown re-parses the article HTML string itself and takes 442 ms on 500 KB.
   - Output parity with JSDOM must be checked against `tests/fixtures/extraction` before switching.
4. **Bound extraction-thread memory.** This is about robustness rather than latency: OOM kills turn into restarts,
   failed jobs and cold starts. Evidence: F RSS, from 98 MB to 6.4 GB, then 170 MB after destroy; the earlier
   harness run was OOM-killed at 13.4 GB; the memory probe shows 656 KB retained per small page and 13.7 MB per
   500 KB page.
   - Item 3 removes the main source.
   - As a guard, set Piscina `resourceLimits.maxOldGenerationSizeMb`, and recycle threads after N tasks or above a
     heap threshold.
   - The default heap limit here is 8,240 MB per isolate. With 4 isolates that exceeds the container.
5. **Warm the extraction pool before taking jobs.** Expected gain is about 1.2 s on the first job or jobs after each
   boot or thread respawn. Evidence: F first call 1,165 ms; H cold first job 1,222 ms vs 25 ms steady state. Run one
   no-op extraction per thread before `new Worker(...)` in `worker.ts`.
6. **Put a FIFO gate in front of Piscina.** This changes tail latency, not the mean. Evidence: F c20, p99 1,218 vs
   136 ms at equal throughput. A one-off check with a 10 ms busy-loop task and no extraction code gave 261 vs 78 ms,
   so the effect comes from Piscina itself.
   - Piscina 5.1.4 re-appends a task it could not place to the tail of its queue each time a thread frees up
     (`node_modules/piscina/dist/index.js` `_onWorkerAvailable`, `_distributeTask`). Under saturation, the oldest
     waiting task keeps rotating to the back.
   - With worker concurrency 5 and 3 threads, at most 2 tasks wait, so today the effect is small: c5 large, gated vs
     not, 3,417 vs 3,514 ms p99. It matters as soon as concurrency is raised or a job extracts several pages.
   - `lib/fifo-gate.ts` shows the pattern: keep ≤ threads in flight and admit in arrival order.
7. **Trim the queue's Redis traffic and copies.** Expected gain is under 3 ms of latency. The value is in Redis load
   and memory. Evidence: C (29 round trips, 155 KB retained per 51 KB result, 65 MB events stream) and H large
   (1.39 MB per job).
   - Skip `updateProgress` in sync mode. Each call is a script, a stream entry, and a wake-up plus `JSON.parse` in
     every API replica's QueueEvents.
   - Pipeline the result and cache `SET`s.
   - Return a small value from the processor and let the API read `result:{jobId}`, so results are not copied into
     the job hash and events stream.
   - Lower `removeOnComplete` and `streams.events.maxLen`.
8. **Cap retries for sync jobs.** This mainly affects failure latency, not success. Use `attempts: 1`, or limit
   retries to the remaining caller timeout, for the realtime queue. Each retried failure costs another full attempt
   plus 1 s and then 2 s of backoff. In `test/queue-harness.test.ts`, an instantly failing job reported in < 0.9 s
   when unrecoverable; it took ~3 s longer while the harness still retried it.

Do not spend time on the queue path for latency. BullMQ priority, `drainDelay` and QueueEvents together account for
1–5 ms.

## What could not be measured here

- **Real network costs:** DNS, TCP and TLS handshakes, RTT to example.com, and CDN behaviour. The fixture is plain
  HTTP on loopback. HTTPS through Impit's TLS stack was not exercised.
- **Which example.com the live site serves today:** the classic 1,256 B page (which escalates) or a compact one
  (which does not). This decides whether the escalation in finding 2 hits the real example.com.
- **The browser tiers with real pages:** third-party sub-resources, trackers that keep `networkidle` from settling,
  and the patchright-pinned Chromium 147 (Chromium 141 was used). The T4/T5 numbers are lower bounds.
- **API process costs:** Fastify, the auth Postgres query and the rate-limiter MULTI are bounded by the April
  cached-path p50 of 14 ms. `checkPublicUrl` (added since then) costs 2–6 µs of CPU per call, but its real DNS lookup
  could not be measured; it happens once per host per 30 s. The worker's Postgres insert is fire-and-forget and off
  the critical path.
- **Production compiled mode** (`node dist/worker.js`): only the tsx/esbuild-bundled mode was run. Steady-state
  per-task cost should be the same; startup was not measured.
- **Tier 3** (Lightpanda, not configured), **proxies**, and **several API replicas** sharing QueueEvents. The last
  is static reasoning only.

## Files

| file | purpose |
|---|---|
| `queue-overhead.ts` | the harness (scenarios A–I, Q); writes `results/queue-overhead-<date>.json` |
| `summarize.ts` | prints markdown tables from a results file |
| `lib/queue-harness.ts` | producer side wired like the API, plus worker-child management |
| `lib/worker-child.ts` | BullMQ worker process: `noop`, `redis-sim` (`worker.ts`'s Redis traffic), `full` (real router and extraction, with `worker.ts`'s failure handling) |
| `lib/phases.ts`, `lib/clock.ts` | phase split and cross-process clock offset |
| `lib/runner.ts`, `lib/stats.ts` | closed-loop load generator, nearest-rank percentiles |
| `lib/fixtures.ts`, `lib/fixture-server*.ts` | deterministic pages and the local website |
| `lib/redis-monitor.ts`, `lib/redis-instance.ts` | `MONITOR`-based command counts with BullMQ script names; throwaway Redis |
| `lib/browser.ts`, `lib/chromium-path.ts` | `BrowserPool` with a locally installed Chromium |
| `lib/fifo-gate.ts` | FIFO admission gate used to evaluate fix 6 |
| `memory-probe.ts` | retained-heap probe for the extraction path (needs `--expose-gc`) |
| `test/*.test.ts` | 73 tests, including end-to-end runs against a throwaway `redis-server` |
