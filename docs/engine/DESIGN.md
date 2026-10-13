# ScrapeForge engine: design for robust, grounded extraction

Status: in progress. Scope is the engine only (fetch → parse → extract → validate).
Login, billing, dashboard, SDKs, GraphQL and crawling are out of scope.

Source plan: "ScrapeForge: engine research and implementation brief" (7 Oct 2026).

## Goals

1. Extraction never runs model-written code. Reusable extractors are declarative
   recipes executed by trusted code.
2. Extraction works from a structure-preserving view of the page (blocks, tables,
   records, structured data), not only from markdown.
3. Cheap deterministic paths first (structured data → validated recipe), the LLM
   only for what remains.
4. Every returned value is traceable to source evidence; values the model cannot
   ground are rejected, not silently returned.
5. Outcomes are honest: `complete | partial | failed`, explicit missing reasons,
   schema validity, truncation, warnings, stage timings. No invented confidence.
6. Outbound requests cannot reach private/internal networks (HTTP, redirects,
   browser sub-requests, webhooks).
7. Every stage is timed so speed work is driven by measurements.

## Module map (apps/worker/src/extract/)

| Module | Responsibility | Main export(s) |
|---|---|---|
| `types.ts` | Shared contracts | types only (+ `LlmError`) |
| `document/` | Raw HTML → `SourceDocument` (blocks, tables, record groups, structured data, template signature). Never executes page scripts. | `buildSourceDocument(html, url): SourceDocument` |
| `schema/` | Customer schema → `NormalizedSchema` (JSON Schema or shorthand), limits on size/depth/refs/patterns | `normalizeSchema(input): NormalizedSchema` (throws `SchemaError`) |
| `validate/` | Ajv validation with bounded compiled-validator cache; value normalization in code; grounding checks | `validateOutput`, `normalizeValue`, `checkGrounding` |
| `structured/` | Deterministic mapping of JSON-LD / microdata / embedded JSON / meta to schema fields | `extractFromStructuredData(doc, schema)` |
| `recipe/` | Recipe validation, safe interpreter, Redis store with candidate→active lifecycle and drift invalidation, deterministic induction, LLM recipe proposal prompt/parser | `validateRecipe`, `runRecipe`, `RecipeStore`, `induceRecipe`, `buildRecipePrompt`, `parseRecipeResponse` |
| `llm/` | Provider adapters, capability registry, error classification, circuit breaker, budget/deadline, prompt + response protocol, fake providers for tests | `ModelClient`, `buildExtractionPrompt`, `parseExtractionResponse` |
| `engine.ts` | Orchestrates the stages and assembles `ExtractionOutcome`; challenge-page detection; recipe learning | `extractStructured(req, deps)`, `flushRecipeLearning()` |
| `index.ts` | Public barrel used by the worker | engine entry point and public types |

Outbound guard lives in `packages/shared/src/net.ts` (used by API and worker).
Stage tracing lives in `apps/worker/src/tracing.ts`.

## Extraction flow

```
raw HTML ─► buildSourceDocument ─► blocked/challenge page? ──yes──► failed (no LLM spend)
                │
                ▼
     structured data mapper ──fills all fields?──► validate ─► outcome
                │ (remaining fields)
                ▼
     active recipe for (tenant, host, template, schema)? ──ok + invariants──► validate ─► outcome
                │ (none / drifted → invalidate)
                ▼
     LLM extraction over annotated blocks (raw values + block citations)
                │
                ▼
     grounding check ─► normalize in code ─► Ajv validate ─► outcome
                │
                └─► (async, best effort) induce (or propose) recipe → candidate; promote after
                    agreeing with grounded LLM results on ≥ 2 more distinct snapshots
```

### Engine stages (engine.ts)

