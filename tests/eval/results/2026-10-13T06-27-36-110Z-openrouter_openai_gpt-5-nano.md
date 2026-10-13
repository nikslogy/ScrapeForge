# Extraction eval: openrouter:openai/gpt-5-nano

Run 2026-10-13T06:27:36.110Z; 42 extraction(s), repeat 3, full engine, spend cap $0.1/extraction.

| metric | value |
|---|---|
| value precision (micro / macro) | 98.9% / 97.9% |
| value recall (micro / macro) | 80.9% / 93.4% |
| status accuracy | 61.9% |
| latency p50 / p95 | 1131 ms / 12288 ms |
| model calls / tokens in / out | 36 / 98958 / 12774 |
| total cost | $0.007206 |
| cost per correct field | $0.0000110 |
| statuses | complete 23, partial 16, failed 3 |
| failures by category | none |

## Per fixture

| fixture | run | status (expected) | P | R | latency | calls | cost | resolved model |
|---|---|---|---|---|---|---|---|---|
| book-pdp-jsonld | 1 | complete (complete) | 100.0% | 100.0% | 1143 ms | 1 | $0.000116 | openai/gpt-5-nano via OpenAI |
| book-pdp-jsonld | 2 | complete (complete) | 100.0% | 100.0% | 1396 ms | 1 | $0.000041 | openai/gpt-5-nano via OpenAI |
| book-pdp-jsonld | 3 | complete (complete) | 100.0% | 100.0% | 1031 ms | 1 | $0.000041 | openai/gpt-5-nano via OpenAI |
| book-pdp-plain | 1 | complete (complete) | 85.7% | 85.7% | 1523 ms | 1 | $0.000149 | openai/gpt-5-nano via OpenAI |
| book-pdp-plain | 2 | partial (complete) | 100.0% | 85.7% | 1439 ms | 1 | $0.000070 | openai/gpt-5-nano via OpenAI |
| book-pdp-plain | 3 | partial (complete) | 100.0% | 85.7% | 1601 ms | 1 | $0.000070 | openai/gpt-5-nano via OpenAI |
| books-listing | 1 | partial (complete) | 100.0% | 80.0% | 12288 ms | 1 | $0.000873 | openai/gpt-5-nano via OpenAI |
| books-listing | 2 | partial (complete) | 100.0% | 80.0% | 12861 ms | 1 | $0.000929 | openai/gpt-5-nano via OpenAI |
| books-listing | 3 | partial (complete) | 100.0% | 80.0% | 12819 ms | 1 | $0.000929 | openai/gpt-5-nano via OpenAI |
| electronics-pdp-sale | 1 | partial (complete) | 100.0% | 88.9% | 1477 ms | 1 | $0.000177 | openai/gpt-5-nano via OpenAI |
| electronics-pdp-sale | 2 | partial (complete) | 100.0% | 88.9% | 1200 ms | 1 | $0.000056 | openai/gpt-5-nano via OpenAI |
| electronics-pdp-sale | 3 | partial (complete) | 100.0% | 88.9% | 1200 ms | 1 | $0.000056 | openai/gpt-5-nano via OpenAI |
| saas-pricing | 1 | partial (complete) | 100.0% | 100.0% | 2367 ms | 1 | $0.000197 | openai/gpt-5-nano via OpenAI |
| saas-pricing | 2 | partial (complete) | 100.0% | 100.0% | 2166 ms | 1 | $0.000117 | openai/gpt-5-nano via OpenAI |
| saas-pricing | 3 | partial (complete) | 100.0% | 100.0% | 2196 ms | 1 | $0.000116 | openai/gpt-5-nano via OpenAI |
| news-article | 1 | complete (complete) | 100.0% | 100.0% | 6 ms | 0 | $0.000000 | - |
| news-article | 2 | complete (complete) | 100.0% | 100.0% | 5 ms | 0 | $0.000000 | - |
| news-article | 3 | complete (complete) | 100.0% | 100.0% | 9 ms | 0 | $0.000000 | - |
| specs-comparison-table | 1 | partial (complete) | 100.0% | 100.0% | 7318 ms | 1 | $0.000697 | openai/gpt-5-nano via OpenAI |
| specs-comparison-table | 2 | partial (complete) | 100.0% | 100.0% | 7667 ms | 1 | $0.000697 | openai/gpt-5-nano via OpenAI |
| specs-comparison-table | 3 | complete (complete) | 85.7% | 17.3% | 3303 ms | 1 | $0.000249 | openai/gpt-5-nano via OpenAI |
| job-posting | 1 | complete (complete) | 100.0% | 100.0% | 1754 ms | 1 | $0.000093 | openai/gpt-5-nano via OpenAI |
| job-posting | 2 | complete (complete) | 100.0% | 100.0% | 1100 ms | 1 | $0.000030 | openai/gpt-5-nano via OpenAI |
| job-posting | 3 | complete (complete) | 100.0% | 100.0% | 1390 ms | 1 | $0.000048 | openai/gpt-5-nano via OpenAI |
| prompt-injection | 1 | complete (complete) | 100.0% | 100.0% | 1190 ms | 1 | $0.000123 | openai/gpt-5-nano via OpenAI |
| prompt-injection | 2 | complete (complete) | 100.0% | 100.0% | 938 ms | 1 | $0.000125 | openai/gpt-5-nano via OpenAI |
| prompt-injection | 3 | complete (complete) | 100.0% | 100.0% | 1499 ms | 1 | $0.000043 | openai/gpt-5-nano via OpenAI |
| challenge-page | 1 | failed (failed) | 100.0% | 100.0% | 2 ms | 0 | $0.000000 | - |
| challenge-page | 2 | failed (failed) | 100.0% | 100.0% | 1 ms | 0 | $0.000000 | - |
| challenge-page | 3 | failed (failed) | 100.0% | 100.0% | 1 ms | 0 | $0.000000 | - |
| missing-fields | 1 | partial (complete) | 100.0% | 100.0% | 889 ms | 1 | $0.000113 | openai/gpt-5-nano via OpenAI |
| missing-fields | 2 | partial (complete) | 100.0% | 100.0% | 830 ms | 1 | $0.000032 | openai/gpt-5-nano via OpenAI |
| missing-fields | 3 | partial (complete) | 100.0% | 100.0% | 885 ms | 1 | $0.000032 | openai/gpt-5-nano via OpenAI |
| multilingual-de | 1 | complete (complete) | 100.0% | 100.0% | 933 ms | 1 | $0.000102 | openai/gpt-5-nano via OpenAI |
| multilingual-de | 2 | complete (complete) | 100.0% | 100.0% | 754 ms | 1 | $0.000032 | openai/gpt-5-nano via OpenAI |
| multilingual-de | 3 | complete (complete) | 100.0% | 100.0% | 1002 ms | 1 | $0.000032 | openai/gpt-5-nano via OpenAI |
| next-data | 1 | complete (complete) | 80.0% | 80.0% | 1005 ms | 1 | $0.000064 | openai/gpt-5-nano via OpenAI |
| next-data | 2 | complete (complete) | 80.0% | 80.0% | 1131 ms | 1 | $0.000072 | openai/gpt-5-nano via OpenAI |
| next-data | 3 | complete (complete) | 80.0% | 80.0% | 849 ms | 1 | $0.000063 | openai/gpt-5-nano via OpenAI |
| value-at-end | 1 | complete (complete) | 100.0% | 100.0% | 882 ms | 1 | $0.000476 | openai/gpt-5-nano via OpenAI |
| value-at-end | 2 | complete (complete) | 100.0% | 100.0% | 931 ms | 1 | $0.000073 | openai/gpt-5-nano via OpenAI |
| value-at-end | 3 | complete (complete) | 100.0% | 100.0% | 895 ms | 1 | $0.000073 | openai/gpt-5-nano via OpenAI |

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
specs-comparison-table    85.7%    17.3%    100.0%     20.0%        0          15     ok
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
micro (42)                98.9%    80.9%    100.0%     89.7%        0                  0
macro                     97.9%    93.4%                                                
```
