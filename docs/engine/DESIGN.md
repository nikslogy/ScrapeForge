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
| `recipe/` | Recipe validation, safe interpreter, Redis store with candidate→active lifecycle and drift invalidation, LLM recipe proposal | `validateRecipe`, `runRecipe`, `RecipeStore`, `proposeRecipe` |
| `llm/` | Provider adapters, capability registry, error classification, circuit breaker, budget/deadline, prompt + response protocol, fake providers for tests | `ModelClient`, `buildExtractionPrompt`, `parseExtractionResponse` |
| `engine.ts` | Orchestrates the stages and assembles `ExtractionOutcome` | `extractStructured(req, deps)` |

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
     normalize in code ─► grounding check ─► Ajv validate ─► outcome
                │
                └─► (async, best effort) propose recipe → candidate; promote after
                    agreeing with grounded LLM results on ≥ 2 more distinct snapshots
```

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
warning when weak. Derived fields are exempt but labelled.

### Outcome status

* `complete` — schema-valid, no missing required fields, not truncated.
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

* Fetch/result cache (existing `cache:*` keys) — unchanged in this package.
* Extraction recipes — `recipe:v1:{tenant}:{host}:{template}:{schemaHash}`.
* Compiled Ajv validators — in-process LRU by schema hash.

## Phases

| Phase | Deliverable | Status |
|---|---|---|
| 0 | Build fixed, stage tracing, reproducible extraction baseline | in progress |
| 1 | Source-preserving document, deterministic paths, model layer, validation, grounding, recipes | in progress |
| 2 | Large inputs: targeted (BM25 block selection) vs exhaustive (partitioned, ledger, merge by record identity) | next |
| 3 | Fetch snapshot cache, request coalescing, readiness-based browser waits, concurrency budgets | later |
| 4 | Router: classify failures, engine vs network route, expiring per-template learning | later |
| 5 | Mixed-load and recovery checks, published limits | later |

In Phase 1, inputs larger than the model budget are not silently cut: the
engine sends what fits and reports `truncated: true`, `status: partial`, and
`missing` entries with reason `not_processed`.
