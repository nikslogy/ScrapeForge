# Extraction eval: openrouter:anthropic/claude-haiku-5.5

Run 2026-10-13T06:27:36.110Z; 42 extraction(s), repeat 3, full engine, spend cap $0.1/extraction.

| metric | value |
|---|---|
| value precision (micro / macro) | 100.0% / 100.0% |
| value recall (micro / macro) | 99.8% / 99.4% |
| status accuracy | 95.2% |
| latency p50 / p95 | 2039 ms / 13490 ms |
| model calls / tokens in / out | 36 / 164226 / 25926 |
| total cost | $0.029386 |
| cost per correct field | $0.0000362 |
| statuses | complete 37, partial 2, failed 3 |
| failures by category | none |

## Per fixture

| fixture | run | status (expected) | P | R | latency | calls | cost | resolved model |
|---|---|---|---|---|---|---|---|---|
| book-pdp-jsonld | 1 | complete (complete) | 100.0% | 100.0% | 2055 ms | 1 | $0.000320 | anthropic/claude-haiku-5.5 via Azure |
| book-pdp-jsonld | 2 | complete (complete) | 100.0% | 100.0% | 1705 ms | 1 | $0.000320 | anthropic/claude-haiku-5.5 via Azure |
| book-pdp-jsonld | 3 | complete (complete) | 100.0% | 100.0% | 1809 ms | 1 | $0.000320 | anthropic/claude-haiku-5.5 via Azure |
| book-pdp-plain | 1 | complete (complete) | 100.0% | 100.0% | 2133 ms | 1 | $0.000423 | anthropic/claude-haiku-5.5 via Azure |
| book-pdp-plain | 2 | complete (complete) | 100.0% | 100.0% | 1314 ms | 1 | $0.000423 | anthropic/claude-haiku-5.5 via Azure |
| book-pdp-plain | 3 | complete (complete) | 100.0% | 100.0% | 1197 ms | 1 | $0.000423 | anthropic/claude-haiku-5.5 via Azure |
| books-listing | 1 | complete (complete) | 100.0% | 100.0% | 13732 ms | 1 | $0.002956 | anthropic/claude-haiku-5.5 via Azure |
| books-listing | 2 | complete (complete) | 100.0% | 100.0% | 15009 ms | 1 | $0.003117 | anthropic/claude-haiku-5.5 via Azure |
| books-listing | 3 | complete (complete) | 100.0% | 100.0% | 13490 ms | 1 | $0.002911 | anthropic/claude-haiku-5.5 via Azure |
| electronics-pdp-sale | 1 | complete (complete) | 100.0% | 100.0% | 3964 ms | 1 | $0.000513 | anthropic/claude-haiku-5.5 via Azure |
| electronics-pdp-sale | 2 | complete (complete) | 100.0% | 100.0% | 3484 ms | 1 | $0.000731 | anthropic/claude-haiku-5.5 via Azure |
| electronics-pdp-sale | 3 | complete (complete) | 100.0% | 100.0% | 1164 ms | 1 | $0.000513 | anthropic/claude-haiku-5.5 via Azure |
| saas-pricing | 1 | complete (complete) | 100.0% | 100.0% | 4517 ms | 1 | $0.000528 | anthropic/claude-haiku-5.5 via Azure |
| saas-pricing | 2 | complete (complete) | 100.0% | 100.0% | 2619 ms | 1 | $0.000528 | anthropic/claude-haiku-5.5 via Azure |
| saas-pricing | 3 | complete (complete) | 100.0% | 100.0% | 2410 ms | 1 | $0.000528 | anthropic/claude-haiku-5.5 via Azure |
| news-article | 1 | complete (complete) | 100.0% | 100.0% | 4 ms | 0 | $0.000000 | - |
| news-article | 2 | complete (complete) | 100.0% | 100.0% | 3 ms | 0 | $0.000000 | - |
| news-article | 3 | complete (complete) | 100.0% | 100.0% | 3 ms | 0 | $0.000000 | - |
| specs-comparison-table | 1 | complete (complete) | 100.0% | 100.0% | 13303 ms | 1 | $0.001874 | anthropic/claude-haiku-5.5 via Azure |
| specs-comparison-table | 2 | complete (complete) | 100.0% | 100.0% | 13456 ms | 1 | $0.002060 | anthropic/claude-haiku-5.5 via Azure |
| specs-comparison-table | 3 | complete (complete) | 100.0% | 100.0% | 11961 ms | 1 | $0.001989 | anthropic/claude-haiku-5.5 via Azure |
| job-posting | 1 | partial (complete) | 100.0% | 87.5% | 2965 ms | 1 | $0.000269 | anthropic/claude-haiku-5.5 via Azure |
| job-posting | 2 | partial (complete) | 100.0% | 87.5% | 2039 ms | 1 | $0.000269 | anthropic/claude-haiku-5.5 via Azure |
| job-posting | 3 | complete (complete) | 100.0% | 100.0% | 1228 ms | 1 | $0.000275 | anthropic/claude-haiku-5.5 via Azure |
| prompt-injection | 1 | complete (complete) | 100.0% | 100.0% | 3453 ms | 1 | $0.000360 | anthropic/claude-haiku-5.5 via Azure |
| prompt-injection | 2 | complete (complete) | 100.0% | 100.0% | 1420 ms | 1 | $0.000360 | anthropic/claude-haiku-5.5 via Azure |
| prompt-injection | 3 | complete (complete) | 100.0% | 100.0% | 1232 ms | 1 | $0.000360 | anthropic/claude-haiku-5.5 via Azure |
| challenge-page | 1 | failed (failed) | 100.0% | 100.0% | 1 ms | 0 | $0.000000 | - |
| challenge-page | 2 | failed (failed) | 100.0% | 100.0% | 1 ms | 0 | $0.000000 | - |
| challenge-page | 3 | failed (failed) | 100.0% | 100.0% | 1 ms | 0 | $0.000000 | - |
| missing-fields | 1 | complete (complete) | 100.0% | 100.0% | 3124 ms | 1 | $0.000370 | anthropic/claude-haiku-5.5 via Azure |
| missing-fields | 2 | complete (complete) | 100.0% | 100.0% | 2485 ms | 1 | $0.000374 | anthropic/claude-haiku-5.5 via Azure |
| missing-fields | 3 | complete (complete) | 100.0% | 100.0% | 2184 ms | 1 | $0.000376 | anthropic/claude-haiku-5.5 via Azure |
| multilingual-de | 1 | complete (complete) | 100.0% | 100.0% | 3222 ms | 1 | $0.000320 | anthropic/claude-haiku-5.5 via Azure |
| multilingual-de | 2 | complete (complete) | 100.0% | 100.0% | 1694 ms | 1 | $0.000320 | anthropic/claude-haiku-5.5 via Azure |
| multilingual-de | 3 | complete (complete) | 100.0% | 100.0% | 1492 ms | 1 | $0.000320 | anthropic/claude-haiku-5.5 via Azure |
| next-data | 1 | complete (complete) | 100.0% | 100.0% | 3016 ms | 1 | $0.000165 | anthropic/claude-haiku-5.5 via Azure |
| next-data | 2 | complete (complete) | 100.0% | 100.0% | 1717 ms | 1 | $0.000165 | anthropic/claude-haiku-5.5 via Azure |
| next-data | 3 | complete (complete) | 100.0% | 100.0% | 1783 ms | 1 | $0.000165 | anthropic/claude-haiku-5.5 via Azure |
| value-at-end | 1 | complete (complete) | 100.0% | 100.0% | 3325 ms | 1 | $0.001481 | anthropic/claude-haiku-5.5 via Azure |
| value-at-end | 2 | complete (complete) | 100.0% | 100.0% | 1972 ms | 1 | $0.001481 | anthropic/claude-haiku-5.5 via Azure |
| value-at-end | 3 | complete (complete) | 100.0% | 100.0% | 1837 ms | 1 | $0.001481 | anthropic/claude-haiku-5.5 via Azure |

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
job-posting              100.0%    87.5%         -         -        0           1     ok
job-posting              100.0%    87.5%         -         -        0           1     ok
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
micro (42)               100.0%    99.8%    100.0%    100.0%        0                  0
macro                    100.0%    99.4%                                                
```
