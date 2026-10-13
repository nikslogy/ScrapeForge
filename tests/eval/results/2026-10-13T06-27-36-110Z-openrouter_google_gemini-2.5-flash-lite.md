# Extraction eval: openrouter:google/gemini-2.5-flash-lite

Run 2026-10-13T06:27:36.110Z; 42 extraction(s), repeat 3, full engine, spend cap $0.1/extraction.

| metric | value |
|---|---|
| value precision (micro / macro) | 100.0% / 100.0% |
| value recall (micro / macro) | 100.0% / 100.0% |
| status accuracy | 85.7% |
| latency p50 / p95 | 668 ms / 4934 ms |
| model calls / tokens in / out | 36 / 113037 / 14442 |
| total cost | $0.015810 |
| cost per correct field | $0.0000194 |
| statuses | complete 33, partial 6, failed 3 |
| failures by category | none |

## Per fixture

| fixture | run | status (expected) | P | R | latency | calls | cost | resolved model |
|---|---|---|---|---|---|---|---|---|
| book-pdp-jsonld | 1 | complete (complete) | 100.0% | 100.0% | 631 ms | 1 | $0.000227 | google/gemini-2.5-flash-lite via Google |
| book-pdp-jsonld | 2 | complete (complete) | 100.0% | 100.0% | 929 ms | 1 | $0.000064 | google/gemini-2.5-flash-lite via Google |
| book-pdp-jsonld | 3 | complete (complete) | 100.0% | 100.0% | 976 ms | 1 | $0.000064 | google/gemini-2.5-flash-lite via Google |
| book-pdp-plain | 1 | complete (complete) | 100.0% | 100.0% | 1200 ms | 1 | $0.000264 | google/gemini-2.5-flash-lite via Google |
| book-pdp-plain | 2 | complete (complete) | 100.0% | 100.0% | 779 ms | 1 | $0.000116 | google/gemini-2.5-flash-lite via Google |
| book-pdp-plain | 3 | complete (complete) | 100.0% | 100.0% | 823 ms | 1 | $0.000264 | google/gemini-2.5-flash-lite via Google |
| books-listing | 1 | complete (complete) | 100.0% | 100.0% | 5056 ms | 1 | $0.001646 | google/gemini-2.5-flash-lite via Google |
| books-listing | 2 | complete (complete) | 100.0% | 100.0% | 4934 ms | 1 | $0.001646 | google/gemini-2.5-flash-lite via Google |
| books-listing | 3 | complete (complete) | 100.0% | 100.0% | 5106 ms | 1 | $0.001646 | google/gemini-2.5-flash-lite via Google |
| electronics-pdp-sale | 1 | complete (complete) | 100.0% | 100.0% | 1066 ms | 1 | $0.000360 | google/gemini-2.5-flash-lite via Google |
| electronics-pdp-sale | 2 | complete (complete) | 100.0% | 100.0% | 681 ms | 1 | $0.000360 | google/gemini-2.5-flash-lite via Google |
| electronics-pdp-sale | 3 | complete (complete) | 100.0% | 100.0% | 615 ms | 1 | $0.000112 | google/gemini-2.5-flash-lite via Google |
| saas-pricing | 1 | partial (complete) | 100.0% | 100.0% | 1556 ms | 1 | $0.000316 | google/gemini-2.5-flash-lite via Google |
| saas-pricing | 2 | partial (complete) | 100.0% | 100.0% | 1095 ms | 1 | $0.000159 | google/gemini-2.5-flash-lite via Google |
| saas-pricing | 3 | partial (complete) | 100.0% | 100.0% | 1071 ms | 1 | $0.000316 | google/gemini-2.5-flash-lite via Google |
| news-article | 1 | complete (complete) | 100.0% | 100.0% | 10 ms | 0 | $0.000000 | - |
| news-article | 2 | complete (complete) | 100.0% | 100.0% | 14 ms | 0 | $0.000000 | - |
| news-article | 3 | complete (complete) | 100.0% | 100.0% | 4 ms | 0 | $0.000000 | - |
| specs-comparison-table | 1 | partial (complete) | 100.0% | 100.0% | 3765 ms | 1 | $0.000974 | google/gemini-2.5-flash-lite via Google |
| specs-comparison-table | 2 | partial (complete) | 100.0% | 100.0% | 3663 ms | 1 | $0.000974 | google/gemini-2.5-flash-lite via Google |
| specs-comparison-table | 3 | partial (complete) | 100.0% | 100.0% | 3643 ms | 1 | $0.000744 | google/gemini-2.5-flash-lite via Google |
| job-posting | 1 | complete (complete) | 100.0% | 100.0% | 730 ms | 1 | $0.000182 | google/gemini-2.5-flash-lite via Google |
| job-posting | 2 | complete (complete) | 100.0% | 100.0% | 579 ms | 1 | $0.000182 | google/gemini-2.5-flash-lite via Google |
| job-posting | 3 | complete (complete) | 100.0% | 100.0% | 549 ms | 1 | $0.000182 | google/gemini-2.5-flash-lite via Google |
| prompt-injection | 1 | complete (complete) | 100.0% | 100.0% | 669 ms | 1 | $0.000243 | google/gemini-2.5-flash-lite via Google |
| prompt-injection | 2 | complete (complete) | 100.0% | 100.0% | 573 ms | 1 | $0.000082 | google/gemini-2.5-flash-lite via Google |
| prompt-injection | 3 | complete (complete) | 100.0% | 100.0% | 615 ms | 1 | $0.000243 | google/gemini-2.5-flash-lite via Google |
| challenge-page | 1 | failed (failed) | 100.0% | 100.0% | 6 ms | 0 | $0.000000 | - |
| challenge-page | 2 | failed (failed) | 100.0% | 100.0% | 2 ms | 0 | $0.000000 | - |
| challenge-page | 3 | failed (failed) | 100.0% | 100.0% | 2 ms | 0 | $0.000000 | - |
| missing-fields | 1 | complete (complete) | 100.0% | 100.0% | 592 ms | 1 | $0.000221 | google/gemini-2.5-flash-lite via Google |
| missing-fields | 2 | complete (complete) | 100.0% | 100.0% | 581 ms | 1 | $0.000221 | google/gemini-2.5-flash-lite via Google |
| missing-fields | 3 | complete (complete) | 100.0% | 100.0% | 668 ms | 1 | $0.000221 | google/gemini-2.5-flash-lite via Google |
| multilingual-de | 1 | complete (complete) | 100.0% | 100.0% | 599 ms | 1 | $0.000203 | google/gemini-2.5-flash-lite via Google |
| multilingual-de | 2 | complete (complete) | 100.0% | 100.0% | 665 ms | 1 | $0.000203 | google/gemini-2.5-flash-lite via Google |
| multilingual-de | 3 | complete (complete) | 100.0% | 100.0% | 628 ms | 1 | $0.000203 | google/gemini-2.5-flash-lite via Google |
| next-data | 1 | complete (complete) | 100.0% | 100.0% | 614 ms | 1 | $0.000089 | google/gemini-2.5-flash-lite via Google |
| next-data | 2 | complete (complete) | 100.0% | 100.0% | 514 ms | 1 | $0.000089 | google/gemini-2.5-flash-lite via Google |
| next-data | 3 | complete (complete) | 100.0% | 100.0% | 492 ms | 1 | $0.000089 | google/gemini-2.5-flash-lite via Google |
| value-at-end | 1 | complete (complete) | 100.0% | 100.0% | 812 ms | 1 | $0.000968 | google/gemini-2.5-flash-lite via Google |
| value-at-end | 2 | complete (complete) | 100.0% | 100.0% | 825 ms | 1 | $0.000968 | google/gemini-2.5-flash-lite via Google |
| value-at-end | 3 | complete (complete) | 100.0% | 100.0% | 909 ms | 1 | $0.000968 | google/gemini-2.5-flash-lite via Google |

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
