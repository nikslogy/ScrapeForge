# Published limits

These are the limits ScrapeForge enforces today, what happens when you hit
one, and the measured behaviour under mixed load and failures. Every number
is a constant or a configuration default in the code; the source is named
so it can be checked. Settings marked "env" can be changed per deployment
(see `.env.example`).

## Requests (API)

| limit | value | source | when exceeded |
|---|---|---|---|
| Request body | 1 MiB | `apps/api/src/server.ts` `bodyLimit` | 413 |
| `headers` | 50; names must be HTTP tokens, values without control characters (tab allowed) | `routes/credentials.ts` | 400 |
| `cookies` | 100; names must be HTTP tokens, values without `;` or control characters | same | 400 |
| `timeout` | 1,000–120,000 ms, default 60,000 | `routes/scrape.ts`, `routes/extract.ts` | 400 |
| `cacheTtl` | 0–2,592,000 s (30 days), default 3,600 | same | 400 |
| Extraction schema | 64 KiB, nesting depth 10 | `routes/extract.ts` `MAX_SCHEMA_BYTES`, `MAX_SCHEMA_DEPTH` | 400 |
| Rate limit | the API key's `rateLimit` requests per 60 s sliding window | `middleware/rate-limiter.ts` | 429 with `retryAfter` |
| Job retries | sync: 2 attempts, 250 ms apart; async (webhook): 3 attempts, exponential from 1 s | `routes/extract.ts` `jobRetryOptions` | the last error is returned |
| Result retention | `result:<jobId>` kept 1 h | `apps/worker/src/worker.ts` | 404 on the result endpoint |

## Fetching a page

| limit | value | source |
|---|---|---|
| Whole job | `timeout` + 2 s, whatever the router does | `worker.ts` `JOB_DEADLINE_MARGIN_MS` |
| HTTP tiers (T1, T2) | 15 s per fetch, at most `timeout` | `engine/router.ts` |
| Browser tiers (T4, T5) | `timeout` per navigation | `engine/router.ts` |
| Browser contexts per worker | 5 (env `MAX_BROWSER_CONTEXTS`) | `worker.ts` |
| Jobs in flight per worker | env `WORKER_CONCURRENCY`, else `MAX_BROWSER_CONTEXTS` | `worker.ts` |
| Fetches in flight per site, across all workers | 6 (env `FETCH_DOMAIN_CONCURRENCY`; 0 = no limit). While other tenants wait, one tenant gets at most its share (6 ÷ tenants waiting). A slot is held until the router is done, at most the job deadline + 15 s | `throughput/limits.ts` |
| Wait for a rate-limited (429) or failing (5xx) site | one retry after at most 3 s (and at most `timeout` / 4); a longer `Retry-After` fails at once, retryably | `engine/router.ts` `MAX_TRANSIENT_WAIT_MS` |
| Redirects, private addresses | every hop checked; private, loopback and link-local addresses are refused | `packages/shared/src/net.ts` |

The fetch stops early, without trying a browser, in these cases:
- the name does not resolve;
- the address is internal;
- the site answers with a server error or a rate limit (see
  `docs/engine/DESIGN.md`, "Fetch routing").

The last two give a retryable failure.

## Page content

| limit | value | source | when exceeded |
|---|---|---|---|
| HTML into content extraction | 10 MiB, 100,000 elements (env `EXTRACTION_MAX_INPUT_BYTES`, `EXTRACTION_MAX_INPUT_ELEMENTS`) | `extraction/pipeline.ts` | the page is cut at the limit; only the part before it is converted |
| Content extraction time | 20 s per page | `extraction/pipeline.ts` | timeout error |
| Blocks in the source document | 20,000 | `extract/document/limits.ts` `maxBlocks` | later blocks dropped, `truncated: true` |
| HTML nesting | 512 levels (deeper markup is flattened) | `maxHtmlNesting` | flattened, warning |
| Table size | 2,000 rows × 100 columns | `maxTableRows`, `maxTableCols` | cut |
| Repeated groups (listings) | 100 groups, at least 3 records each | `maxRecordGroups`, `minRecordsPerGroup` | the largest groups are kept |
| Structured data items | 200 JSON-LD/microdata items; 5,000 records per list | `maxStructuredItems`, `structured/limits.ts` | cut, with a warning |