`extractStructured(req, deps)` never throws for page or model problems; it
throws `TypeError` only for a malformed request/deps object. Stage times go to
`deps.tracer` (the worker's per-job `StageTracer`) and to `outcome.timings`:
`schema`, `document`, `structured`, `recipe`, `llm`, `validate`, `learn`
(awaited learning only).

1. **Schema**: `normalizeSchema`; a `SchemaError` → `failed`, warning
   `invalid_schema:<code>: <message>`, no other work.
2. **Document**: `buildSourceDocument`, text prepared once for grounding.
   `<html lang>` sets the decimal separator for ambiguous "1.234".
3. **Blocked page**: `deps.sourceBlocked` (the worker sets it from the quality
   report: bot-wall indicators with HTTP 403/429/503, or challenge-specific
   indicators with a near-zero score) or the engine's own detector: at most
   2,000 chars of visible text and two of {challenge title, challenge text,
   challenge markup such as `cdn-cgi/challenge-platform`, `cf-turnstile`,
   `captcha-delivery.com`} (one suffices under 500 chars). → `failed`,
   `source_page_blocked:<reason>`, no model call.
4. **Structured data**: raw values are normalized in code. Visible values are
   *verified* and final; non-visible ones (and schema.org enumeration URLs for
   text fields) are *unverified*, kept only as a fallback. Site scaffolding
   (Organization, Person, WebSite, WebPage/CollectionPage, lists, navigation)
   is the record of an object/auto schema only when it is the kind of thing
   the fields describe best (an Organization for name + telephone), or, for a
   page entity, when every field is a generic page fact: the shop's
   Organization is never the product of a product page. Listings use
   structured records only when every record fills every field visibly
   **and** the list covers the page: when the record group holding its
   records is larger by more than 10% (a featured-items or SEO-capped
   ItemList), the model reads the page (`structured_list_incomplete:<a>_of_<b>`)
   and the structured records are only the fallback (partial, `not_processed`
   on the list) if the model cannot run. A list cut by the mapper's record
   cap is returned as truncated/partial. `auto` schemas follow the mapper's
   object/list decision, but only a content entity that fits the fields
   settles "one object"; page metadata leaves the decision to the model.
   An explicit `type: object` schema returns one record; when the model
   returned several, the values came from a repeated record group, or the
   structured record is a list member, `multiple_records_for_object_schema:<n>`
   says so (status unaffected).
5. **Recipe**: only an **active** recipe for
   `(tenant, host, templateSignature, schemaHash)` is used. It runs with at
   least 1 s of its own even past the request deadline (it is local and
   needs no model); a run cut short by time or a work budget is
   inconclusive (`recipe_inconclusive:deadline_or_budget`, no `recordUse`),
   never drift. Its values are normalized, `checkInvariants` decides,
   `recordUse(ok)` counts. Object recipes fill the fields they cover;
   listing recipes are used only when they cover every field (records are
   never merged across sources).
6. **LLM**, only for unresolved fields (a reduced schema): the input budget is
   `planInputBudget(primary model)` with output reserved at ~40 tokens per
   field per expected record (largest record group or table), min 1,024,
   clamped to the model's output limit. When that reservation exceeds the
   limit, the input is also sized by output capacity: records of the largest
   group are sent only as far as the answer can hold them (per record: each
   field's JSON framing plus the record's own text, ×1.2), with
   `output_limit_records:<k>_of_<n>`. `renderBlocks` fills it; a cut sets
   `scope.truncated` and `input_truncated`. One shared `Budget` (request
   deadline, `maxCostUsd`). `parse_error` → one repair call;
   `output_truncated` → one retry with 60% of the records sent (half the
   input when there is no record group); `input_too_large` → one retry with
   half the input; other failures stop. Every attempt (failed ones too) is
   in `outcome.llm`.
7. **Grounding + normalization** of each model value: cited block / its
   attributes / its record → accepted; elsewhere on the page → accepted with
   `citation_mismatch:<path>` and an evidence `note`; nowhere →
   `rejected_ungrounded` (value null). `x-derived` fields skip grounding and
   are labelled. Then `normalizeValue`: `ambiguous` → missing `ambiguous`;
   unparseable/type mismatch → missing `unparseable` with detail (the page
   shows something; it is not genuinely absent). Object fields have their
   leaves normalized by the sub-schema's declared types (a nested "Yes" for a
   boolean becomes `true`).
8. **Merge** (objects): verified structured > recipe > grounded LLM. A field
   asked because its structured value was unverified takes the LLM value
   (`conflict:<field>` when they differ) or, when the LLM has none, the
   unverified value (`structured_value_not_visible:<field>`, grounded false).
   When the model could not check it at all (provider failure, no model,
   `llm` disabled), the value is still returned but the outcome is partial
   (`unverified_values:<field>`).
