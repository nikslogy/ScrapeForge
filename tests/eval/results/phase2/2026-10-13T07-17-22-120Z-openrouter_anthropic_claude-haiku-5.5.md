# Extraction eval: openrouter:anthropic/claude-haiku-5.5

Run 2026-10-13T07:17:22.120Z; 1 extraction(s), repeat 1, full engine, spend cap $0.15/extraction.

| metric | value |
|---|---|
| value precision (micro / macro) | 100.0% / 100.0% |
| value recall (micro / macro) | 100.0% / 100.0% |
| status accuracy | 100.0% |
| latency p50 / p95 | 87392 ms / 87392 ms |
| model calls / tokens in / out | 7 / 169558 / 96343 |
| total cost | $0.065127 |
| cost per correct field | $0.0000280 |
| statuses | complete 1 |
| failures by category | none |

## Per fixture

| fixture | run | status (expected) | P | R | latency | calls | cost | resolved model |
|---|---|---|---|---|---|---|---|---|
| large-listing | 1 | complete (complete) | 100.0% | 100.0% | 87392 ms | 7 | $0.065127 | anthropic/claude-haiku-5.5 via Azure |

## Scores (scoring.ts)

```
fixture        value P  value R  record P  record R  halluc.  mismatches  shape
-------------  -------  -------  --------  --------  -------  ----------  -----
large-listing   100.0%   100.0%    100.0%    100.0%        0           0     ok
micro (1)       100.0%   100.0%    100.0%    100.0%        0                  0
macro           100.0%   100.0%                                                
```
