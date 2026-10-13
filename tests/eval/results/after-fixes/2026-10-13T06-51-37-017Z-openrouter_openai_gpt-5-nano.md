# Extraction eval: openrouter:openai/gpt-5-nano

Run 2026-10-13T06:51:37.017Z; 42 extraction(s), repeat 3, full engine, spend cap $0.1/extraction.

| metric | value |
|---|---|
| value precision (micro / macro) | 99.1% / 97.7% |
| value recall (micro / macro) | 84.5% / 94.3% |
| status accuracy | 78.6% |
| latency p50 / p95 | 1058 ms / 14245 ms |
| model calls / tokens in / out | 36 / 98958 / 13959 |
| total cost | $0.008216 |
| cost per correct field | $0.0000120 |
| statuses | complete 30, partial 9, failed 3 |
| failures by category | none |

## Per fixture

| fixture | run | status (expected) | P | R | latency | calls | cost | resolved model |
|---|---|---|---|---|---|---|---|---|
| book-pdp-jsonld | 1 | complete (complete) | 100.0% | 100.0% | 1111 ms | 1 | $0.000116 | openai/gpt-5-nano via OpenAI |
| book-pdp-jsonld | 2 | complete (complete) | 100.0% | 100.0% | 1046 ms | 1 | $0.000041 | openai/gpt-5-nano via OpenAI |
| book-pdp-jsonld | 3 | complete (complete) | 100.0% | 100.0% | 1070 ms | 1 | $0.000041 | openai/gpt-5-nano via OpenAI |
| book-pdp-plain | 1 | complete (complete) | 85.7% | 85.7% | 1561 ms | 1 | $0.000147 | openai/gpt-5-nano via OpenAI |
| book-pdp-plain | 2 | partial (complete) | 100.0% | 85.7% | 1537 ms | 1 | $0.000151 | openai/gpt-5-nano via OpenAI |
| book-pdp-plain | 3 | partial (complete) | 100.0% | 85.7% | 1537 ms | 1 | $0.000074 | openai/gpt-5-nano via OpenAI |
| books-listing | 1 | partial (complete) | 100.0% | 80.0% | 14937 ms | 1 | $0.001172 | openai/gpt-5-nano via OpenAI |
| books-listing | 2 | partial (complete) | 100.0% | 80.0% | 14245 ms | 1 | $0.001171 | openai/gpt-5-nano via OpenAI |
| books-listing | 3 | partial (complete) | 100.0% | 80.0% | 14837 ms | 1 | $0.000929 | openai/gpt-5-nano via OpenAI |
| electronics-pdp-sale | 1 | complete (complete) | 88.9% | 88.9% | 1213 ms | 1 | $0.000172 | openai/gpt-5-nano via OpenAI |
| electronics-pdp-sale | 2 | complete (complete) | 100.0% | 100.0% | 1318 ms | 1 | $0.000056 | openai/gpt-5-nano via OpenAI |
| electronics-pdp-sale | 3 | complete (complete) | 88.9% | 88.9% | 1363 ms | 1 | $0.000056 | openai/gpt-5-nano via OpenAI |
| saas-pricing | 1 | complete (complete) | 100.0% | 100.0% | 2332 ms | 1 | $0.000198 | openai/gpt-5-nano via OpenAI |
| saas-pricing | 2 | complete (complete) | 100.0% | 100.0% | 2322 ms | 1 | $0.000116 | openai/gpt-5-nano via OpenAI |
| saas-pricing | 3 | complete (complete) | 100.0% | 100.0% | 2250 ms | 1 | $0.000117 | openai/gpt-5-nano via OpenAI |
| news-article | 1 | complete (complete) | 100.0% | 100.0% | 5 ms | 0 | $0.000000 | - |
| news-article | 2 | complete (complete) | 100.0% | 100.0% | 5 ms | 0 | $0.000000 | - |
| news-article | 3 | complete (complete) | 100.0% | 100.0% | 4 ms | 0 | $0.000000 | - |
| specs-comparison-table | 1 | complete (complete) | 100.0% | 100.0% | 9924 ms | 1 | $0.000738 | openai/gpt-5-nano via OpenAI |
| specs-comparison-table | 2 | partial (complete) | 100.0% | 44.2% | 9757 ms | 1 | $0.000632 | openai/gpt-5-nano via OpenAI |
| specs-comparison-table | 3 | complete (complete) | 100.0% | 100.0% | 9240 ms | 1 | $0.000599 | openai/gpt-5-nano via OpenAI |
| job-posting | 1 | complete (complete) | 100.0% | 100.0% | 1054 ms | 1 | $0.000093 | openai/gpt-5-nano via OpenAI |
| job-posting | 2 | complete (complete) | 100.0% | 100.0% | 1115 ms | 1 | $0.000030 | openai/gpt-5-nano via OpenAI |
| job-posting | 3 | complete (complete) | 100.0% | 100.0% | 1105 ms | 1 | $0.000030 | openai/gpt-5-nano via OpenAI |
| prompt-injection | 1 | complete (complete) | 100.0% | 100.0% | 958 ms | 1 | $0.000125 | openai/gpt-5-nano via OpenAI |
| prompt-injection | 2 | complete (complete) | 100.0% | 100.0% | 960 ms | 1 | $0.000123 | openai/gpt-5-nano via OpenAI |
| prompt-injection | 3 | complete (complete) | 100.0% | 100.0% | 1027 ms | 1 | $0.000044 | openai/gpt-5-nano via OpenAI |
| challenge-page | 1 | failed (failed) | 100.0% | 100.0% | 1 ms | 0 | $0.000000 | - |
| challenge-page | 2 | failed (failed) | 100.0% | 100.0% | 1 ms | 0 | $0.000000 | - |
| challenge-page | 3 | failed (failed) | 100.0% | 100.0% | 1 ms | 0 | $0.000000 | - |
| missing-fields | 1 | partial (complete) | 100.0% | 100.0% | 950 ms | 1 | $0.000114 | openai/gpt-5-nano via OpenAI |
| missing-fields | 2 | partial (complete) | 100.0% | 100.0% | 1034 ms | 1 | $0.000033 | openai/gpt-5-nano via OpenAI |
| missing-fields | 3 | partial (complete) | 100.0% | 100.0% | 927 ms | 1 | $0.000033 | openai/gpt-5-nano via OpenAI |
| multilingual-de | 1 | complete (complete) | 100.0% | 100.0% | 903 ms | 1 | $0.000102 | openai/gpt-5-nano via OpenAI |
| multilingual-de | 2 | complete (complete) | 100.0% | 100.0% | 865 ms | 1 | $0.000032 | openai/gpt-5-nano via OpenAI |
| multilingual-de | 3 | complete (complete) | 100.0% | 100.0% | 989 ms | 1 | $0.000102 | openai/gpt-5-nano via OpenAI |
| next-data | 1 | complete (complete) | 80.0% | 80.0% | 1036 ms | 1 | $0.000062 | openai/gpt-5-nano via OpenAI |
| next-data | 2 | complete (complete) | 80.0% | 80.0% | 1166 ms | 1 | $0.000070 | openai/gpt-5-nano via OpenAI |
| next-data | 3 | complete (complete) | 80.0% | 80.0% | 1338 ms | 1 | $0.000074 | openai/gpt-5-nano via OpenAI |
| value-at-end | 1 | complete (complete) | 100.0% | 100.0% | 1058 ms | 1 | $0.000476 | openai/gpt-5-nano via OpenAI |
| value-at-end | 2 | complete (complete) | 100.0% | 100.0% | 902 ms | 1 | $0.000073 | openai/gpt-5-nano via OpenAI |
| value-at-end | 3 | complete (complete) | 100.0% | 100.0% | 971 ms | 1 | $0.000073 | openai/gpt-5-nano via OpenAI |

