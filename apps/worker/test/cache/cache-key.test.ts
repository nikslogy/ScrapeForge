import { describe, expect, it } from 'vitest';
import { isCacheableResult, resultCacheKey, type ScrapeOptions } from '@scrapeforge/shared';

const URL_ = 'https://shop.example.com/p/1';
const base: ScrapeOptions = { formats: ['markdown'], proxy: 'auto', cacheTtl: 3600, screenshot: false, mobile: false, blockResources: true };

describe('resultCacheKey', () => {
  it('is a cache:<16 hex> key that depends on the tenant', () => {
    const a = resultCacheKey('u1', URL_, base);
    expect(a).toMatch(/^cache:[0-9a-f]{16}$/);
    expect(resultCacheKey('u1', URL_, { ...base })).toBe(a);
    expect(resultCacheKey('u2', URL_, base)).not.toBe(a);
  });

  it('depends on headers and cookies, not on their order or header-name case', () => {
    const plain = resultCacheKey('u1', URL_, base);
    const withAuth = resultCacheKey('u1', URL_, { ...base, headers: { Authorization: 'Bearer a', 'X-Y': '1' } });
    expect(withAuth).not.toBe(plain);
    expect(resultCacheKey('u1', URL_, { ...base, headers: { 'x-y': '1', authorization: 'Bearer a' } })).toBe(withAuth);
    expect(resultCacheKey('u1', URL_, { ...base, headers: { Authorization: 'Bearer b', 'X-Y': '1' } })).not.toBe(withAuth);
    // Empty header/cookie lists are the same as none.
    expect(resultCacheKey('u1', URL_, { ...base, headers: {}, cookies: [] })).toBe(plain);

    const c1 = resultCacheKey('u1', URL_, { ...base, cookies: [{ name: 'a', value: '1' }, { name: 'b', value: '2' }] });
    expect(resultCacheKey('u1', URL_, { ...base, cookies: [{ name: 'b', value: '2' }, { name: 'a', value: '1' }] })).toBe(c1);
    expect(resultCacheKey('u1', URL_, { ...base, cookies: [{ name: 'a', value: '1' }, { name: 'b', value: '3' }] })).not.toBe(c1);
    expect(resultCacheKey('u1', URL_, { ...base, cookies: [{ name: 'a', value: '1', domain: 'x.com' }, { name: 'b', value: '2' }] })).not.toBe(c1);
  });

  it('includes the spend cap only for extraction requests', () => {
    expect(resultCacheKey('u1', URL_, { ...base, maxLlmCostUsd: 0.01 })).toBe(resultCacheKey('u1', URL_, base));
    const schema = { extractSchema: { title: 'string' } };
    const k = resultCacheKey('u1', URL_, { ...base, ...schema, maxLlmCostUsd: 0.01 });
    expect(resultCacheKey('u1', URL_, { ...base, ...schema, maxLlmCostUsd: 0.02 })).not.toBe(k);
    expect(resultCacheKey('u1', URL_, { ...base, ...schema })).not.toBe(k);
    expect(resultCacheKey('u1', URL_, { ...base, ...schema, includeEvidence: true, maxLlmCostUsd: 0.01 })).not.toBe(k);
  });

  it('depends on the fetch options that change the result', () => {
    const k = resultCacheKey('u1', URL_, base);
    for (const change of [{ screenshot: true }, { mobile: true }, { waitFor: '#app' }, { blockResources: false }, { proxy: 'none' as const }, { formats: ['html' as const] }]) {
      expect(resultCacheKey('u1', URL_, { ...base, ...change })).not.toBe(k);
    }
    // Neither the TTL, the timeout nor the webhook changes what is fetched.
    expect(resultCacheKey('u1', URL_, { ...base, cacheTtl: 60, timeout: 5_000, webhookUrl: 'https://h.example/' })).toBe(k);
  });
});

describe('isCacheableResult', () => {
  it('caches plain scrapes and complete extractions only', () => {
    expect(isCacheableResult(base, undefined)).toBe(true);
    expect(isCacheableResult({ ...base, extractSchema: {} }, undefined)).toBe(true);
    const ex = { ...base, extractSchema: { title: 'string' } };
    expect(isCacheableResult(ex, 'complete')).toBe(true);
    for (const status of ['partial', 'failed', undefined]) expect(isCacheableResult(ex, status)).toBe(false);
  });

  it('never caches without a positive TTL', () => {
    expect(isCacheableResult({ ...base, cacheTtl: 0 }, undefined)).toBe(false);
    expect(isCacheableResult({ ...base, cacheTtl: undefined }, undefined)).toBe(false);
  });
});
