# Live extraction benchmark

`run-extraction-eval.ts` runs the hand-labelled corpus in
`tests/fixtures/extraction/` through the real extraction engine
(`apps/worker/src/extract/engine.ts`) and real models, one model at a time,
and scores every result against gold with `tests/engine/scoring.ts`.

The offline counterpart is `tests/engine/engine-corpus.test.ts` (part of
`npx vitest run`): the same corpus with a gold-oracle fake model, which
measures what the engine does with correct (and adversarial) model answers.
This script measures what real models actually answer.

## Running

```sh
export OPENROUTER_API_KEY=sk-or-...        # or put it in .env and use --env-file
npx tsx --env-file=.env tests/eval/run-extraction-eval.ts \
  --models openrouter:google/gemini-2.5-flash-lite,openrouter:anthropic/claude-haiku-5.5 \
  --repeat 3 --concurrency 4
```

| option | default | meaning |
|---|---|---|
| `--models k1,k2` | `EXTRACT_MODELS`, else `openrouter:google/gemini-2.5-flash-lite` | registry keys (`provider:model`); each is benchmarked alone, without fallbacks |
| `--repeat N` | 1 | runs per fixture (model answers vary between runs) |
| `--fixtures ids` | all | comma-separated fixture ids from `tests/fixtures/extraction/index.json` |
| `--no-structured` | off | disable structured data and recipes: every field goes through the model |
| `--concurrency N` | 4 | extractions in flight |
| `--max-cost USD` | 0.10 | spend cap per extraction |
| `--timeout MS` | 120000 | deadline per extraction |
| `--out DIR` | `tests/eval/results` | where results are written |

Behind an HTTP(S) proxy (`HTTPS_PROXY` set, e.g. a sandbox), Node's `fetch`
ignores the proxy unless `NODE_USE_ENV_PROXY=1` is also set (Node 22.15+/24);
without it the probe reports the provider as unreachable.

Each model needs its provider key (`OPENROUTER_API_KEY`, `GROQ_API_KEY`,
`GEMINI_API_KEY`, `OPENAI_API_KEY`). A model without a key is skipped with a
message. Before the full run one probe extraction checks the provider: if the
network is unreachable or the key is rejected, the script says so and moves
on. It always exits 0 unless the arguments are invalid (exit 2). Keys are
never printed or written to results.

Cost: one pass over the corpus is ~15 extractions; most use one model call.
`large-listing` alone sends ~100k input tokens (and is expected to come back
`partial`: its 600 records do not fit one model output in Phase 1), so pass
`--fixtures` without it for cheap smoke runs.

## Output

For each model, `<out>/<ISO date>-<model>.json` (every run: status, expected
status, precision/recall, latency, tokens, cost, each attempt with its error
category and the resolved upstream model/provider, warnings, missing fields)
and a `.md` summary:

* value precision / recall, micro (every value weighs the same; the 600-record
  listing dominates) and macro (every fixture weighs the same)
* status accuracy: share of runs whose `complete | partial | failed` matches
  the fixture's `expectStatus`
* latency p50 / p95 per extraction (engine + model, no fetch)
* total cost and cost per correct field
* failed attempts by error category (`auth`, `rate_limit`, `parse_error`,
  `output_truncated`, …)

## Reading the numbers

