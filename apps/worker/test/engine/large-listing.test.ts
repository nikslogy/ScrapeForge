// Listings larger than the model's output limit: the input is sized to the
// records the output can hold, so the outcome is a truncated partial, never
// a failed extraction after two oversized, billed calls.

import { describe, expect, it } from 'vitest';
import { extractStructured } from '../../src/extract/index.js';
import { estimateTokens, type FakeHandler } from '../../src/extract/llm/index.js';
import { loadFixture } from '../../../../tests/fixtures/extraction/load.js';
import { oracleHandler } from '../../../../tests/engine/oracle.js';
import { fakeClient, items, listing, LISTING_SCHEMA, LISTING_URL, listingModel, request } from './helpers.js';

/** Wraps a handler so that output beyond maxOutputTokens is cut (finishReason 'length'), as real providers do. */
function honoursOutputLimit(handler: FakeHandler): FakeHandler {
  return (caps, req, i) => {
    const r = handler(caps, req, i) as Exclude<ReturnType<FakeHandler>, Promise<unknown>>;
    const limit = Math.min(caps.maxOutputTokens, req.maxOutputTokens);
    const tokens = estimateTokens(r.text);
    if (tokens > limit) return { ...r, text: r.text.slice(0, Math.floor((r.text.length * limit) / tokens)), finishReason: 'length', outputTokens: limit };
    return { ...r, outputTokens: tokens };
  };
}

const len = (data: unknown, key: string): number => ((data as Record<string, unknown[]> | null)?.[key] ?? []).length;

describe('listings that do not fit the output limit', () => {
  for (const n of [300, 400, 800]) {
    it(`${n} cards on an 8k-output model: partial with the records that fit, one call`, async () => {
      const { client, provider } = fakeClient(honoursOutputLimit(listingModel), { maxOutputTokens: 8_192, contextTokens: 128_000 });
      const out = await extractStructured(request(listing(items(n)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
      expect(out.status).toBe('partial');
      expect(out.scope.truncated).toBe(true);
      expect(len(out.data, 'items')).toBeGreaterThan(50);
      expect(out.missing[0]).toMatchObject({ path: '/items', reason: 'not_processed' });
      expect(provider.calls).toHaveLength(1);
    });
  }

  it('the large-listing fixture on an 8k-output model is partial, not failed', async () => {
    const fixture = loadFixture('large-listing');
    const { client, provider } = fakeClient(honoursOutputLimit(oracleHandler(fixture)), { maxOutputTokens: 8_192, contextTokens: 128_000 });
    const out = await extractStructured(
      { html: fixture.html, url: fixture.url, schema: fixture.schema, tenantId: 't', deadlineMs: Date.now() + 60_000 },
      { modelClient: client, recipeStore: null, learning: 'off' },
    );
    expect(out.status).toBe('partial');
    expect(len(out.data, 'products')).toBeGreaterThan(50);
    expect(out.missing[0]).toMatchObject({ path: '/products', reason: 'not_processed' });
    expect(provider.calls).toHaveLength(1);
  });

  it('when the sized call still overflows (pretty-printed JSON), the retry cuts records and stays partial', async () => {
    const verbose: FakeHandler = (caps, req, i) => {
      const r = listingModel(caps, req, i) as Exclude<ReturnType<FakeHandler>, Promise<unknown>>;
      return { ...r, text: JSON.stringify(JSON.parse(r.text), null, 2) };
    };
    const { client, provider } = fakeClient(honoursOutputLimit(verbose), { maxOutputTokens: 8_192, contextTokens: 128_000 });
    const out = await extractStructured(request(listing(items(400)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(provider.calls).toHaveLength(2);
    expect(out.warnings).toContain('llm_retry_smaller_input:output_truncated');
    expect(out.status).toBe('partial');
    expect(len(out.data, 'items')).toBeGreaterThan(50);
  });

  it('a listing that fits is still sent whole and complete', async () => {
    const { client, provider } = fakeClient(honoursOutputLimit(listingModel), { maxOutputTokens: 8_192, contextTokens: 128_000 });
    const out = await extractStructured(request(listing(items(60)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.status).toBe('complete');
    expect(len(out.data, 'items')).toBe(60);
    expect(provider.calls).toHaveLength(1);
  });
});
