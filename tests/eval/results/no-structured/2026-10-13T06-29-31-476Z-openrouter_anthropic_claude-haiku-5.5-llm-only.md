# Extraction eval: openrouter:anthropic/claude-haiku-5.5

Run 2026-10-13T06:29:31.476Z; 14 extraction(s), repeat 1, pure LLM path (structured data and recipes disabled), spend cap $0.1/extraction.

| metric | value |
|---|---|
| value precision (micro / macro) | 99.6% / 98.8% |
| value recall (micro / macro) | 94.1% / 83.6% |
| status accuracy | 71.4% |
| latency p50 / p95 | 3811 ms / 15077 ms |
| model calls / tokens in / out | 13 / 58391 / 9419 |
| total cost | $0.010549 |
| cost per correct field | $0.0000414 |
| statuses | complete 9, failed 2, partial 3 |
| failures by category | unknown 1 |

## Per fixture

| fixture | run | status (expected) | P | R | latency | calls | cost | resolved model |
|---|---|---|---|---|---|---|---|---|
| book-pdp-jsonld | 1 | complete (complete) | 83.3% | 83.3% | 2848 ms | 1 | $0.000433 | anthropic/claude-haiku-5.5 via Azure |
| book-pdp-plain | 1 | complete (complete) | 100.0% | 100.0% | 2418 ms | 1 | $0.000423 | anthropic/claude-haiku-5.5 via Azure |
| books-listing | 1 | complete (complete) | 100.0% | 100.0% | 15077 ms | 1 | $0.003065 | anthropic/claude-haiku-5.5 via Azure |
| electronics-pdp-sale | 1 | failed (complete) | 100.0% | 0.0% | 1107 ms | 1 | $0.000000 | - |
| saas-pricing | 1 | complete (complete) | 100.0% | 100.0% | 2696 ms | 1 | $0.000528 | anthropic/claude-haiku-5.5 via Azure |
| news-article | 1 | complete (complete) | 100.0% | 100.0% | 3811 ms | 1 | $0.000522 | anthropic/claude-haiku-5.5 via Azure |
| specs-comparison-table | 1 | partial (complete) | 100.0% | 100.0% | 10867 ms | 1 | $0.001913 | anthropic/claude-haiku-5.5 via Azure |
| job-posting | 1 | partial (complete) | 100.0% | 87.5% | 5115 ms | 1 | $0.000490 | anthropic/claude-haiku-5.5 via Azure |
| prompt-injection | 1 | complete (complete) | 100.0% | 100.0% | 3228 ms | 1 | $0.000397 | anthropic/claude-haiku-5.5 via Azure |
| challenge-page | 1 | failed (failed) | 100.0% | 100.0% | 2 ms | 0 | $0.000000 | - |
| missing-fields | 1 | complete (complete) | 100.0% | 100.0% | 4640 ms | 1 | $0.000485 | anthropic/claude-haiku-5.5 via Azure |
| multilingual-de | 1 | partial (complete) | 100.0% | 60.0% | 4295 ms | 1 | $0.000444 | anthropic/claude-haiku-5.5 via Azure |
| next-data | 1 | complete (complete) | 100.0% | 40.0% | 4372 ms | 1 | $0.000304 | anthropic/claude-haiku-5.5 via Azure |
| value-at-end | 1 | complete (complete) | 100.0% | 100.0% | 4025 ms | 1 | $0.001545 | anthropic/claude-haiku-5.5 via Azure |

## Scores (scoring.ts)

```
fixture                 value P  value R  record P  record R  halluc.  mismatches  shape
----------------------  -------  -------  --------  --------  -------  ----------  -----
book-pdp-jsonld           83.3%    83.3%         -         -        0           1     ok
book-pdp-plain           100.0%   100.0%         -         -        0           0     ok
books-listing            100.0%   100.0%    100.0%    100.0%        0           0     ok
electronics-pdp-sale     100.0%     0.0%         -         -        0           1     ok
saas-pricing             100.0%   100.0%    100.0%    100.0%        0           0     ok
news-article             100.0%   100.0%         -         -        0           0     ok
specs-comparison-table   100.0%   100.0%    100.0%    100.0%        0           0     ok
job-posting              100.0%    87.5%         -         -        0           1     ok
prompt-injection         100.0%   100.0%         -         -        0           0     ok
challenge-page           100.0%   100.0%         -         -        0           0     ok
missing-fields           100.0%   100.0%         -         -        0           0     ok
multilingual-de          100.0%    60.0%         -         -        0           2     ok
next-data                100.0%    40.0%         -         -        0           3     ok
value-at-end             100.0%   100.0%         -         -        0           0     ok
micro (14)                99.6%    94.1%    100.0%    100.0%        0                  0
macro                     98.8%    83.6%                                                
```
