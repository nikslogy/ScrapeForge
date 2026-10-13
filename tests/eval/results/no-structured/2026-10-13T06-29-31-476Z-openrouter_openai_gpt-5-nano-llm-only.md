# Extraction eval: openrouter:openai/gpt-5-nano

Run 2026-10-13T06:29:31.476Z; 14 extraction(s), repeat 1, pure LLM path (structured data and recipes disabled), spend cap $0.1/extraction.

| metric | value |
|---|---|
| value precision (micro / macro) | 64.8% / 82.1% |
| value recall (micro / macro) | 79.0% / 75.9% |
| status accuracy | 28.6% |
| latency p50 / p95 | 1391 ms / 26196 ms |
| model calls / tokens in / out | 13 / 37334 / 8348 |
| total cost | $0.004618 |
| cost per correct field | $0.0000216 |
| statuses | complete 3, partial 10, failed 1 |
| failures by category | none |

## Per fixture

| fixture | run | status (expected) | P | R | latency | calls | cost | resolved model |
|---|---|---|---|---|---|---|---|---|
| book-pdp-jsonld | 1 | complete (complete) | 83.3% | 83.3% | 1504 ms | 1 | $0.000065 | openai/gpt-5-nano via OpenAI |
| book-pdp-plain | 1 | partial (complete) | 100.0% | 85.7% | 1425 ms | 1 | $0.000070 | openai/gpt-5-nano via OpenAI |
| books-listing | 1 | partial (complete) | 100.0% | 80.0% | 13367 ms | 1 | $0.000929 | openai/gpt-5-nano via OpenAI |
| electronics-pdp-sale | 1 | partial (complete) | 85.7% | 66.7% | 2130 ms | 1 | $0.000238 | openai/gpt-5-nano via OpenAI |
| saas-pricing | 1 | partial (complete) | 100.0% | 100.0% | 2866 ms | 1 | $0.000130 | openai/gpt-5-nano via OpenAI |
| news-article | 1 | partial (complete) | 66.7% | 50.0% | 1629 ms | 1 | $0.000196 | openai/gpt-5-nano via OpenAI |
| specs-comparison-table | 1 | partial (complete) | 43.5% | 79.8% | 26196 ms | 1 | $0.001823 | openai/gpt-5-nano via OpenAI |
| job-posting | 1 | partial (complete) | 87.5% | 87.5% | 1391 ms | 1 | $0.000158 | openai/gpt-5-nano via OpenAI |
| prompt-injection | 1 | complete (complete) | 100.0% | 100.0% | 1161 ms | 1 | $0.000137 | openai/gpt-5-nano via OpenAI |
| challenge-page | 1 | failed (failed) | 100.0% | 100.0% | 2 ms | 0 | $0.000000 | - |
| missing-fields | 1 | partial (complete) | 100.0% | 100.0% | 1069 ms | 1 | $0.000136 | openai/gpt-5-nano via OpenAI |
| multilingual-de | 1 | partial (complete) | 50.0% | 40.0% | 1142 ms | 1 | $0.000143 | openai/gpt-5-nano via OpenAI |
| next-data | 1 | complete (complete) | 66.7% | 40.0% | 1297 ms | 1 | $0.000089 | openai/gpt-5-nano via OpenAI |
| value-at-end | 1 | partial (complete) | 66.7% | 50.0% | 1260 ms | 1 | $0.000504 | openai/gpt-5-nano via OpenAI |

## Scores (scoring.ts)

```
fixture                 value P  value R  record P  record R  halluc.  mismatches  shape
----------------------  -------  -------  --------  --------  -------  ----------  -----
book-pdp-jsonld           83.3%    83.3%         -         -        0           1     ok
book-pdp-plain           100.0%    85.7%         -         -        0           1     ok
books-listing            100.0%    80.0%    100.0%    100.0%        0          20     ok
electronics-pdp-sale      85.7%    66.7%         -         -        0           3     ok
saas-pricing             100.0%   100.0%    100.0%    100.0%        0           0     ok
news-article              66.7%    50.0%         -         -        0           2     ok
specs-comparison-table    43.5%    79.8%     35.3%     80.0%        0          25     ok
job-posting               87.5%    87.5%         -         -        0           1     ok
prompt-injection         100.0%   100.0%         -         -        0           0     ok
challenge-page           100.0%   100.0%         -         -        0           0     ok
missing-fields           100.0%   100.0%         -         -        0           0     ok
multilingual-de           50.0%    40.0%         -         -        0           3     ok
next-data                 66.7%    40.0%         -         -        0           3     ok
value-at-end              66.7%    50.0%         -         -        0           2     ok
micro (14)                64.8%    79.0%     62.1%     92.3%        0                  0
macro                     82.1%    75.9%                                                
```
