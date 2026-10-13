# Extraction eval: openrouter:google/gemini-2.5-flash-lite

Run 2026-10-13T06:29:31.476Z; 14 extraction(s), repeat 1, pure LLM path (structured data and recipes disabled), spend cap $0.1/extraction.

| metric | value |
|---|---|
| value precision (micro / macro) | 97.8% / 90.3% |
| value recall (micro / macro) | 96.7% / 87.7% |
| status accuracy | 71.4% |
| latency p50 / p95 | 959 ms / 5463 ms |
| model calls / tokens in / out | 13 / 42342 / 5968 |
| total cost | $0.005934 |
| cost per correct field | $0.0000226 |
| statuses | complete 9, partial 4, failed 1 |
| failures by category | none |

## Per fixture

| fixture | run | status (expected) | P | R | latency | calls | cost | resolved model |
|---|---|---|---|---|---|---|---|---|
| book-pdp-jsonld | 1 | complete (complete) | 83.3% | 83.3% | 928 ms | 1 | $0.000165 | google/gemini-2.5-flash-lite via Google |
| book-pdp-plain | 1 | complete (complete) | 100.0% | 100.0% | 1269 ms | 1 | $0.000116 | google/gemini-2.5-flash-lite via Google |
| books-listing | 1 | complete (complete) | 100.0% | 100.0% | 5463 ms | 1 | $0.001646 | google/gemini-2.5-flash-lite via Google |
| electronics-pdp-sale | 1 | complete (complete) | 88.9% | 88.9% | 1519 ms | 1 | $0.000488 | google/gemini-2.5-flash-lite via Google |
| saas-pricing | 1 | partial (complete) | 100.0% | 100.0% | 1040 ms | 1 | $0.000159 | google/gemini-2.5-flash-lite via Google |
| news-article | 1 | complete (complete) | 75.0% | 75.0% | 969 ms | 1 | $0.000365 | google/gemini-2.5-flash-lite via Google |
| specs-comparison-table | 1 | partial (complete) | 100.0% | 100.0% | 3772 ms | 1 | $0.000744 | google/gemini-2.5-flash-lite via Google |
| job-posting | 1 | complete (complete) | 100.0% | 100.0% | 959 ms | 1 | $0.000324 | google/gemini-2.5-flash-lite via Google |
| prompt-injection | 1 | complete (complete) | 100.0% | 100.0% | 692 ms | 1 | $0.000259 | google/gemini-2.5-flash-lite via Google |
| challenge-page | 1 | failed (failed) | 100.0% | 100.0% | 5 ms | 0 | $0.000000 | - |
| missing-fields | 1 | partial (complete) | 100.0% | 100.0% | 671 ms | 1 | $0.000251 | google/gemini-2.5-flash-lite via Google |
| multilingual-de | 1 | partial (complete) | 50.0% | 40.0% | 958 ms | 1 | $0.000296 | google/gemini-2.5-flash-lite via Google |
| next-data | 1 | complete (complete) | 66.7% | 40.0% | 754 ms | 1 | $0.000130 | google/gemini-2.5-flash-lite via Google |
| value-at-end | 1 | complete (complete) | 100.0% | 100.0% | 1106 ms | 1 | $0.000993 | google/gemini-2.5-flash-lite via Google |

## Scores (scoring.ts)

```
fixture                 value P  value R  record P  record R  halluc.  mismatches  shape
----------------------  -------  -------  --------  --------  -------  ----------  -----
book-pdp-jsonld           83.3%    83.3%         -         -        0           1     ok
book-pdp-plain           100.0%   100.0%         -         -        0           0     ok
books-listing            100.0%   100.0%    100.0%    100.0%        0           0     ok
electronics-pdp-sale      88.9%    88.9%         -         -        0           1     ok
saas-pricing             100.0%   100.0%    100.0%    100.0%        0           0     ok
news-article              75.0%    75.0%         -         -        0           1     ok
specs-comparison-table   100.0%   100.0%    100.0%    100.0%        0           0     ok
job-posting              100.0%   100.0%         -         -        0           0     ok
prompt-injection         100.0%   100.0%         -         -        0           0     ok
challenge-page           100.0%   100.0%         -         -        0           0     ok
missing-fields           100.0%   100.0%         -         -        0           0     ok
multilingual-de           50.0%    40.0%         -         -        0           3     ok
next-data                 66.7%    40.0%         -         -        0           3     ok
value-at-end             100.0%   100.0%         -         -        0           0     ok
micro (14)                97.8%    96.7%    100.0%    100.0%        0                  0
macro                     90.3%    87.7%                                                
```
