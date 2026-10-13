# Extraction eval: openrouter:google/gemini-3.8-flash

Run 2026-10-13T06:27:36.110Z; 42 extraction(s), repeat 3, full engine, spend cap $0.1/extraction.

| metric | value |
|---|---|
| value precision (micro / macro) | 100.0% / 100.0% |
| value recall (micro / macro) | 98.8% / 98.2% |
| status accuracy | 85.7% |
| latency p50 / p95 | 1728 ms / 13221 ms |
| model calls / tokens in / out | 36 / 109176 / 14304 |
| total cost | $0.125468 |
| cost per correct field | $0.0001562 |
| statuses | complete 33, partial 6, failed 3 |
| failures by category | none |

## Per fixture

| fixture | run | status (expected) | P | R | latency | calls | cost | resolved model |
|---|---|---|---|---|---|---|---|---|
| book-pdp-jsonld | 1 | complete (complete) | 100.0% | 100.0% | 1360 ms | 1 | $0.001681 | google/gemini-3.8-flash via Google AI Studio |
| book-pdp-jsonld | 2 | complete (complete) | 100.0% | 100.0% | 1699 ms | 1 | $0.001685 | google/gemini-3.8-flash via Google AI Studio |
| book-pdp-jsonld | 3 | complete (complete) | 100.0% | 100.0% | 1846 ms | 1 | $0.001681 | google/gemini-3.8-flash via Google AI Studio |
| book-pdp-plain | 1 | complete (complete) | 100.0% | 100.0% | 2298 ms | 1 | $0.001917 | google/gemini-3.8-flash via Google AI Studio |
| book-pdp-plain | 2 | complete (complete) | 100.0% | 100.0% | 2024 ms | 1 | $0.001913 | google/gemini-3.8-flash via Google AI Studio |
| book-pdp-plain | 3 | complete (complete) | 100.0% | 100.0% | 1965 ms | 1 | $0.001913 | google/gemini-3.8-flash via Google AI Studio |
| books-listing | 1 | complete (complete) | 100.0% | 98.0% | 13221 ms | 1 | $0.010610 | google/gemini-3.8-flash via Google AI Studio |
| books-listing | 2 | complete (complete) | 100.0% | 98.0% | 15751 ms | 1 | $0.010610 | google/gemini-3.8-flash via Google AI Studio |
| books-listing | 3 | complete (complete) | 100.0% | 100.0% | 13375 ms | 1 | $0.010659 | google/gemini-3.8-flash via Google AI Studio |
| electronics-pdp-sale | 1 | partial (complete) | 100.0% | 88.9% | 1857 ms | 1 | $0.002654 | google/gemini-3.8-flash via Google AI Studio |
| electronics-pdp-sale | 2 | partial (complete) | 100.0% | 88.9% | 2259 ms | 1 | $0.002654 | google/gemini-3.8-flash via Google AI Studio |
| electronics-pdp-sale | 3 | partial (complete) | 100.0% | 88.9% | 1939 ms | 1 | $0.002651 | google/gemini-3.8-flash via Google AI Studio |
| saas-pricing | 1 | complete (complete) | 100.0% | 100.0% | 2430 ms | 1 | $0.002415 | google/gemini-3.8-flash via Google AI Studio |
| saas-pricing | 2 | complete (complete) | 100.0% | 100.0% | 2779 ms | 1 | $0.002415 | google/gemini-3.8-flash via Google AI Studio |
| saas-pricing | 3 | complete (complete) | 100.0% | 100.0% | 2579 ms | 1 | $0.002415 | google/gemini-3.8-flash via Google AI Studio |
| news-article | 1 | complete (complete) | 100.0% | 100.0% | 4 ms | 0 | $0.000000 | - |
| news-article | 2 | complete (complete) | 100.0% | 100.0% | 8 ms | 0 | $0.000000 | - |
| news-article | 3 | complete (complete) | 100.0% | 100.0% | 3 ms | 0 | $0.000000 | - |
| specs-comparison-table | 1 | complete (complete) | 100.0% | 100.0% | 10006 ms | 1 | $0.008452 | google/gemini-3.8-flash via Google AI Studio |
| specs-comparison-table | 2 | complete (complete) | 100.0% | 100.0% | 10461 ms | 1 | $0.008452 | google/gemini-3.8-flash via Google AI Studio |
| specs-comparison-table | 3 | complete (complete) | 100.0% | 100.0% | 10936 ms | 1 | $0.008452 | google/gemini-3.8-flash via Google AI Studio |
| job-posting | 1 | partial (complete) | 100.0% | 87.5% | 1728 ms | 1 | $0.001312 | google/gemini-3.8-flash via Google AI Studio |
| job-posting | 2 | partial (complete) | 100.0% | 87.5% | 1491 ms | 1 | $0.001308 | google/gemini-3.8-flash via Google AI Studio |
| job-posting | 3 | partial (complete) | 100.0% | 87.5% | 1398 ms | 1 | $0.001308 | google/gemini-3.8-flash via Google AI Studio |
| prompt-injection | 1 | complete (complete) | 100.0% | 100.0% | 1875 ms | 1 | $0.001798 | google/gemini-3.8-flash via Google AI Studio |
| prompt-injection | 2 | complete (complete) | 100.0% | 100.0% | 1994 ms | 1 | $0.001798 | google/gemini-3.8-flash via Google AI Studio |
| prompt-injection | 3 | complete (complete) | 100.0% | 100.0% | 2044 ms | 1 | $0.001794 | google/gemini-3.8-flash via Google AI Studio |
| challenge-page | 1 | failed (failed) | 100.0% | 100.0% | 2 ms | 0 | $0.000000 | - |
| challenge-page | 2 | failed (failed) | 100.0% | 100.0% | 1 ms | 0 | $0.000000 | - |
| challenge-page | 3 | failed (failed) | 100.0% | 100.0% | 1 ms | 0 | $0.000000 | - |
| missing-fields | 1 | complete (complete) | 100.0% | 100.0% | 2394 ms | 1 | $0.001610 | google/gemini-3.8-flash via Google AI Studio |
| missing-fields | 2 | complete (complete) | 100.0% | 100.0% | 1429 ms | 1 | $0.001610 | google/gemini-3.8-flash via Google AI Studio |
| missing-fields | 3 | complete (complete) | 100.0% | 100.0% | 1676 ms | 1 | $0.001607 | google/gemini-3.8-flash via Google AI Studio |
| multilingual-de | 1 | complete (complete) | 100.0% | 100.0% | 1406 ms | 1 | $0.001502 | google/gemini-3.8-flash via Google AI Studio |
| multilingual-de | 2 | complete (complete) | 100.0% | 100.0% | 1415 ms | 1 | $0.001502 | google/gemini-3.8-flash via Google AI Studio |
| multilingual-de | 3 | complete (complete) | 100.0% | 100.0% | 1306 ms | 1 | $0.001498 | google/gemini-3.8-flash via Google AI Studio |
| next-data | 1 | complete (complete) | 100.0% | 100.0% | 1066 ms | 1 | $0.000629 | google/gemini-3.8-flash via Google AI Studio |
| next-data | 2 | complete (complete) | 100.0% | 100.0% | 1258 ms | 1 | $0.000629 | google/gemini-3.8-flash via Google AI Studio |
| next-data | 3 | complete (complete) | 100.0% | 100.0% | 1688 ms | 1 | $0.000629 | google/gemini-3.8-flash via Google AI Studio |
| value-at-end | 1 | complete (complete) | 100.0% | 100.0% | 1892 ms | 1 | $0.007237 | google/gemini-3.8-flash via Google AI Studio |
| value-at-end | 2 | complete (complete) | 100.0% | 100.0% | 1559 ms | 1 | $0.007237 | google/gemini-3.8-flash via Google AI Studio |
| value-at-end | 3 | complete (complete) | 100.0% | 100.0% | 1632 ms | 1 | $0.007237 | google/gemini-3.8-flash via Google AI Studio |

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
books-listing            100.0%    98.0%    100.0%    100.0%        0           2     ok
books-listing            100.0%    98.0%    100.0%    100.0%        0           2     ok
books-listing            100.0%   100.0%    100.0%    100.0%        0           0     ok
electronics-pdp-sale     100.0%    88.9%         -         -        0           1     ok
electronics-pdp-sale     100.0%    88.9%         -         -        0           1     ok
electronics-pdp-sale     100.0%    88.9%         -         -        0           1     ok
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
job-posting              100.0%    87.5%         -         -        0           1     ok
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
micro (42)               100.0%    98.8%    100.0%    100.0%        0                  0
macro                    100.0%    98.2%                                                
```