## Scores (scoring.ts)

```
fixture                 value P  value R  record P  record R  halluc.  mismatches  shape
----------------------  -------  -------  --------  --------  -------  ----------  -----
book-pdp-jsonld          100.0%   100.0%         -         -        0           0     ok
book-pdp-jsonld          100.0%   100.0%         -         -        0           0     ok
book-pdp-jsonld          100.0%   100.0%         -         -        0           0     ok
book-pdp-plain            85.7%    85.7%         -         -        0           1     ok
book-pdp-plain           100.0%    85.7%         -         -        0           1     ok
book-pdp-plain           100.0%    85.7%         -         -        0           1     ok
books-listing            100.0%    80.0%    100.0%    100.0%        0          20     ok
books-listing            100.0%    80.0%    100.0%    100.0%        0          20     ok
books-listing            100.0%    80.0%    100.0%    100.0%        0          20     ok
electronics-pdp-sale      88.9%    88.9%         -         -        0           1     ok
electronics-pdp-sale     100.0%   100.0%         -         -        0           0     ok
electronics-pdp-sale      88.9%    88.9%         -         -        0           1     ok
saas-pricing             100.0%   100.0%    100.0%    100.0%        0           0     ok
saas-pricing             100.0%   100.0%    100.0%    100.0%        0           0     ok
saas-pricing             100.0%   100.0%    100.0%    100.0%        0           0     ok
news-article             100.0%   100.0%         -         -        0           0     ok
news-article             100.0%   100.0%         -         -        0           0     ok
news-article             100.0%   100.0%         -         -        0           0     ok
specs-comparison-table   100.0%   100.0%    100.0%    100.0%        0           0     ok
specs-comparison-table   100.0%    44.2%    100.0%    100.0%        0          58     ok
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
next-data                 80.0%    80.0%         -         -        0           1     ok
next-data                 80.0%    80.0%         -         -        0           1     ok
next-data                 80.0%    80.0%         -         -        0           1     ok
value-at-end             100.0%   100.0%         -         -        0           0     ok
value-at-end             100.0%   100.0%         -         -        0           0     ok
value-at-end             100.0%   100.0%         -         -        0           0     ok
micro (42)                99.1%    84.5%    100.0%    100.0%        0                  0
macro                     97.7%    94.3%                                                
```
