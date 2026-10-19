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
* Request `cookies` and custom `headers` are applied by the HTTP tiers
  (T1, T2) and the browser tiers (T4, T5), but not by Lightpanda (T3). A
  request that carries either skips T3. See "Request cookies and headers".
* In a browser tier, a request to the target's origin that carries a
  custom header other than the ones browsers send anyway is sent by
  Playwright (fetch and fulfill), not by Chromium's own network stack, so
  its TLS fingerprint is not the browser's and the response is buffered.
  Cookies and headers such as Accept-Language do not need this. Streams
  (media, EventSource, WebSocket) are left to Chromium and go without the
  credential. A `fetch()` or XHR body the page reads as a stream arrives
  only when it ends; with the credential, an endless stream never arrives
  (its fetch ends at the tier's budget).

### Request cookies and headers

`engine/request-credentials.ts` decides what each tier sends.

* **HTTP tiers (T1, T2).** Matching cookies go in a `Cookie` header,
  appended to a custom one if the request has it. A cookie matches by RFC
  6265 rules:
  * domain: the host, or a parent domain when the cookie sets one;
  * path: a prefix of the URL's path.

  `headersForHop` drops `Cookie` and `Authorization` once a redirect
  leaves the starting origin.
* **What no tier can send is dropped.** A cookie whose name is not a
  token, or whose value has `;` or any control character (tab included).
  A header whose name is not a token, or whose value is not Latin-1 or has
  a control character other than tab. Such input made HTTP clients throw
  and browser requests hang. The API refuses it up front with a 400
  (`apps/api/src/routes/credentials.ts`).
* **Browser tiers (T4, T5).** The cookies are added to the pooled
  context, including those from a custom `Cookie` header. Chromium then
  applies its own domain and path matching. A host-only cookie is bound to
  the host and keeps its own path. For an https target every cookie is
  Secure, as the site set it (a `__Secure-` or `__Host-` cookie is refused
  otherwise). A cookie the browser refuses is skipped without losing the
  others. The pool clears every cookie when the context is released,
  before another fetch can get it.
* **Custom headers in the browser.** They are added by the page's route
  handler only to requests for the target's own origin (scheme, host and
  port). Scripts, images and frames from other origins never see an
  `Authorization` or any other custom header.
  * Headers a browser sends anyway (Accept, Accept-Language, User-Agent,
    Referer, Cache-Control, DNT, ...) are set on Chromium's own request,
    so its fingerprint and `Sec-Fetch-*` headers are kept.
  * Any other header may be a credential. Chromium keeps a continued
    request's header overrides on every redirect hop, and the hops never
    reach the route handler: a target redirecting to an identity provider
    would carry the credential there. So every request to the target's
    origin that does not stream (documents, scripts, styles, images, XHR,
    fetch, ...) is fetched by the route handler with the credential,
    without letting Playwright follow redirects (`route.fetch`,
    `maxRedirects: 0`, bounded by the tier's budget), then fulfilled; each
    body is released once served. Pages behind Basic auth, an auth proxy
    or an API-key gateway load their own scripts and styles.
    * A redirect within the origin is followed by the handler, with the
      credential, at most 10 hops, each checked by the SSRF guard. A 303,
      or a 301/302 answering a POST, becomes a GET without a body, as in
      browsers.
    * A redirect to another origin goes back to the browser, which
      follows it without the credential.
    * A navigation whose redirects the handler followed is loaded once
      more at the URL it ended on (fragment kept), so the page has its own
      address for its relative links.
    * Streams (media, EventSource, WebSocket) are continued by Chromium
      without the credential.

    Pooled contexts use the egress guard as their proxy, so these fetches
    pass through it like Chromium's own.

`test/fetch/request-credentials.test.ts` checks this against real servers
and a real browser:

* the target gets the headers and cookies;
* a third-party host gets neither;
* another port of the same host gets no custom headers;
* a navigation, or an image, that redirects to another origin takes no
  custom header there;
* every hop of a redirect within the origin keeps the credential: a
  fragment URL, a chain that would end on a login page or an identity
  provider without it, an API call redirected to a trailing slash;
* the page's own scripts and styles behind Basic auth get it;
* headers browsers send anyway keep Chromium's `Sec-Fetch-*` headers, and
  a stream on the target's origin still streams;
* the next fetch on the reused context carries nothing over.

### Large inputs (Phase 2)

When the page fits one call, nothing changes: it is sent whole
(`scope.strategy: "single"`). Otherwise the strategy depends on the answer's
shape.

**Listings (array schemas) are partitioned.** This applies when the largest
record group's answer exceeds the output limit, or the page exceeds the
input budget. A listing that fits one call on a page that does not (a long
intro or menu above the grid) is sent as one chunk: the records alone, not
the top of the page. That happens unless something the top of the page
would send is the listing instead: a table, another group's records, or a
run of sections (headings). The largest structure is the listing, as for
the expected record count, and scores are BM25 over the fields, as for
selection. A rival
* twice the group's size or more wins, unless it does not name the fields
  and the group does: a changelog printed as 900 "Version x" headings, or
  a 12-row release table, is not replaced by three blog cards beside it;
* of comparable size (half or more) wins when it names the fields better;
* much smaller never wins: a strip of four deals above a 40-card grid is
  not the listing, however well its tiles score.

Sums over the whole top are not compared: a long menu outscores any grid
by its size alone. An empty answer there is a `not_processed` gap. `partitionPlan` sizes chunks to
whichever limit is smaller:

* the output limit: the same estimate as `outputRecordCap`;
* the input budget: the rendered size of a sample of 50 records.

Each chunk is rendered on its own (only its record frames) and sent as an
ordinary extraction call.

* Calls run concurrently: up to 4 at a time, set by
  `EXTRACT_PARTITION_CONCURRENCY`, at most 16. One scheduler runs them,
  so halves of a split chunk use the free slots too.
* All calls share one `Budget`. Each call reserves its worst-case cost
  while in flight (`Budget.reserve`), so concurrent calls cannot together
  pass `maxCostUsd`. Reservations are far above what calls spend, so:
  * a chunk the cap cannot cover next to the calls in flight waits for
    them, and a call refused for budget while siblings hold reservations
    is put back until one finishes;
  * a chunk alone whose answer (estimated from its cards, and priced as
    the model client prices the call) the rest of the cap cannot pay for
    on any configured model is halved before any call, or skipped when it
    cannot be halved. When only the primary is too dear, the chunk is
    sent: the client moves on to a cheaper fallback;
  * the client refuses a call whose expected answer the cap cannot pay for
    (`minOutputTokens`) rather than lowering max_tokens to an answer that
    would be cut off and billed: on one model, more budget never returns
    fewer records. With a cheaper fallback, the client still uses the
    primary for a chunk whenever the primary can pay for it, so a cap just
    above that point can return fewer records than a slightly smaller one
    (every chunk on the fallback);
  * once even the smallest chunk is unaffordable, the rest is skipped.
* Chunks stopped by the deadline or the cost cap are `skipped` with that
  reason, never reported as a provider failure. Neighbouring skipped
  pieces are reported as one range.
* A chunk whose answer is cut off (`output_truncated`), that does not fit
  (`input_too_large`), or that times out is halved and retried, at most 3
  times. A chunk that can still be halved is not retried whole on the same
  model after a timeout (`retryOnTimeout: false`), but the next configured
  model is still tried first: a hung primary sends chunks to the fallback,
  not into halving.
* A chunk answered with fewer records than cards, beyond the promo-slot
  tolerance (10%), is asked again for exactly the cards no record cites
  (once). A record that cites no card of the chunk (bare values, an
  unknown block id) but whose text is printed on exactly one card covers
  that card, so it is not asked for again (nor returned twice). Any other
  stray record (an empty one for a promo tile) stands for one card at
  most; the re-ask is dropped only when more than 20% of the records are
  such strays. A second
  short answer, or an empty answer while other chunks found records, is a
  gap ("returned 54 of 108"). A record that cites one card (a card with a
  single value) is deduplicated by that card.
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

The selection is sized in tokens (`estimateTokens`), not characters: a
Cyrillic or CJK page holds far fewer characters per token than an English
one. If its rendering is still over the budget, the blocks chosen last
(least relevant) are dropped, never the relevant ones lower on the page.

It is rendered in page order (`scope.strategy: "selected"`, warning
`input_selected:<sent>_of_<total>_blocks`). If every asked field is found,
the outcome can be `complete`. A field not found is `not_processed`, not
`not_found`, because it may be in what was not sent; the same holds when
the model returns no record at all. `scope.truncated` is then true and the
status `partial`.

Both strategies can be turned off per request for diagnostics:
`disable: ['partition']` or `disable: ['select']` falls back to the Phase 1
single call, cut at the budget and reported `truncated`.

### Throughput (Phase 3)

All of this lives in `apps/worker/src/throughput/` and is wired in
`worker.ts`. Each part degrades to "do the work" when Redis fails: a cache,
limiter or coalescer never fails a job.

**Request coalescing** (`coalesce.ts`). A job claims its request key with
`SET NX PX`. The key is the result-cache key (tenant, URL, formats,
schema, credentials digest, spend cap) plus what else shapes the result:
the timeout, and whether the request asked for a fresh page (`cacheTtl:
0`, which never reads a snapshot). The claim expires at the job's
deadline.

* An identical job that finds the claim waits for the leader's
  `result:<jobId>` and returns a copy, with `metadata.cached: true` and
  `metadata.coalescedWith: <leader>`. It still delivers its own webhook
  and SSE events.
* If the leader fails or does not finish within the follower's timeout,
  the follower does the work itself, within what is left of its own
  timeout (the job still ends by timeout + 2 s).
* A failed `result:<leader>` left by the leader's previous attempt (a
  BullMQ retry keeps the job id) is waited past while the leader holds
  the key.
