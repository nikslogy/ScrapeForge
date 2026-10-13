// Listings larger than one model call. Phase 2: the record group is split
// into chunks sized to the output and input limits, answered by concurrent
// calls and merged in page order. With partitioning off (Phase 1), the
// input is sized to the records one answer can hold: a truncated partial,
// never a failed extraction after two oversized, billed calls.

import { describe, expect, it } from 'vitest';
import { extractStructured } from '../../src/extract/index.js';
import { estimateTokens, type FakeHandler } from '../../src/extract/llm/index.js';
import { loadFixture } from '../../../../tests/fixtures/extraction/load.js';
import { oracleHandler } from '../../../../tests/engine/oracle.js';
import { scoreExtraction } from '../../../../tests/engine/scoring.js';
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

describe('listings that do not fit one call: partitioned (Phase 2)', () => {
  for (const n of [300, 400, 800]) {
    it(`${n} cards on an 8k-output model: every record, complete, several calls`, async () => {
      const { client, provider } = fakeClient(honoursOutputLimit(listingModel), { maxOutputTokens: 8_192, contextTokens: 128_000 });
      const out = await extractStructured(request(listing(items(n)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
      expect(out.status).toBe('complete');
      expect(out.scope.truncated).toBe(false);
      expect(len(out.data, 'items')).toBe(n);
      expect(out.data).toEqual({ items: items(n).map((it) => ({ title: it.title, price: Number(it.price.slice(1)) })) });
      expect(out.scope.strategy).toBe('partitioned');
      expect(provider.calls.length).toBeGreaterThan(1);
      expect(provider.calls.length).toBe(out.scope.partitions?.chunks);
    });
  }

  it('the large-listing fixture on an 8k-output model: all 600 records, complete, the "Recently viewed" decoys left out', async () => {
    const fixture = loadFixture('large-listing');
    const { client, provider } = fakeClient(honoursOutputLimit(oracleHandler(fixture)), { maxOutputTokens: 8_192, contextTokens: 128_000 });
    const out = await extractStructured(
      { html: fixture.html, url: fixture.url, schema: fixture.schema, tenantId: 't', deadlineMs: Date.now() + 60_000 },
      { modelClient: client, recipeStore: null, learning: 'off' },
    );
    const score = scoreExtraction(fixture, out.data);
    expect(score.valuePrecision).toBe(1);
    expect(score.valueRecall).toBe(1);
    expect(len(out.data, 'products')).toBe(600);
    expect(out.status).toBe('complete');
    expect(out.scope.partitions).toMatchObject({ failed: 0, skipped: 0 });
    expect(provider.calls.length).toBeLessThanOrEqual(64);
  });

  it('a chunk whose answer is cut off (pretty-printed JSON) is halved and retried', async () => {
    const verbose: FakeHandler = (caps, req, i) => {
      const r = listingModel(caps, req, i) as Exclude<ReturnType<FakeHandler>, Promise<unknown>>;
      return { ...r, text: JSON.stringify(JSON.parse(r.text), null, 2) };
    };
    const { client } = fakeClient(honoursOutputLimit(verbose), { maxOutputTokens: 8_192, contextTokens: 128_000 });
    const out = await extractStructured(request(listing(items(400)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.warnings).toContain('partition_chunk_split:output_truncated');
    expect(len(out.data, 'items')).toBe(400);
    expect(out.status).toBe('complete');
  });

  it('chunks that fail are reported by record range; the rest is returned', async () => {
    const poisoned = items(400)[150].title;
    const flaky: FakeHandler = (caps, req, i) => {
      // Every call for the chunk holding record 151 fails, retries included.
      if (req.user.includes(poisoned)) throw Object.assign(new Error('upstream 500'), { status: 500 });
      return listingModel(caps, req, i);
    };
    const { client } = fakeClient(honoursOutputLimit(flaky), { maxOutputTokens: 8_192, contextTokens: 128_000 });
    const out = await extractStructured(request(listing(items(400)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.status).toBe('partial');
    expect(out.scope.truncated).toBe(true);
    expect(out.scope.partitions?.failed).toBe(1);
    const gap = out.missing.find((m) => m.path === '/items');
    expect(gap?.detail).toMatch(/of 400 records were not processed: records \d+–\d+ \(/);
    const titles = (out.data as { items: Array<{ title: string }> }).items.map((r) => r.title);
    expect(titles).not.toContain(poisoned);
    expect(titles.length).toBe(400 - out.scope.partitions!.recordsPerChunk);
    // Page order is kept around the gap.
    expect(titles).toEqual(items(400).map((it) => it.title).filter((t) => titles.includes(t)));
  });

  it('the cost cap stops further chunks; what was answered is returned and the rest reported', async () => {
    const { client, provider } = fakeClient(honoursOutputLimit(listingModel), {
      maxOutputTokens: 8_192, contextTokens: 128_000, inputCostPerMTok: 1_000, outputCostPerMTok: 1_000,
    });
    const out = await extractStructured(
      request(listing(items(800)), LISTING_SCHEMA, { url: LISTING_URL, maxCostUsd: 30 }),
      { modelClient: client, recipeStore: null, learning: 'off' },
    );
    expect(out.status).toBe('partial');
    expect(out.scope.partitions!.skipped + out.scope.partitions!.failed).toBeGreaterThan(0);
    expect(out.llm.costUsd).toBeLessThanOrEqual(30);
    expect(len(out.data, 'items')).toBeGreaterThan(0);
    expect(provider.calls.length).toBeLessThan(out.scope.partitions!.chunks);
  });

  it('a listing that fits is still sent whole and complete', async () => {
    const { client, provider } = fakeClient(honoursOutputLimit(listingModel), { maxOutputTokens: 8_192, contextTokens: 128_000 });
    const out = await extractStructured(request(listing(items(60)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.status).toBe('complete');
    expect(len(out.data, 'items')).toBe(60);
    expect(provider.calls).toHaveLength(1);
    expect(out.scope.strategy).toBe('single');
  });
});

describe('with partitioning off (Phase 1 behaviour)', () => {
  it('400 cards on an 8k-output model: partial with the records that fit, one call', async () => {
    const { client, provider } = fakeClient(honoursOutputLimit(listingModel), { maxOutputTokens: 8_192, contextTokens: 128_000 });
    const out = await extractStructured(request(listing(items(400)), LISTING_SCHEMA, { url: LISTING_URL, disable: ['partition'] }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.status).toBe('partial');
    expect(out.scope.truncated).toBe(true);
    expect(len(out.data, 'items')).toBeGreaterThan(50);
    expect(out.missing[0]).toMatchObject({ path: '/items', reason: 'not_processed' });
    expect(provider.calls).toHaveLength(1);
  });
});

describe('chunks are sized for latency', () => {
  it('a model with a huge output limit still gets chunks of about 8k output tokens, answered side by side', async () => {
    const { client, provider } = fakeClient(honoursOutputLimit(listingModel), { maxOutputTokens: 65_536, contextTokens: 1_000_000 });
    const out = await extractStructured(request(listing(items(800)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.status).toBe('complete');
    expect(len(out.data, 'items')).toBe(800);
    expect(provider.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of provider.calls) expect(call.req.maxOutputTokens).toBeLessThanOrEqual(2 * 8_192);
  });

  it('a chunk that times out is halved and retried', async () => {
    const { client } = fakeClient((caps, req, i) => {
      const cards = (req.user.match(/<record /g) ?? []).length;
      if (cards > 40) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      return listingModel(caps, req, i);
    }, { maxOutputTokens: 65_536, contextTokens: 1_000_000 });
    const out = await extractStructured(request(listing(items(300)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.warnings).toContain('partition_chunk_split:timeout');
    expect(len(out.data, 'items')).toBe(300);
    expect(out.status).toBe('complete');
  });
});

describe('merging chunk answers', () => {
  it('drops an answer repeated for the same card, keeps everything else', async () => {
    const repeating: FakeHandler = (caps, req, i) => {
      const r = listingModel(caps, req, i) as Exclude<ReturnType<FakeHandler>, Promise<unknown>>;
      const body = JSON.parse(r.text) as { records: unknown[] };
      body.records.push(body.records[0]);
      return { ...r, text: JSON.stringify(body) };
    };
    const { client, provider } = fakeClient(honoursOutputLimit(repeating), { maxOutputTokens: 8_192, contextTokens: 128_000 });
    const out = await extractStructured(request(listing(items(300)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(len(out.data, 'items')).toBe(300);
    expect(out.warnings).toContain(`partition_duplicates_dropped:${provider.calls.length}`);
  });
});
