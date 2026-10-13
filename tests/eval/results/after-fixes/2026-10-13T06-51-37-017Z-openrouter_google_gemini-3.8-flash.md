# Extraction eval: openrouter:google/gemini-3.8-flash

Run 2026-10-13T06:51:37.017Z; 42 extraction(s), repeat 3, full engine, spend cap $0.1/extraction.

| metric | value |
|---|---|
| value precision (micro / macro) | 100.0% / 100.0% |
| value recall (micro / macro) | 99.1% / 99.0% |
| status accuracy | 92.9% |
| latency p50 / p95 | 1875 ms / 15288 ms |
| model calls / tokens in / out | 36 / 109176 / 14304 |
| total cost | $0.123772 |
| cost per correct field | $0.0001536 |
| statuses | complete 36, partial 3, failed 3 |
| failures by category | none |

## Per fixture

| fixture | run | status (expected) | P | R | latency | calls | cost | resolved model |
|---|---|---|---|---|---|---|---|---|
| book-pdp-jsonld | 1 | complete (complete) | 100.0% | 100.0% | 1866 ms | 1 | $0.001681 | google/gemini-3.8-flash via Google AI Studio |
| book-pdp-jsonld | 2 | complete (complete) | 100.0% | 100.0% | 1651 ms | 1 | $0.001681 | google/gemini-3.8-flash via Google AI Studio |
| book-pdp-jsonld | 3 | complete (complete) | 100.0% | 100.0% | 1627 ms | 1 | $0.001681 | google/gemini-3.8-flash via Google AI Studio |
| book-pdp-plain | 1 | complete (complete) | 100.0% | 100.0% | 2432 ms | 1 | $0.001913 | google/gemini-3.8-flash via Google AI Studio |
| book-pdp-plain | 2 | complete (complete) | 100.0% | 100.0% | 2200 ms | 1 | $0.001913 | google/gemini-3.8-flash via Google AI Studio |
| book-pdp-plain | 3 | complete (complete) | 100.0% | 100.0% | 2426 ms | 1 | $0.001917 | google/gemini-3.8-flash via Google AI Studio |
| books-listing | 1 | complete (complete) | 100.0% | 98.0% | 15484 ms | 1 | $0.013961 | google/gemini-3.8-flash via Google AI Studio |
| books-listing | 2 | complete (complete) | 100.0% | 98.0% | 15528 ms | 1 | $0.010614 | google/gemini-3.8-flash via Google AI Studio |
| books-listing | 3 | complete (complete) | 100.0% | 100.0% | 15288 ms | 1 | $0.010655 | google/gemini-3.8-flash via Google AI Studio |
| electronics-pdp-sale | 1 | complete (complete) | 100.0% | 100.0% | 1889 ms | 1 | $0.002651 | google/gemini-3.8-flash via Google AI Studio |
| electronics-pdp-sale | 2 | complete (complete) | 100.0% | 100.0% | 1875 ms | 1 | $0.002654 | google/gemini-3.8-flash via Google AI Studio |
| electronics-pdp-sale | 3 | complete (complete) | 100.0% | 100.0% | 2225 ms | 1 | $0.002662 | google/gemini-3.8-flash via Google AI Studio |
| saas-pricing | 1 | complete (complete) | 100.0% | 100.0% | 2715 ms | 1 | $0.002415 | google/gemini-3.8-flash via Google AI Studio |
| saas-pricing | 2 | complete (complete) | 100.0% | 100.0% | 2970 ms | 1 | $0.002415 | google/gemini-3.8-flash via Google AI Studio |
| saas-pricing | 3 | complete (complete) | 100.0% | 100.0% | 2878 ms | 1 | $0.002415 | google/gemini-3.8-flash via Google AI Studio |
| news-article | 1 | complete (complete) | 100.0% | 100.0% | 5 ms | 0 | $0.000000 | - |
| news-article | 2 | complete (complete) | 100.0% | 100.0% | 4 ms | 0 | $0.000000 | - |
| news-article | 3 | complete (complete) | 100.0% | 100.0% | 4 ms | 0 | $0.000000 | - |
| specs-comparison-table | 1 | complete (complete) | 100.0% | 100.0% | 11497 ms | 1 | $0.008455 | google/gemini-3.8-flash via Google AI Studio |
| specs-comparison-table | 2 | complete (complete) | 100.0% | 100.0% | 10954 ms | 1 | $0.008455 | google/gemini-3.8-flash via Google AI Studio |
| specs-comparison-table | 3 | complete (complete) | 100.0% | 100.0% | 12547 ms | 1 | $0.008452 | google/gemini-3.8-flash via Google AI Studio |
| job-posting | 1 | partial (complete) | 100.0% | 87.5% | 1586 ms | 1 | $0.001308 | google/gemini-3.8-flash via Google AI Studio |
| job-posting | 2 | partial (complete) | 100.0% | 87.5% | 1496 ms | 1 | $0.001312 | google/gemini-3.8-flash via Google AI Studio |
| job-posting | 3 | partial (complete) | 100.0% | 87.5% | 1811 ms | 1 | $0.001308 | google/gemini-3.8-flash via Google AI Studio |
| prompt-injection | 1 | complete (complete) | 100.0% | 100.0% | 1925 ms | 1 | $0.001794 | google/gemini-3.8-flash via Google AI Studio |
| prompt-injection | 2 | complete (complete) | 100.0% | 100.0% | 1938 ms | 1 | $0.001794 | google/gemini-3.8-flash via Google AI Studio |
| prompt-injection | 3 | complete (complete) | 100.0% | 100.0% | 1958 ms | 1 | $0.001790 | google/gemini-3.8-flash via Google AI Studio |
| challenge-page | 1 | failed (failed) | 100.0% | 100.0% | 1 ms | 0 | $0.000000 | - |
| challenge-page | 2 | failed (failed) | 100.0% | 100.0% | 1 ms | 0 | $0.000000 | - |
| challenge-page | 3 | failed (failed) | 100.0% | 100.0% | 1 ms | 0 | $0.000000 | - |
| missing-fields | 1 | complete (complete) | 100.0% | 100.0% | 1731 ms | 1 | $0.001610 | google/gemini-3.8-flash via Google AI Studio |
| missing-fields | 2 | complete (complete) | 100.0% | 100.0% | 1651 ms | 1 | $0.001607 | google/gemini-3.8-flash via Google AI Studio |
| missing-fields | 3 | complete (complete) | 100.0% | 100.0% | 1634 ms | 1 | $0.001607 | google/gemini-3.8-flash via Google AI Studio |
| multilingual-de | 1 | complete (complete) | 100.0% | 100.0% | 1898 ms | 1 | $0.001498 | google/gemini-3.8-flash via Google AI Studio |
| multilingual-de | 2 | complete (complete) | 100.0% | 100.0% | 1574 ms | 1 | $0.001502 | google/gemini-3.8-flash via Google AI Studio |
| multilingual-de | 3 | complete (complete) | 100.0% | 100.0% | 1559 ms | 1 | $0.001498 | google/gemini-3.8-flash via Google AI Studio |
| next-data | 1 | complete (complete) | 100.0% | 100.0% | 1789 ms | 1 | $0.000632 | google/gemini-3.8-flash via Google AI Studio |
| next-data | 2 | complete (complete) | 100.0% | 100.0% | 2007 ms | 1 | $0.000632 | google/gemini-3.8-flash via Google AI Studio |
| next-data | 3 | complete (complete) | 100.0% | 100.0% | 1670 ms | 1 | $0.000629 | google/gemini-3.8-flash via Google AI Studio |
| value-at-end | 1 | complete (complete) | 100.0% | 100.0% | 2026 ms | 1 | $0.007237 | google/gemini-3.8-flash via Google AI Studio |
| value-at-end | 2 | complete (complete) | 100.0% | 100.0% | 1971 ms | 1 | $0.007237 | google/gemini-3.8-flash via Google AI Studio |
| value-at-end | 3 | complete (complete) | 100.0% | 100.0% | 1369 ms | 1 | $0.002190 | google/gemini-3.8-flash via Google AI Studio |

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
micro (42)               100.0%    99.1%    100.0%    100.0%        0                  0
macro                    100.0%    99.0%                                                
```