* A follower waits as long as the leader may run (its timeout + 2 s). Left
  with less than min(5 s, a quarter of its timeout), it fails retryably
  instead of starting a fetch it cannot finish.
* A queued job whose identical predecessor has already finished is served
  from the result cache when the request allows caching.
* `COALESCE_REQUESTS=0` turns coalescing off.

In the end-to-end smoke test, 3 identical jobs submitted together fetched
the origin once.

**Fetch snapshot cache** (`snapshot.ts`, key `snapshotCacheKey` in
`packages/shared`). Clean fetches are kept, gzip-compressed, for
`SNAPSHOT_TTL_SEC` (default 300 s). A clean fetch has:

* status 2xx or 3xx;
* a page the router's gate accepts, valid content and quality (never a
  best-effort shell or a cloaked stub from the last tier);
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
  host's budget), set by `FETCH_DOMAIN_CONCURRENCY` (default 6).
  * The set's TTL is always its latest lease's expiry: a short job never
    drops other jobs' leases.
  * A lease lives 15 s from its grant (`leaseTtlMs`), whatever the job's
    deadline, and is renewed every 5 s while the router is at the site (an
    HTTP or Lightpanda fetch in flight cannot be aborted at the job
    deadline). It is released when the router is done. A slot granted
    late in a long wait still lives its full 15 s before its first
    renewal, and a crashed worker's lease expires 15 s after its grant or
    last renewal. Past the deadline the router starts no further tier.
  * Slots are shared max-min between the tenants waiting for a site: a
    tenant gets a free slot only when no other waiting tenant holds fewer,
    so one tenant's crawl cannot take every slot.
  * A crashed worker's leases expire on their own. A job that gets no
    slot before its deadline fails with a retryable timeout. A snapshot
    hit never takes a slot.
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
| `server_error` | 5xx with an ordinary error page: no block or vendor challenge markers, and either no scripts or a small page whose body prints something (its `<head>`, `<title>` and `<noscript>` do not count) | Retry the same tier once after 500 ms, then stop with a retryable error. No browser. |
| `rate_limited` | 429, 408, or 503 with `Retry-After`, with an ordinary body as above | Take the proxy route (T2) when a proxy is set. Otherwise wait `Retry-After` (at most 3 s, and at most a quarter of the timeout) and retry once, then stop with a retryable error. A longer `Retry-After` stops at once. More engines only add load. |
| `js_required` | App shell, "JavaScript required" notice, or a client-side redirect | Skip the second HTTP client and go to a browser tier. |
| `blocked` | Block or challenge page, a 403, or an error status whose body is a challenge: a vendor marker (Kasada's `KPSDK` and `ips.js`, `x-kpsdk-*` headers, ...), scripts with no text at all, or a large page with scripts | The usual ladder: TLS identity and proxy, then browser, then stealth. An error status counts against the tier only with a vendor marker. |
| `thin` | Little content for other reasons | The usual ladder. |

The class prefixes the reason in `metadata.timings.attempts` and in the
exhausted error, e.g. `T1:server_error: invalid content (status=500 …)`. A
stop on a failing or rate-limiting site raises `TiersExhaustedError` with
`transient: true`, even when an earlier tier was blocked, and the worker
retries the job with backoff.

* The one retry is judged by what it returns: an app shell or a block
  page on the retry goes on up the ladder from that answer.
* Lightpanda and the browser tiers follow the same rule. A 5xx or 429 at
  T3 or T4 is retried once and then stops retryably, without the stealth
  tier. A 5xx or 429 at T5 stops retryably whatever an earlier tier was
  refused, unless T4 got a page (status 200, below the bar): that page is
  the last-resort result. An error status (5xx, 429, 408) is never
  returned as a result.
* A re-probe or confirm below the learned tier that meets a server error,
  at any tier (Lightpanda, or T4 under a learned T5, included), goes on to
  the learned tier instead of failing the request. A rate limit is not
  handed on: it is answered by waiting or another IP.

**Outages are not learned.** `server_error` and `rate_limited` outcomes are
the site's, not the tier's, so they are not recorded against the tier. An
outage used to teach a domain to start on a browser for a day. Now the next
request starts where it always did.

**Per-section learning.** Statistics are kept for the site (`domain:{host}`)
and for its section (`domain:{host}|{section}`). Both expire 24 h after the
last write.

* The section is the first path segment, lower-cased, after a language
  prefix such as `/en-us`.
* An id-like first segment, or a long slug of several words
  (`/how-to-fix-a-leaky-faucet`), gives `/*`; the home page is `/`.
* Examples: `/dp`, `/search`, `/en-us/search`.
* At most 16 sections per site get their own key, tracked by last write
  in `domain-section-set:{host}`; one unwritten for 24 h gives its slot
  up, and sections beyond the cap use the site's statistics. Redis is
  shared with the job queue and runs without eviction.

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
  * For a boolean, nothing the block or its record says may read as the
    opposite: its words, its own attributes and class tokens (`feature
    feature--unavailable` on the "Touchscreen" item), or a card attribute
    named for the field (`data-in-stock`). The card's other attributes and
    class tokens (`instock`, `outofstock`) speak only to a field about
    availability: one named for it (`inStock`, `isAvailable`, `canBuy`,
    `isOrderable`, `lieferbar`, ...) or described as being in stock. A
    stock class says nothing about `has5g` or `freeShipping`, even when
    their description says "available", nor about `isPreorder` or
    `onBackorder`. A bare `0`, `1`, `true` or `false` counts, either way,
    only in an attribute named for the field; in `data-index` or
    `data-quantity` it says nothing.
  * A yes/no field true when the item is unavailable (`isSoldOut`,
    `outOfStock`) reads availability phrases the other way: "Sold out" and
    the `outofstock` class are true for it, "Yes" and "No" as written.
  * For a cited table, only the cells that can hold the value count. A
    header row of plain `<td>` cells names the columns too, in a table of
    three or more columns. In a header-less table of mostly two-cell rows
    the first row is a spec ("5G | Yes"), not a header, even when a row
    carries an extra info cell.
    * in a "Spec | Value" table, the value cell of the row whose label
      names the field ("NFC" for `hasNfc`), unless a header names it ("Dish
      | Vegan": the row "Vegan chili bowl" is a record, not the label); a
      two-column table whose labels do not name the field is read by its
      rows, as below;
    * otherwise, the row holding the most of the answer's own values that
      appear in that row only (a brand shared by several rows says
      nothing), in the column whose header names the field. An exact name
      wins over a longer one: "Warranty" before "Extended warranty".
    * The table is indexed once per block, so a long table cited by every
      record stays fast.
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
* **Uncited, elsewhere on the page.** A number with no citation, found
  only as the number it normalizes to, is accepted only when that number
  has at least three significant digits (512, 47.82). "4.5 out of 5" is
  4.5, which an unrelated "4.5 mm" does not confirm.

Normalization follows the field. If a number field names its unit ("SSD
capacity in GB", `weightKg`, "Battery (mAh)"), the number printed in that
unit is the value: "512 GB PCIe 4.0" gives 512. A value printed only in
another unit of the same quantity is converted when the factor is exact,
and rounded to the printed precision: "3.09 lb" gives 1.4 kg. Otherwise the
value is `ambiguous`; "1 TB" for GB could mean decimal or binary units.

* One unit after several numbers covers all of them when they form a size
  ("31.2 x 22.1 x 1.5 cm"), an ascending range or variant list ("2-3 kg",
  "8 - 10 hours", "Battery life 8 - 10 hours", "Weighs 1.2 - 1.5 kg", "2 –
  3 kg", "128/256/512GB", "64 / 128 GB"), or a range in words ("5 to 7 kg",
  "-5 to -10 kg"): `ambiguous`, not the last number. A spaced hyphen or
  slash separates only after a product's own number: one glued to its
  letters ("Galaxy S24 - 256 GB"), after a count ("Pack of 8 - 200 ml"),
  after a camel-case name ("iPhone 15 - 128 GB"), or after a capitalized
  name that is not a label ("Weight", "Max.") when the next number is at
  least five times larger ("Pixel 8 - 128 GB", "Series 9 - 45mm"). A
  descending pair separates too ("EU 42 / 27 cm" is 27). In doubt it is a
  range: an upper end read as the value is a confident wrong value. A pack count is not a size: "6 x 330 ml" is
  330 ml (but "60 x 90 cm" is two lengths). "128/256GB" is two capacities,
  not 128 out of 256.
* Parts of one quantity add up: 6'2" is 74 in (188 cm), "105 ft 3 in" is
  32.08 m, "10 h 30 min" is 630 min, "2 kg 500 g" is 2.5 kg, "1 l 500 ml"
  is 1500 ml. The parts share a unit system and each is less than one of
  the unit before it, so a value printed twice ("1.4 kg, 3.09 lb", "15.6
  inches 39.6 cm") is not summed.
* "pounds" is sterling, not a unit, when the field's name is about money,
  or its description is and nothing says weight. "Min" ending a field
  name (`priceMin`) is a minimum unless a time word precedes it
  (`cookTimeMin`, `videoLengthMin`, `batteryLifeMin`).

A row of star glyphs counts its filled stars: "★★★★☆" is 4, "★★★½☆" is 3.5,
and emoji stars count with or without their variation selector ("⭐️").

Text saying there is no value becomes null with reason `not_found` and the
detail "the page states no value". Examples: "Contact sales", "Price on
request", "TBA", "Coming soon", "N/A", "—", "Sold out", "Unlimited seats",
and their de/fr/es/it/pt/nl forms ("k. A." with or without its last dot). "Free", "None" and "No reviews" stay
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
| 5 | Mixed-load and recovery checks, published limits | done: `tests/load/mixed-load.ts`, `docs/limits.md` |

Inputs larger than the model budget are never silently cut. Phase 2 sends
the relevant blocks, or every record in chunks. Whatever still could not
be processed is reported with `truncated: true`, `status: partial` and
`missing` entries with reason `not_processed`.
