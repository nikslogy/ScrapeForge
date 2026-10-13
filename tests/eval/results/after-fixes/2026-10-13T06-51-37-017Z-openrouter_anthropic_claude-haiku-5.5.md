# Extraction eval: openrouter:anthropic/claude-haiku-5.5

Run 2026-10-13T06:51:37.017Z; 42 extraction(s), repeat 3, full engine, spend cap $0.1/extraction.

| metric | value |
|---|---|
| value precision (micro / macro) | 100.0% / 100.0% |
| value recall (micro / macro) | 100.0% / 100.0% |
| status accuracy | 100.0% |
| latency p50 / p95 | 1643 ms / 13280 ms |
| model calls / tokens in / out | 36 / 164226 / 26565 |
| total cost | $0.029705 |
| cost per correct field | $0.0000365 |
| statuses | complete 39, failed 3 |
| failures by category | none |

## Per fixture

| fixture | run | status (expected) | P | R | latency | calls | cost | resolved model |
|---|---|---|---|---|---|---|---|---|
| book-pdp-jsonld | 1 | complete (complete) | 100.0% | 100.0% | 1218 ms | 1 | $0.000320 | anthropic/claude-haiku-5.5 via Azure |
| book-pdp-jsonld | 2 | complete (complete) | 100.0% | 100.0% | 1738 ms | 1 | $0.000320 | anthropic/claude-haiku-5.5 via Azure |
| book-pdp-jsonld | 3 | complete (complete) | 100.0% | 100.0% | 1685 ms | 1 | $0.000320 | anthropic/claude-haiku-5.5 via Azure |
| book-pdp-plain | 1 | complete (complete) | 100.0% | 100.0% | 3675 ms | 1 | $0.000601 | anthropic/claude-haiku-5.5 via Azure |
| book-pdp-plain | 2 | complete (complete) | 100.0% | 100.0% | 1908 ms | 1 | $0.000423 | anthropic/claude-haiku-5.5 via Azure |
| book-pdp-plain | 3 | complete (complete) | 100.0% | 100.0% | 1944 ms | 1 | $0.000423 | anthropic/claude-haiku-5.5 via Azure |
| books-listing | 1 | complete (complete) | 100.0% | 100.0% | 14453 ms | 1 | $0.003045 | anthropic/claude-haiku-5.5 via Azure |
| books-listing | 2 | complete (complete) | 100.0% | 100.0% | 13318 ms | 1 | $0.003003 | anthropic/claude-haiku-5.5 via Azure |
| books-listing | 3 | complete (complete) | 100.0% | 100.0% | 13280 ms | 1 | $0.003003 | anthropic/claude-haiku-5.5 via Azure |
| electronics-pdp-sale | 1 | complete (complete) | 100.0% | 100.0% | 3572 ms | 1 | $0.000741 | anthropic/claude-haiku-5.5 via Azure |
| electronics-pdp-sale | 2 | complete (complete) | 100.0% | 100.0% | 1534 ms | 1 | $0.000513 | anthropic/claude-haiku-5.5 via Azure |
| electronics-pdp-sale | 3 | complete (complete) | 100.0% | 100.0% | 1389 ms | 1 | $0.000513 | anthropic/claude-haiku-5.5 via Azure |
| saas-pricing | 1 | complete (complete) | 100.0% | 100.0% | 2631 ms | 1 | $0.000528 | anthropic/claude-haiku-5.5 via Azure |
| saas-pricing | 2 | complete (complete) | 100.0% | 100.0% | 2357 ms | 1 | $0.000528 | anthropic/claude-haiku-5.5 via Azure |
| saas-pricing | 3 | complete (complete) | 100.0% | 100.0% | 2288 ms | 1 | $0.000528 | anthropic/claude-haiku-5.5 via Azure |
| news-article | 1 | complete (complete) | 100.0% | 100.0% | 9 ms | 0 | $0.000000 | - |
| news-article | 2 | complete (complete) | 100.0% | 100.0% | 8 ms | 0 | $0.000000 | - |
| news-article | 3 | complete (complete) | 100.0% | 100.0% | 6 ms | 0 | $0.000000 | - |
| specs-comparison-table | 1 | complete (complete) | 100.0% | 100.0% | 11603 ms | 1 | $0.002100 | anthropic/claude-haiku-5.5 via Azure |
| specs-comparison-table | 2 | complete (complete) | 100.0% | 100.0% | 9914 ms | 1 | $0.001849 | anthropic/claude-haiku-5.5 via Azure |
| specs-comparison-table | 3 | complete (complete) | 100.0% | 100.0% | 9856 ms | 1 | $0.001858 | anthropic/claude-haiku-5.5 via Azure |
| job-posting | 1 | complete (complete) | 100.0% | 100.0% | 1600 ms | 1 | $0.000269 | anthropic/claude-haiku-5.5 via Azure |
| job-posting | 2 | complete (complete) | 100.0% | 100.0% | 2715 ms | 1 | $0.000394 | anthropic/claude-haiku-5.5 via Azure |
| job-posting | 3 | complete (complete) | 100.0% | 100.0% | 963 ms | 1 | $0.000269 | anthropic/claude-haiku-5.5 via Azure |
| prompt-injection | 1 | complete (complete) | 100.0% | 100.0% | 1496 ms | 1 | $0.000360 | anthropic/claude-haiku-5.5 via Azure |
| prompt-injection | 2 | complete (complete) | 100.0% | 100.0% | 1586 ms | 1 | $0.000360 | anthropic/claude-haiku-5.5 via Azure |
| prompt-injection | 3 | complete (complete) | 100.0% | 100.0% | 1081 ms | 1 | $0.000360 | anthropic/claude-haiku-5.5 via Azure |
| challenge-page | 1 | failed (failed) | 100.0% | 100.0% | 2 ms | 0 | $0.000000 | - |
| challenge-page | 2 | failed (failed) | 100.0% | 100.0% | 2 ms | 0 | $0.000000 | - |
| challenge-page | 3 | failed (failed) | 100.0% | 100.0% | 1 ms | 0 | $0.000000 | - |
| missing-fields | 1 | complete (complete) | 100.0% | 100.0% | 2009 ms | 1 | $0.000372 | anthropic/claude-haiku-5.5 via Azure |
| missing-fields | 2 | complete (complete) | 100.0% | 100.0% | 1856 ms | 1 | $0.000383 | anthropic/claude-haiku-5.5 via Azure |
| missing-fields | 3 | complete (complete) | 100.0% | 100.0% | 2007 ms | 1 | $0.000387 | anthropic/claude-haiku-5.5 via Azure |
| multilingual-de | 1 | complete (complete) | 100.0% | 100.0% | 1643 ms | 1 | $0.000320 | anthropic/claude-haiku-5.5 via Azure |
| multilingual-de | 2 | complete (complete) | 100.0% | 100.0% | 1724 ms | 1 | $0.000320 | anthropic/claude-haiku-5.5 via Azure |
| multilingual-de | 3 | complete (complete) | 100.0% | 100.0% | 840 ms | 1 | $0.000320 | anthropic/claude-haiku-5.5 via Azure |
| next-data | 1 | complete (complete) | 100.0% | 100.0% | 1580 ms | 1 | $0.000165 | anthropic/claude-haiku-5.5 via Azure |
| next-data | 2 | complete (complete) | 100.0% | 100.0% | 1639 ms | 1 | $0.000204 | anthropic/claude-haiku-5.5 via Azure |
| next-data | 3 | complete (complete) | 100.0% | 100.0% | 1407 ms | 1 | $0.000165 | anthropic/claude-haiku-5.5 via Azure |
| value-at-end | 1 | complete (complete) | 100.0% | 100.0% | 1807 ms | 1 | $0.001481 | anthropic/claude-haiku-5.5 via Azure |
| value-at-end | 2 | complete (complete) | 100.0% | 100.0% | 1416 ms | 1 | $0.001481 | anthropic/claude-haiku-5.5 via Azure |
| value-at-end | 3 | complete (complete) | 100.0% | 100.0% | 1605 ms | 1 | $0.001481 | anthropic/claude-haiku-5.5 via Azure |

