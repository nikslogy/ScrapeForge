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
  --models openrouter:google/gemini-2.5-flash,openrouter:openai/gpt-4.1-mini \
  --repeat 3 --concurrency 4
```

| option | default | meaning |
|---|---|---|
| `--models k1,k2` | `EXTRACT_MODELS`, else `openrouter:google/gemini-2.5-flash` | registry keys (`provider:model`); each is benchmarked alone, without fallbacks |
| `--repeat N` | 1 | runs per fixture (model answers vary between runs) |
| `--fixtures ids` | all | comma-separated fixture ids from `tests/fixtures/extraction/index.json` |
| `--no-structured` | off | disable structured data and recipes: every field goes through the model |
| `--concurrency N` | 4 | extractions in flight |
| `--max-cost USD` | 0.10 | spend cap per extraction |
| `--timeout MS` | 120000 | deadline per extraction |
| `--out DIR` | `tests/eval/results` | where results are written |

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