9. **Output**: JSON pointers into the final data (wrapper kept:
   `/items/3/price`). Null values are kept for nullable or required fields
   and left out for optional non-nullable ones (null would be schema-invalid).
   Listing records without any value are dropped; when a dropped record had
   values that were rejected (or ambiguous/unparseable), a list-level missing
   entry with that reason makes the outcome partial. Ajv validation last.
10. **Learning** (`deps.learning`: `background` default, `await`, `off`; also
    `disable: ['recipe-learning']`): only after an LLM run whose requested,
    non-derived values were all cleanly grounded and normalized, not
    truncated, with no active recipe in play. An existing candidate is run on
    the snapshot and compared (`recordAgreement` / `recordDisagreement`);
    otherwise `induceRecipe` from the raw model values of the first 20
    records (record group of the cited blocks as `recordSelector`), saved as
    a candidate only if it reproduces this result. Induction itself already
    requires every non-empty sample value to be reproduced; when a selector's
    first match is wrong in some records (a struck-through "was" price before
    the current one), it is narrowed by what tells the two apart (a class or
    ancestor of the wrong one such as `:not(.was)` or `:not(del *)`, a
    line-through style, or position) instead of being accepted at 90%. Agreement is exact and
    covers every grounded record of the run: the same record count, and
    every compared value equal (`compareOutputs` over the list, then record
    by record). A single wrong value (a sale card's struck-through price)
    blocks the save, and drops an existing candidate. With `EXTRACT_RECIPE_PROPOSE=1`, a failed
    induction asks the model for a recipe (one more call, within the
    request's remaining spend cap). Background learning starts after the
    answer, is bounded (4 in flight per process), and only logs failures;
    `flushRecipeLearning()` drains it (worker shutdown, tests).

### Outcome semantics

* `complete`: `schemaValid`, not truncated, and every `missing` entry is
  `not_found` on a field that may be null or absent per the schema.
* `partial`: data, but anything else missing (`rejected_ungrounded`,
  `ambiguous`, `unparseable`, `provider_failure`, `truncated`,
  `not_processed`), truncated input (or a structured list cut by the
  mapper's cap), schema-invalid data, or a structured value returned
  unverified because the model could not check it.
* `failed`: `data` is null (blocked page, invalid schema, nothing usable,
  an object with no non-null field, a listing with no record).
  `method` is then `none` and `schemaValid` false.
* `method`: where the returned values came from (`structured-data`,
  `recipe`, `llm`, or `mixed`).
* `evidence` is always computed but returned only with `includeEvidence`.

### Worker and API integration

* The worker builds one `ModelClient` (`createDefaultModelClient(env)`) and a
  `RecipeStore` over its Redis at startup. Per job: `fetch` (router, with
  tier attempts) → quality score → content extraction (`content`, Piscina
  pool) and structured extraction (`extract`) **concurrently**. Extraction
  deadline = job start + `timeout` − min(2 s, 10 %). Spend cap = min(request
  `maxLlmCostUsd`, `EXTRACT_MAX_COST_USD`, default $0.05).
* Job deadline: every job ends by `timeout` + 2 s, whatever the router does
  (it gives each browser tier the full `timeout`). Past it the job fails
  with a timeout error, the content extraction is aborted, the job's
  browser pages are closed (their contexts go back to the pool) and no
  further context is handed to the job.
* `content.json` = outcome data (omitted when null); `metadata.extraction` =
  status, method, schemaValid, schemaErrors, missing, warnings, scope,
  `llm {calls, tokens, costUsd, models}`, evidence (on request);
  `metadata.timings` = tracer snapshot. Only `complete` extractions are
  cached (plain scrapes always, when `cacheTtl` > 0): a partial or failed
  one may come from this request's spend cap, deadline or a transient
  provider failure. Key and contents: see "Caches".
* API: `includeEvidence` (default false) and `maxLlmCostUsd` (0–1) on
  `/v1/extract` and `/v1/scrape`; schemas over 64 KB or 10 levels → 400
  before queueing. Sync jobs: 2 attempts, fixed 250 ms; webhook jobs: 3
  attempts, exponential backoff. Not retried (unrecoverable): private or
  otherwise blocked destinations (including a redirect hop or page
  navigation the egress guard refused), unresolvable hosts, and exhausted
  tiers when some tier got a block or unusable page. Exhausted tiers that
  all failed transiently (network errors, timeouts, 408/429/5xx without
  block markers) and a missed job deadline are retried.
* Configuration (`.env.example`): `EXTRACT_MODELS`, `EXTRACT_MODEL_CAPS`,
  `EXTRACT_MAX_COST_USD`, `EXTRACT_LLM_TIMEOUT_MS`, `EXTRACT_RECIPE_PROPOSE`,
  provider keys.

### Measuring

* `tests/engine/engine-corpus.test.ts`: every corpus fixture through the
  engine with a gold-oracle fake model (`tests/engine/oracle.ts`, answers
  from the prompt text only) plus adversarial models (invented values, wrong
  citations, injection-obeying, small context).
* `tests/eval/run-extraction-eval.ts`: the same corpus against real models
  (`OPENROUTER_API_KEY`), per-model precision/recall, status accuracy,
  latency percentiles, cost per correct field. See `tests/eval/README.md`.

### Known limitations

* Visible text that contains an injected instruction is still page text: a
  model that obeys it can return grounded but wrong values (the hidden
  injection text never reaches the model).
* Partitioning splits the largest record group only. A listing that is one
  huge table, or whose items form no detected group, is still sent in one
  call and reported `partial` with `truncated` when it does not fit.
  Targeted selection serves object answers only.
* A structured list is compared with the record group that holds its
  records; a list whose records sit in no detected group is not judged.
* A boolean inside an object field that the page does not name by its key
  is accepted only alongside other grounded members of the same object.
* The input budget is planned for the primary model; a fallback with a
  smaller context window is skipped for an input that does not fit it.
* Document building, grounding and recipe induction run on the worker's main
  thread (induction is bounded to ~2 s per learning run, 4 runs in flight).
* Request `cookies` are validated and enter the cache key, but no fetch
  tier applies them yet (a gap that predates this package): the page is
  fetched without them. Custom `headers` are sent by the HTTP tiers (T1,
  T2) only, not by Lightpanda (T3) or the browser tiers (T4, T5).

### Large inputs (Phase 2)

When the page fits one call, nothing changes: it is sent whole
(`scope.strategy: "single"`). Otherwise the strategy depends on the answer's
shape.

**Listings (array schemas) are partitioned.** This applies when the largest
record group's answer exceeds the output limit, or the page exceeds the
input budget. `partitionPlan` sizes chunks to whichever limit is smaller:

* the output limit: the same estimate as `outputRecordCap`;
* the input budget: the rendered size of a sample of 50 records.

Each chunk is rendered on its own (only its record frames) and sent as an
ordinary extraction call.

* Calls run concurrently: up to 4 at a time, set by
  `EXTRACT_PARTITION_CONCURRENCY`, at most 16.
* All calls share one `Budget`. Each call reserves its worst-case cost
  while in flight (`Budget.reserve`), so concurrent calls cannot together
  pass `maxCostUsd`.
* Once the deadline or the cost cap is reached, the remaining chunks are
  skipped.
* A chunk whose answer is cut off (`output_truncated`) or that does not fit
  (`input_too_large`) is halved and retried, at most 3 times.
* There are at most 64 chunks. The rest are skipped.

Answers are merged in page order. An answer is dropped as a repeat only
when it has the same home record (see Grounding) and the same accepted
values as one already kept. A card cited by mistake for another card never
costs that card its record. Repeats are counted in the warning
`partition_duplicates_dropped:N`.

Every chunk is recorded in a ledger. `scope.partitions` gives
`{chunks, done, failed, skipped, recordsPerChunk}`. Chunks that are not
done give:

* `scope.truncated: true`;
* a list-level `missing` entry naming the unprocessed record ranges and
  their reason, e.g. "216 of 400 records were not processed: records
  1–216 (unknown)";
* status `partial`.

A listing answered in full is `complete`, and recipe learning runs on it,
so the next page of the same template needs no model call. The
`large-listing` fixture (600 cards) is now `complete`, with all 600
records. That takes 3 calls on a model with 8k output and 128k context, and
7 calls with a 32k context.

**Single answers (object schemas) use targeted selection.**
`document/select.ts` scores every block with BM25 against the field names
(split from camelCase and snake_case), their descriptions and enum values,
plus a few related words. "price" also matches "cost", "sale" and "msrp".
Each block's text, heading path and the attributes shown to the model are
scored. The selection keeps:

* the top 15% of the page;
* then the best-scoring blocks, each with the block before and after it;
* then the rest in page order while room is left.

It is rendered in page order (`scope.strategy: "selected"`, warning
`input_selected:<sent>_of_<total>_blocks`). If every asked field is found,
the outcome can be `complete`. A field not found is `not_processed`, not
`not_found`, because it may be in what was not sent. `scope.truncated` is
then true and the status `partial`.

Both strategies can be turned off per request for diagnostics:
`disable: ['partition']` or `disable: ['select']` falls back to the Phase 1
single call, cut at the budget and reported `truncated`.

### Throughput (Phase 3)

All of this lives in `apps/worker/src/throughput/` and is wired in
`worker.ts`. Each part degrades to "do the work" when Redis fails: a cache,
limiter or coalescer never fails a job.

**Request coalescing** (`coalesce.ts`). A job claims its request key with
`SET NX PX`. The key is the result-cache key (tenant, URL, formats,
schema, credentials digest, spend cap), and the claim expires at the job's
deadline.

* An identical job that finds the claim waits for the leader's
  `result:<jobId>` and returns a copy, with `metadata.cached: true` and
  `metadata.coalescedWith: <leader>`. It still delivers its own webhook
  and SSE events.
* If the leader fails or does not finish within the follower's timeout,
  the follower does the work itself.
* A queued job whose identical predecessor has already finished is served
  from the result cache when the request allows caching.
* `COALESCE_REQUESTS=0` turns coalescing off.

In the end-to-end smoke test, 3 identical jobs submitted together fetched
the origin once.

**Fetch snapshot cache** (`snapshot.ts`, key `snapshotCacheKey` in
`packages/shared`). Clean fetches are kept, gzip-compressed, for
`SNAPSHOT_TTL_SEC` (default 300 s). A clean fetch has:

* status 2xx or 3xx;
* no block or challenge page;
* no screenshot;
* a compressed size of at most 4 MB.

The key holds only what shapes the fetch: tenant, URL, proxy, mobile,
`waitFor`, `blockResources` and the credentials digest. A request for the
same page with another schema or other formats skips the fetch, and so
does a retry after a partial extraction. The result then shows
`metadata.snapshotAgeMs`, and the fetch adds no compute or proxy cost.
`cacheTtl: 0` neither reads nor writes. In the smoke test, a second schema
on a page that takes 1.5 s to fetch completed in 15 ms.

**Concurrency budgets** (`limits.ts`):

* **Browser contexts.** `BrowserPool`, set by `MAX_BROWSER_CONTEXTS` (as
  before).
* **Fetches per site, across all worker processes.** Expiring leases in a
  Redis sorted set per host, acquired by a Lua script (`www.` shares the
  host's budget), set by `FETCH_DOMAIN_CONCURRENCY` (default 6). A
  crashed worker's leases expire at its job deadline. A job that gets no
  slot before its deadline fails with a retryable timeout. A snapshot hit
  never takes a slot.
* **Model calls per process.** A shared semaphore in `ModelClient`
  (`gate`), set by `EXTRACT_LLM_CONCURRENCY` (default 16). Partitioned
  listings run several calls per request; this keeps a busy worker under
  provider rate limits. A call still waiting at its budget deadline ends
  as `budget_exhausted`.
* **Cost.** Concurrent calls of one request share its `Budget` with
  per-call reservations (see Large inputs).

### Fetch routing (Phase 4)

`engine/router.ts` tries tiers from cheap to expensive:

* T1: HTTP;
* T2: HTTP with a browser TLS fingerprint, plus the proxy;
* T3: Lightpanda;
* T4: browser;
* T5: stealth browser.

Each request starts at the tier its learned strategy suggests. Since Phase
4, a rejected response is classified (`classifyRejection`), and the class
decides what happens next.

| class | when | next |
|---|---|---|
| `server_error` | 5xx with an ordinary body (no block markers; small or script-free) | Retry the same tier once after 500 ms, then stop with a retryable error. No browser. |
| `rate_limited` | 429, 408, or 503 with `Retry-After` | Take the proxy route (T2) when a proxy is set. Otherwise wait `Retry-After` (at most 3 s, and at most a quarter of the timeout) and retry once, then stop with a retryable error. A longer `Retry-After` stops at once. More engines only add load. |
| `js_required` | App shell, "JavaScript required" notice, or a client-side redirect | Skip the second HTTP client and go to a browser tier. |
| `blocked` | Block or challenge page, a 403, or a large script-carrying error page | The usual ladder: TLS identity and proxy, then browser, then stealth. |
| `thin` | Little content for other reasons | The usual ladder. |

The class prefixes the reason in `metadata.timings.attempts` and in the
exhausted error, e.g. `T1:server_error: invalid content (status=500 …)`. A
retryable stop raises `TiersExhaustedError` with `transient: true`, and the
worker retries the job with backoff.

**Outages are not learned.** `server_error` and `rate_limited` outcomes are
the site's, not the tier's, so they are not recorded against the tier. An
outage used to teach a domain to start on a browser for a day. Now the next
request starts where it always did.

**Per-section learning.** Statistics are kept for the site (`domain:{host}`)
and for its section (`domain:{host}|{section}`). Both expire 24 h after the
last write.

* The section is the first path segment, lower-cased, after a language
  prefix such as `/en-us`.
* An id-like first segment gives `/*`, and the home page is `/`.
* Examples: `/dp`, `/search`, `/en-us/search`.

A request uses the section's statistics once they reach a verdict (enough
recent outcomes), otherwise the site's. A site whose product pages are
server-rendered while its search pages need a browser then pays for the
browser only on search pages.

### LLM response protocol

The model returns raw values exactly as shown on the page plus the block id it
read them from. Code performs every conversion (currency stripping, number
parsing, booleans, absolute URLs).

```json
{"records": [{"title": {"v": "A Light in the Attic", "b": "b14"},
              "price": {"v": "£51.77", "b": "b17"}}]}
```

* Always an object envelope (`records`), so `json_object` mode works for listing
  pages too (a top-level array is invalid in that mode).
* `{"v": null}` = not present on the page.
* Fields marked `x-derived: true` may be inferred; they are flagged `derived`.

### Grounding

A scalar value is grounded when its raw text (whitespace/case-normalized; numbers
compared by digits) occurs in the cited block's text or evidence attributes, or
in its record block. Ungrounded short values are rejected → `missing` with reason
`rejected_ungrounded`. Long free text uses token overlap and is kept with a
warning when weak. Derived fields are exempt but labelled. Arrays and objects
are grounded when every non-empty member is; a boolean member (the response
schema asks for real booleans inside objects) has no printed form: it counts
as grounded when the page names its key ("Wireless: Yes" for `wireless`) and
is otherwise left to the other members. An object of booleans the page does
not name is unverified and rejected.

A cited value that does not appear as written gets these further checks, all
in `engine.ts` (`groundIn`, `matchByMeaning`):

* **As a number.** For a number field, a value like "512 GB SSD" is looked
  up as the number it normalizes to (512).
* **By meaning.** For a number or boolean, the value can be confirmed by a
  short text of the cited block: the block itself, one of its sentences or
  lines, or an attribute of its record. That text must normalize to exactly
  the same value. Examples: "3" for class "star-rating Three", `false` for
  "It is not eligible for fully remote work."
  * For a boolean, the block must not also say the opposite.
  * For a cited table, only the row naming the answer's own values counts
    (a cell equal to "Nova X1"), narrowed to the column whose header names
    the field ("5G" for `has5g`).
  * Link and image attributes are never used.
  * The evidence note says what matched, and the warning
    `grounded_by_meaning` is added.
* **In its own listing record.** An answer's home record is the record
  that at least two of its cells cite, more than any other record. A value
  whose citation fails, or that has none, is looked for in that record and
  accepted with `citation_mismatch`. A number found only elsewhere on the
  page is rejected when it is printed on another card of the same list and
  not on this one: it belongs to that card. A number printed outside the
  cards, such as in a comparison table, is kept.
* **With a block-id suffix.** "b22-r3" or "b22.3" reads as `b22`, with the
  warning `block id suffix ignored`.
* **As model filler.** A model placeholder that is printed nowhere ("N/A",
  "Not specified", "unknown") counts as not found, not as an ungrounded
  value.

Normalization follows the field. If a number field names its unit ("SSD
capacity in GB", `weightKg`, "Battery (mAh)"), the number printed in that
unit is the value: "512 GB PCIe 4.0" gives 512. A value printed only in
another unit of the same quantity is converted when the factor is exact,
and rounded to the printed precision: "3.09 lb" gives 1.4 kg. Otherwise the
value is `ambiguous`; "1 TB" for GB could mean decimal or binary units.

A row of star glyphs counts its filled stars: "★★★★☆" is 4 and "★★★½☆" is 3.5.

Text saying there is no value becomes null with reason `not_found` and the
detail "the page states no value". Examples: "Contact sales", "Price on
request", "TBA", "Coming soon", "N/A", "—", "Sold out", "Unlimited seats",
and their de/fr/es/it/pt/nl forms. "Free", "None" and "No reviews" stay
`unparseable`, since they may mean 0.

### Outcome status

Summarized here; exact rules under "Outcome semantics" above.

* `complete` — schema-valid, nothing missing except genuinely absent optional/nullable values, not truncated.
* `partial`  — some data, but missing required fields, schema errors, truncation,
  or rejected values. `data` still returned, `schemaValid` tells the truth.
* `failed`   — no usable data (blocked page, provider failure, nothing found).

### Model selection

`EXTRACT_MODELS` lists registry keys in priority order. The benchmarked
default is `openrouter:google/gemini-2.5-flash-lite,openrouter:anthropic/claude-haiku-5.5`
(fastest and cheapest with 100% value precision/recall on the corpus; Haiku
5.5 is the most accurate fallback, see `tests/eval/README.md`).
The first is primary; the rest are bounded fallbacks. Fallback depends on the
error category: `auth` circuit-breaks that provider; `rate_limit/overloaded`
back off once then fall back; `output_truncated` retries with fewer blocks;
`parse_error` gets one repair attempt; `unsupported_request` retries without
`json_schema` (local validation still enforces the customer schema).
Legacy env keys (GROQ_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY,
OPENAI_API_KEY) still work when EXTRACT_MODELS is unset.

### Caches

* Result cache — `cache:<hash>`, written by the worker and read by the API
  with the same function (`resultCacheKey` in `packages/shared`), so the two
  keys cannot drift. The hash covers the tenant, the URL, `formats`,
  `proxy`, the fetch-shaping options (`screenshot`, `mobile`, `waitFor`,
  `blockResources`), `extractSchema`, `includeEvidence`, `maxLlmCostUsd`
  (with a schema only) and a SHA-256 digest of the custom `headers` and
  `cookies` (order- and header-case-independent; the values themselves
  never enter the key). `timeout`, `cacheTtl` and `webhookUrl` do not.
  Only cacheable results are written (`isCacheableResult`: plain scrapes,
  and extractions whose status is `complete`), for `cacheTtl` seconds;
  `cacheTtl: 0` neither reads nor writes.
* Browser contexts — pooled and reused across tenants, so before reuse the
  pool closes leftover pages and clears cookies, the origin storage of
  every origin the fetch touched (localStorage, IndexedDB, Cache Storage,
  service workers) and the context's HTTP cache.
* Extraction recipes — `recipe:v1:{tenant}:{host}:{template}:{schemaHash}`.
* Compiled Ajv validators — in-process LRU by schema hash.

## Phases

| Phase | Deliverable | Status |
|---|---|---|
| 0 | Build fixed, stage tracing, reproducible extraction baseline | in progress |
| 1 | Source-preserving document, deterministic paths, model layer, validation, grounding, recipes; engine wired into worker and API | done (live-model benchmark pending an API key) |
| 2 | Large inputs: targeted (BM25 block selection) vs exhaustive (partitioned, ledger, merge by record identity) | done (see "Large inputs (Phase 2)"); tables are not partitioned yet |
| 3 | Fetch snapshot cache, request coalescing, readiness-based browser waits, concurrency budgets | done (see "Throughput (Phase 3)") |
| 4 | Router: classify failures, engine vs network route, expiring per-template learning | done (see "Fetch routing (Phase 4)") |
| 5 | Mixed-load and recovery checks, published limits | later |

Inputs larger than the model budget are never silently cut. Phase 2 sends
the relevant blocks, or every record in chunks. Whatever still could not
be processed is reported with `truncated: true`, `status: partial` and
`missing` entries with reason `not_processed`.