## Structured extraction

| limit | value | source | when exceeded |
|---|---|---|---|
| Model spend per request | $0.05 (env `EXTRACT_MAX_COST_USD`; a request may ask for less with `maxLlmCostUsd`) | `worker.ts` | remaining calls skipped; `partial` |
| One model call | 60 s (env `EXTRACT_LLM_TIMEOUT_MS`) | `extract/llm/index.ts` | retried once, then the next configured model; a listing chunk that can still be halved is halved at its first timeout instead |
| Model calls in flight per worker | 16 (env `EXTRACT_LLM_CONCURRENCY`) | `extract/llm/index.ts` | calls wait; a call still waiting at its deadline ends `budget_exhausted` |
| Listing answered in one call | about 8k output tokens (≈ 100 cards of 4 fields) | `extract/engine.ts` `CHUNK_OUTPUT_TOKENS` | split into chunks |
| Chunks per listing | 64, 4 in flight (env `EXTRACT_PARTITION_CONCURRENCY`, ≤ 16) | `MAX_CHUNKS` | the rest is reported `not_processed` by record range |
| Records missing from a chunk's answer | 10% of its cards (promo slots) | `LIST_COVERAGE_TOLERANCE` | the missing cards are asked for once more; then reported `not_processed` |
| Records from a learned recipe | 5,000 | `extract/recipe/limits.ts` | cut |
| `missing` entries returned | 1,000 | `MAX_MISSING_ENTRIES` | cut, with warning `missing_entries_capped:N` |

A page larger than one model call is never cut silently:
- a listing is answered in chunks;
- a single item is answered from the blocks most relevant to the fields.

Whatever could not be processed is listed in `missing` with reason
`not_processed`, and the status is `partial`.

## Caches

| cache | lifetime | size | source |
|---|---|---|---|
| Results | `cacheTtl` (default 1 h); plain scrapes, and extractions only when `complete` | — | `packages/shared/src/utils.ts` |
| Fetched pages (snapshots) | 300 s (env `SNAPSHOT_TTL_SEC`; 0 = off); `cacheTtl: 0` bypasses; only pages the router's quality gate accepts | 4 MB compressed per page | `throughput/snapshot.ts` |
| Fetch strategy per site and section | 24 h after the last request | 16 sections per site | `engine/router.ts` |
| Extraction recipes | 14 days | — | `extract/recipe/` |

## Measured behaviour

Source: `npx tsx tests/load/mixed-load.ts --jobs 150 --clients 8`. Setup:
- the real worker process with 8 jobs in flight and 2 browser contexts;
- a local site on loopback, so these times exclude internet latency;
- results in `tests/load/results/`.

| scenario | result |
|---|---|
| 150 mixed jobs, 8 clients | 17 jobs/s. p50 / p95: static page 23 / 425 ms; product with JSON-LD extraction 24 / 423 ms; 500 KB page 384 / 898 ms; client-rendered page (browser) 738 / 1,435 ms; page taking 1.5 s 1,600 / 2,083 ms |
| Failing site (500) and rate-limiting site (429) | every job fails retryably in 0.5–1.8 s, at most 4 fetches per job, and no browser is started |
| 20 identical requests at once | the origin is fetched once (the rest are coalesced or use the snapshot) |
| One page, three schemas in a row | one fetch; the second and third requests take about 10 ms |
| Worker killed (SIGKILL) with 10 jobs in flight | all 10 finish on a new worker about 35 s later (BullMQ lock expiry; env `BULLMQ_LOCK_DURATION_MS`, default 30,000) |
| Redis restarted under the worker | the worker reconnects; new jobs complete at once. With no persistence, queued jobs are lost, so run Redis with AOF in production |

Live model figures are measured separately, in `tests/eval/README.md`:
- the extraction benchmark, per model;
- a 600-card listing: 31 s on Gemini 2.5 Flash-Lite, 87 s on Claude Haiku 5.5.
