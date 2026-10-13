# Extraction eval: openrouter:google/gemini-2.5-flash-lite

Run 2026-10-13T06:51:37.017Z; 42 extraction(s), repeat 3, full engine, spend cap $0.1/extraction.

| metric | value |
|---|---|
| value precision (micro / macro) | 100.0% / 100.0% |
| value recall (micro / macro) | 100.0% / 100.0% |
| status accuracy | 100.0% |
| latency p50 / p95 | 756 ms / 5049 ms |
| model calls / tokens in / out | 36 / 113037 / 14442 |
| total cost | $0.015102 |
| cost per correct field | $0.0000186 |
| statuses | complete 39, failed 3 |
| failures by category | none |

## Per fixture

| fixture | run | status (expected) | P | R | latency | calls | cost | resolved model |
|---|---|---|---|---|---|---|---|---|
| book-pdp-jsonld | 1 | complete (complete) | 100.0% | 100.0% | 578 ms | 1 | $0.000064 | google/gemini-2.5-flash-lite via Google |
| book-pdp-jsonld | 2 | complete (complete) | 100.0% | 100.0% | 1103 ms | 1 | $0.000064 | google/gemini-2.5-flash-lite via Google |
| book-pdp-jsonld | 3 | complete (complete) | 100.0% | 100.0% | 932 ms | 1 | $0.000064 | google/gemini-2.5-flash-lite via Google |
| book-pdp-plain | 1 | complete (complete) | 100.0% | 100.0% | 1154 ms | 1 | $0.000264 | google/gemini-2.5-flash-lite via Google |
| book-pdp-plain | 2 | complete (complete) | 100.0% | 100.0% | 809 ms | 1 | $0.000116 | google/gemini-2.5-flash-lite via Google |
| book-pdp-plain | 3 | complete (complete) | 100.0% | 100.0% | 903 ms | 1 | $0.000264 | google/gemini-2.5-flash-lite via Google |
| books-listing | 1 | complete (complete) | 100.0% | 100.0% | 5112 ms | 1 | $0.001646 | google/gemini-2.5-flash-lite via Google |
| books-listing | 2 | complete (complete) | 100.0% | 100.0% | 5258 ms | 1 | $0.001646 | google/gemini-2.5-flash-lite via Google |
| books-listing | 3 | complete (complete) | 100.0% | 100.0% | 5049 ms | 1 | $0.001038 | google/gemini-2.5-flash-lite via Google |
| electronics-pdp-sale | 1 | complete (complete) | 100.0% | 100.0% | 753 ms | 1 | $0.000360 | google/gemini-2.5-flash-lite via Google |
| electronics-pdp-sale | 2 | complete (complete) | 100.0% | 100.0% | 698 ms | 1 | $0.000360 | google/gemini-2.5-flash-lite via Google |
| electronics-pdp-sale | 3 | complete (complete) | 100.0% | 100.0% | 796 ms | 1 | $0.000112 | google/gemini-2.5-flash-lite via Google |
| saas-pricing | 1 | complete (complete) | 100.0% | 100.0% | 1056 ms | 1 | $0.000316 | google/gemini-2.5-flash-lite via Google |
| saas-pricing | 2 | complete (complete) | 100.0% | 100.0% | 1072 ms | 1 | $0.000316 | google/gemini-2.5-flash-lite via Google |
| saas-pricing | 3 | complete (complete) | 100.0% | 100.0% | 1156 ms | 1 | $0.000159 | google/gemini-2.5-flash-lite via Google |
| news-article | 1 | complete (complete) | 100.0% | 100.0% | 10 ms | 0 | $0.000000 | - |
| news-article | 2 | complete (complete) | 100.0% | 100.0% | 9 ms | 0 | $0.000000 | - |
| news-article | 3 | complete (complete) | 100.0% | 100.0% | 7 ms | 0 | $0.000000 | - |
| specs-comparison-table | 1 | complete (complete) | 100.0% | 100.0% | 3821 ms | 1 | $0.000974 | google/gemini-2.5-flash-lite via Google |
| specs-comparison-table | 2 | complete (complete) | 100.0% | 100.0% | 3573 ms | 1 | $0.000974 | google/gemini-2.5-flash-lite via Google |
| specs-comparison-table | 3 | complete (complete) | 100.0% | 100.0% | 3760 ms | 1 | $0.000974 | google/gemini-2.5-flash-lite via Google |
| job-posting | 1 | complete (complete) | 100.0% | 100.0% | 589 ms | 1 | $0.000182 | google/gemini-2.5-flash-lite via Google |
| job-posting | 2 | complete (complete) | 100.0% | 100.0% | 1059 ms | 1 | $0.000182 | google/gemini-2.5-flash-lite via Google |
| job-posting | 3 | complete (complete) | 100.0% | 100.0% | 662 ms | 1 | $0.000182 | google/gemini-2.5-flash-lite via Google |
| prompt-injection | 1 | complete (complete) | 100.0% | 100.0% | 611 ms | 1 | $0.000243 | google/gemini-2.5-flash-lite via Google |
| prompt-injection | 2 | complete (complete) | 100.0% | 100.0% | 692 ms | 1 | $0.000243 | google/gemini-2.5-flash-lite via Google |
| prompt-injection | 3 | complete (complete) | 100.0% | 100.0% | 1379 ms | 1 | $0.000082 | google/gemini-2.5-flash-lite via Google |
| challenge-page | 1 | failed (failed) | 100.0% | 100.0% | 6 ms | 0 | $0.000000 | - |
| challenge-page | 2 | failed (failed) | 100.0% | 100.0% | 4 ms | 0 | $0.000000 | - |
| challenge-page | 3 | failed (failed) | 100.0% | 100.0% | 1 ms | 0 | $0.000000 | - |
| missing-fields | 1 | complete (complete) | 100.0% | 100.0% | 675 ms | 1 | $0.000221 | google/gemini-2.5-flash-lite via Google |
| missing-fields | 2 | complete (complete) | 100.0% | 100.0% | 756 ms | 1 | $0.000221 | google/gemini-2.5-flash-lite via Google |
| missing-fields | 3 | complete (complete) | 100.0% | 100.0% | 666 ms | 1 | $0.000221 | google/gemini-2.5-flash-lite via Google |
| multilingual-de | 1 | complete (complete) | 100.0% | 100.0% | 746 ms | 1 | $0.000203 | google/gemini-2.5-flash-lite via Google |
| multilingual-de | 2 | complete (complete) | 100.0% | 100.0% | 689 ms | 1 | $0.000203 | google/gemini-2.5-flash-lite via Google |
| multilingual-de | 3 | complete (complete) | 100.0% | 100.0% | 543 ms | 1 | $0.000037 | google/gemini-2.5-flash-lite via Google |
| next-data | 1 | complete (complete) | 100.0% | 100.0% | 816 ms | 1 | $0.000089 | google/gemini-2.5-flash-lite via Google |
| next-data | 2 | complete (complete) | 100.0% | 100.0% | 556 ms | 1 | $0.000089 | google/gemini-2.5-flash-lite via Google |
| next-data | 3 | complete (complete) | 100.0% | 100.0% | 741 ms | 1 | $0.000089 | google/gemini-2.5-flash-lite via Google |
| value-at-end | 1 | complete (complete) | 100.0% | 100.0% | 1124 ms | 1 | $0.000968 | google/gemini-2.5-flash-lite via Google |
| value-at-end | 2 | complete (complete) | 100.0% | 100.0% | 814 ms | 1 | $0.000968 | google/gemini-2.5-flash-lite via Google |
| value-at-end | 3 | complete (complete) | 100.0% | 100.0% | 1069 ms | 1 | $0.000968 | google/gemini-2.5-flash-lite via Google |

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