* Precision below 100% means a wrong value got through. Values the model made
  up are rejected by grounding, so this is usually a decoy that is printed on
  the page (a related product's price) or an injected instruction in visible
  text (`prompt-injection`).
* Recall below the oracle baseline (see the test output of
  `engine-corpus.test.ts`) is the model's own miss, a value it reported in a
  form normalization cannot read, or a citation the engine could not verify.
* Compare `--no-structured` with the default run to see how much the
  deterministic stages save (calls, cost, latency) and whether they change
  accuracy.

## Results, 2026-10-13

Fourteen fixtures (all but `large-listing`), each run 3 times with the
full engine and once with `--no-structured`. All calls went through
OpenRouter, with a spend cap of $0.10 per extraction. The raw files are in
`results/` and `results/no-structured/`.

Full engine (structured data and recipes on, 42 extractions per model):

| model | precision | recall | status accuracy | p50 | total cost |
|---|---|---|---|---|---|
| `google/gemini-2.5-flash-lite` | 100% | 100% | 85.7% | 668 ms | $0.016 |
| `openai/gpt-5-nano` | 98.9% | 80.9% | 61.9% | 1131 ms | $0.007 |
| `anthropic/claude-haiku-5.5` | 100% | 99.8% | 95.2% | 2039 ms | $0.029 |
| `google/gemini-3.8-flash` | 100% | 98.8% | 85.7% | 1728 ms | $0.125 |

Model only (`--no-structured`, 14 extractions per model):

| model | precision | recall | status accuracy | p50 | total cost |
|---|---|---|---|---|---|
| `google/gemini-2.5-flash-lite` | 97.8% | 96.7% | 71.4% | 959 ms | $0.006 |
| `openai/gpt-5-nano` | 64.8% | 79.0% | 28.6% | 1391 ms | $0.005 |
| `anthropic/claude-haiku-5.5` | 99.6% | 94.1% | 71.4% | 3811 ms | $0.011 |
| `google/gemini-3.8-flash` | 99.6% | 95.6% | 85.7% | 2101 ms | $0.047 |

The default is now `gemini-2.5-flash-lite` as the primary model, with
`claude-haiku-5.5` as the fallback. Flash-Lite is the fastest of the four
and the second cheapest, and it made no value errors in the full-engine
run. Haiku 5.5 had the best status accuracy and almost perfect values at
twice the price. GPT-5 Nano is the cheapest, but it often cited the wrong
block or invented one, so grounding rejected many of its values. That is
why its recall is low; few wrong values got through. Gemini 3.8 Flash costs
eight times as much as Flash-Lite and was no more accurate here.

Most of the status gaps came from the engine, not the models, and were
fixed afterwards (results below). Two values were marked `unparseable` and left the record
`partial` when the page said the value is absent: "Contact sales" for a
price, and "TBA". A number the page states as a word or a CSS class was
rejected for want of grounding: "512 GB …" for an integer field, "Three"
for a star rating, "In stock" for a boolean. Listing values that cited a
neighbouring block were rejected too, even though the value is printed in
the same record.

The first run also showed three request-shape problems:

* GPT-5 Nano and Gemini 3.8 Flash spent the whole `max_tokens` on hidden
  reasoning. They now get `reasoning: {effort: "minimal"}` and a reserve on
  top of the answer budget.
* Claude Haiku 5.5 rejects `temperature`. The registry now knows this, and
  the provider retries once without it for unknown models.
* Haiku's listing answers ran past the planned output size. Output is now
  planned with 2× headroom.

### After the engine fixes

The same full-engine run (14 fixtures, 3 repeats per model), after the
fixes in commit "engine: fix what the live benchmark found wrong". The raw
files are in `results/after-fixes/`.

| model | precision | recall | status accuracy | p50 | total cost |
|---|---|---|---|---|---|
| `google/gemini-2.5-flash-lite` | 100% | 100% | **100%** (was 85.7%) | 756 ms | $0.015 |
| `openai/gpt-5-nano` | 99.1% | 84.5% (was 80.9%) | 78.6% (was 61.9%) | 1058 ms | $0.008 |
| `anthropic/claude-haiku-5.5` | 100% | **100%** | **100%** (was 95.2%) | 1643 ms | $0.030 |
| `google/gemini-3.8-flash` | 100% | 99.1% | 92.9% (was 85.7%) | 1875 ms | $0.124 |

What still misses:

* **Gemini 3.8 Flash on `job-posting`.** It answers `remote: null`, where
  the page says "On-site" and "not eligible for fully remote work".
* **GPT-5 Nano.**
  * Mis-citations: values cited at the "Our pick" card instead of the
    comparison table. Now kept when the number is printed in the table and
    on no other card.
  * "No customer reviews" for a rating. It stays `unparseable`, because
    "no reviews" may mean 0.
  * An occasional wrong `availability`.
