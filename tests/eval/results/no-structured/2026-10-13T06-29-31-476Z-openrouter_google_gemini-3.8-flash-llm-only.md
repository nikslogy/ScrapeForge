# Extraction eval: openrouter:google/gemini-3.8-flash

Run 2026-10-13T06:29:31.476Z; 14 extraction(s), repeat 1, pure LLM path (structured data and recipes disabled), spend cap $0.1/extraction.

| metric | value |
|---|---|
| value precision (micro / macro) | 99.6% / 99.2% |
| value recall (micro / macro) | 95.6% / 87.8% |
| status accuracy | 85.7% |
| latency p50 / p95 | 2101 ms / 13882 ms |
| model calls / tokens in / out | 13 / 40217 / 5375 |
| total cost | $0.046968 |
| cost per correct field | $0.0001813 |
| statuses | complete 11, partial 2, failed 1 |
| failures by category | none |

## Per fixture

| fixture | run | status (expected) | P | R | latency | calls | cost | resolved model |
|---|---|---|---|---|---|---|---|---|
| book-pdp-jsonld | 1 | complete (complete) | 100.0% | 66.7% | 1947 ms | 1 | $0.002024 | google/gemini-3.8-flash via Google AI Studio |
| book-pdp-plain | 1 | complete (complete) | 100.0% | 100.0% | 2768 ms | 1 | $0.001917 | google/gemini-3.8-flash via Google AI Studio |
| books-listing | 1 | complete (complete) | 100.0% | 98.0% | 13882 ms | 1 | $0.010610 | google/gemini-3.8-flash via Google AI Studio |
| electronics-pdp-sale | 1 | complete (complete) | 88.9% | 88.9% | 2424 ms | 1 | $0.003166 | google/gemini-3.8-flash via Google AI Studio |
| saas-pricing | 1 | complete (complete) | 100.0% | 100.0% | 2658 ms | 1 | $0.002415 | google/gemini-3.8-flash via Google AI Studio |
| news-article | 1 | complete (complete) | 100.0% | 100.0% | 2150 ms | 1 | $0.002462 | google/gemini-3.8-flash via Google AI Studio |
| specs-comparison-table | 1 | complete (complete) | 100.0% | 100.0% | 10129 ms | 1 | $0.008455 | google/gemini-3.8-flash via Google AI Studio |
| job-posting | 1 | partial (complete) | 100.0% | 75.0% | 2163 ms | 1 | $0.001957 | google/gemini-3.8-flash via Google AI Studio |
| prompt-injection | 1 | complete (complete) | 100.0% | 100.0% | 2101 ms | 1 | $0.001907 | google/gemini-3.8-flash via Google AI Studio |
| challenge-page | 1 | failed (failed) | 100.0% | 100.0% | 1 ms | 0 | $0.000000 | - |
| missing-fields | 1 | complete (complete) | 100.0% | 100.0% | 1841 ms | 1 | $0.001826 | google/gemini-3.8-flash via Google AI Studio |
| multilingual-de | 1 | partial (complete) | 100.0% | 60.0% | 1933 ms | 1 | $0.001906 | google/gemini-3.8-flash via Google AI Studio |
| next-data | 1 | complete (complete) | 100.0% | 40.0% | 1549 ms | 1 | $0.000904 | google/gemini-3.8-flash via Google AI Studio |
| value-at-end | 1 | complete (complete) | 100.0% | 100.0% | 1931 ms | 1 | $0.007418 | google/gemini-3.8-flash via Google AI Studio |

## Scores (scoring.ts)

```
fixture                 value P  value R  record P  record R  halluc.  mismatches  shape
----------------------  -------  -------  --------  --------  -------  ----------  -----
book-pdp-jsonld          100.0%    66.7%         -         -        0           2     ok
book-pdp-plain           100.0%   100.0%         -         -        0           0     ok
books-listing            100.0%    98.0%    100.0%    100.0%        0           2     ok
electronics-pdp-sale      88.9%    88.9%         -         -        0           1     ok
saas-pricing             100.0%   100.0%    100.0%    100.0%        0           0     ok
news-article             100.0%   100.0%         -         -        0           0     ok
specs-comparison-table   100.0%   100.0%    100.0%    100.0%        0           0     ok
job-posting              100.0%    75.0%         -         -        0           2     ok
prompt-injection         100.0%   100.0%         -         -        0           0     ok
challenge-page           100.0%   100.0%         -         -        0           0     ok
missing-fields           100.0%   100.0%         -         -        0           0     ok
multilingual-de          100.0%    60.0%         -         -        0           2     ok
next-data                100.0%    40.0%         -         -        0           3     ok
value-at-end             100.0%   100.0%         -         -        0           0     ok
micro (14)                99.6%    95.6%    100.0%    100.0%        0                  0
macro                     99.2%    87.8%                                                
```