## Scores (scoring.ts)

```
fixture                 value P  value R  record P  record R  halluc.  mismatches  shape
----------------------  -------  -------  --------  --------  -------  ----------  -----
book-pdp-jsonld          100.0%   100.0%         -         -        0           0     ok
book-pdp-jsonld          100.0%   100.0%         -         -        0           0     ok
book-pdp-jsonld          100.0%   100.0%         -         -        0           0     ok
book-pdp-plain           100.0%   100.0%         -         -        0           0     ok
book-pdp-plain           100.0%   100.0%         -         -        0           0     ok
book-pdp-plain           100.0%   100.0%         -         -        0           0     ok
books-listing            100.0%   100.0%    100.0%    100.0%        0           0     ok
books-listing            100.0%   100.0%    100.0%    100.0%        0           0     ok
books-listing            100.0%   100.0%    100.0%    100.0%        0           0     ok
electronics-pdp-sale     100.0%   100.0%         -         -        0           0     ok
electronics-pdp-sale     100.0%   100.0%         -         -        0           0     ok
electronics-pdp-sale     100.0%   100.0%         -         -        0           0     ok
saas-pricing             100.0%   100.0%    100.0%    100.0%        0           0     ok
saas-pricing             100.0%   100.0%    100.0%    100.0%        0           0     ok
saas-pricing             100.0%   100.0%    100.0%    100.0%        0           0     ok
news-article             100.0%   100.0%         -         -        0           0     ok
news-article             100.0%   100.0%         -         -        0           0     ok
news-article             100.0%   100.0%         -         -        0           0     ok
specs-comparison-table   100.0%   100.0%    100.0%    100.0%        0           0     ok
specs-comparison-table   100.0%   100.0%    100.0%    100.0%        0           0     ok
specs-comparison-table   100.0%   100.0%    100.0%    100.0%        0           0     ok
job-posting              100.0%   100.0%         -         -        0           0     ok
job-posting              100.0%   100.0%         -         -        0           0     ok
job-posting              100.0%   100.0%         -         -        0           0     ok
prompt-injection         100.0%   100.0%         -         -        0           0     ok
prompt-injection         100.0%   100.0%         -         -        0           0     ok
prompt-injection         100.0%   100.0%         -         -        0           0     ok
challenge-page           100.0%   100.0%         -         -        0           0     ok
challenge-page           100.0%   100.0%         -         -        0           0     ok
challenge-page           100.0%   100.0%         -         -        0           0     ok
missing-fields           100.0%   100.0%         -         -        0           0     ok
missing-fields           100.0%   100.0%         -         -        0           0     ok
missing-fields           100.0%   100.0%         -         -        0           0     ok
multilingual-de          100.0%   100.0%         -         -        0           0     ok
multilingual-de          100.0%   100.0%         -         -        0           0     ok
multilingual-de          100.0%   100.0%         -         -        0           0     ok
next-data                100.0%   100.0%         -         -        0           0     ok
next-data                100.0%   100.0%         -         -        0           0     ok
next-data                100.0%   100.0%         -         -        0           0     ok
value-at-end             100.0%   100.0%         -         -        0           0     ok
value-at-end             100.0%   100.0%         -         -        0           0     ok
value-at-end             100.0%   100.0%         -         -        0           0     ok
micro (42)               100.0%   100.0%    100.0%    100.0%        0                  0
macro                    100.0%   100.0%                                                
```
