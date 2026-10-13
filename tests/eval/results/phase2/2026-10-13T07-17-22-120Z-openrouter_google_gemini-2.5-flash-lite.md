# Extraction eval: openrouter:google/gemini-2.5-flash-lite

Run 2026-10-13T07:17:22.120Z; 1 extraction(s), repeat 1, full engine, spend cap $0.15/extraction.

| metric | value |
|---|---|
| value precision (micro / macro) | 100.0% / 100.0% |
| value recall (micro / macro) | 99.8% / 99.8% |
| status accuracy | 0.0% |
| latency p50 / p95 | 31159 ms / 31159 ms |
| model calls / tokens in / out | 7 / 158317 / 51393 |
| total cost | $0.034121 |
| cost per correct field | $0.0000147 |
| statuses | partial 1 |
| failures by category | none |

## Per fixture

| fixture | run | status (expected) | P | R | latency | calls | cost | resolved model |
|---|---|---|---|---|---|---|---|---|
| large-listing | 1 | partial (complete) | 100.0% | 99.8% | 31159 ms | 7 | $0.034121 | google/gemini-2.5-flash-lite via Google |

## Scores (scoring.ts)

```
fixture        value P  value R  record P  record R  halluc.  mismatches  shape
-------------  -------  -------  --------  --------  -------  ----------  -----
large-listing   100.0%    99.8%    100.0%    100.0%        0           4     ok
micro (1)       100.0%    99.8%    100.0%    100.0%        0                  0
macro           100.0%    99.8%                                                
```
