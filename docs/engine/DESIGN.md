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

### Known limitations (Phase 1)

* Booleans are read from availability/yes-no wording; a phrase such as
  "On-site" for `remote: false` is not converted (mark such fields
  `x-derived` or accept `partial`).
* A value present only in an attribute (`class="star-rating Three"`, `href`)
  must be cited from its own block; it cannot be verified elsewhere.
* Visible text that contains an injected instruction is still page text: a
  model that obeys it can return grounded but wrong values (the hidden
  injection text never reaches the model).
* Listing pages whose records do not fit one call are partial (Phase 2). The
  output-capacity estimate is conservative (×1.2 for JSON formatting), so a
  model writing compact JSON could sometimes have answered a few more
  records; a model writing much more verbose JSON (3× the estimate) can
  still overflow twice and fail (the engine does not see truncated output).
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

### Outcome status

Summarized here; exact rules under "Outcome semantics" above.

* `complete` — schema-valid, nothing missing except genuinely absent optional/nullable values, not truncated.
* `partial`  — some data, but missing required fields, schema errors, truncation,
  or rejected values. `data` still returned, `schemaValid` tells the truth.
* `failed`   — no usable data (blocked page, provider failure, nothing found).

### Model selection

`EXTRACT_MODELS` lists registry keys in priority order, e.g.
`openrouter:google/gemini-2.5-flash,openrouter:openai/gpt-4.1-mini`.
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
| 2 | Large inputs: targeted (BM25 block selection) vs exhaustive (partitioned, ledger, merge by record identity) | next |
| 3 | Fetch snapshot cache, request coalescing, readiness-based browser waits, concurrency budgets | later |
| 4 | Router: classify failures, engine vs network route, expiring per-template learning | later |
| 5 | Mixed-load and recovery checks, published limits | later |

In Phase 1, inputs larger than the model budget are not silently cut: the
engine sends what fits and reports `truncated: true`, `status: partial`, and
`missing` entries with reason `not_processed`.
