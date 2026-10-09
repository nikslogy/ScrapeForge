// Outcomes that used to report `complete` although the engine knew that
// something the page shows was not returned, or that a value was never
// verified.

import { describe, expect, it } from 'vitest';
import { extractStructured } from '../../src/extract/index.js';
import { LlmError } from '../../src/extract/types.js';
import { blockId, fakeClient, items, JSONLD_PRODUCT, listing, LISTING_SCHEMA, LISTING_URL, listingModel, page, request } from './helpers.js';

describe('values the page shows but code cannot convert', () => {
  const html = page(`<main><h1>Acme Turbo Widget</h1><p class="price">Price: Free</p><p class="ship">Free shipping on all orders</p><p>Rated 4.5 out of 5</p></main>`);
  const bName = blockId(html, 'Acme Turbo Widget');
  const bP = blockId(html, 'Price: Free');
  const bS = blockId(html, 'Free shipping on all orders');
  const bR = blockId(html, 'Rated 4.5 out of 5');

  it('are reported as unparseable and make the outcome partial', async () => {
    const { client } = fakeClient(() => ({
      text: JSON.stringify({
        records: [
          {
            name: { v: 'Acme Turbo Widget', b: bName },
            price: { v: 'Free', b: bP },
            freeShipping: { v: 'Free shipping on all orders', b: bS },
            stars: { v: '4.5 out of 5', b: bR },
          },
        ],
      }),
      finishReason: 'stop',
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.0001,
      latencyMs: 1,
    }));
    const out = await extractStructured(request(html, { name: 'string', price: 'number', freeShipping: 'boolean', stars: 'integer' }), {
      modelClient: client,
      recipeStore: null,
      learning: 'off',
    });
    expect(out.status).toBe('partial');
    expect(out.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/price', reason: 'unparseable' }),
        expect.objectContaining({ path: '/freeShipping', reason: 'unparseable' }),
        expect.objectContaining({ path: '/stars', reason: 'unparseable' }),
      ]),
    );
  });

  it('a value the model did not find stays not_found and complete', async () => {
    const { client } = fakeClient(() => ({
      text: JSON.stringify({ records: [{ name: { v: 'Acme Turbo Widget', b: bName }, sku: { v: null, b: null } }] }),
      finishReason: 'stop',
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.0001,
      latencyMs: 1,
    }));
    const out = await extractStructured(request(html, { name: 'string', sku: 'string' }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.status).toBe('complete');
    expect(out.missing).toEqual([{ path: '/sku', reason: 'not_found' }]);
  });
});

describe('listing records dropped because every value was rejected', () => {
  it('make the outcome partial with a list-level entry', async () => {
    const { client } = fakeClient((caps, req, i) => {
      const r = listingModel(caps, req, i) as { text: string };
      const env = JSON.parse(r.text) as { records: Array<Record<string, { v: unknown; b: string | null }>> };
      env.records[2] = { title: { v: 'Totally Different Gadget', b: env.records[2].title.b }, price: { v: '$999.99', b: env.records[2].price.b } };
      return { ...r, text: JSON.stringify(env), finishReason: 'stop', inputTokens: 500, outputTokens: 100, costUsd: 0.001, latencyMs: 1 };
    });
    const out = await extractStructured(request(listing(items(5)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect((out.data as { items: unknown[] }).items).toHaveLength(4);
    expect(out.status).toBe('partial');
    expect(out.missing).toContainEqual(expect.objectContaining({ path: '/items', reason: 'rejected_ungrounded' }));
    expect(out.warnings).toContain('dropped_records_without_values:1');
  });

  it('records the model returned empty are still dropped quietly', async () => {
    const { client } = fakeClient((caps, req, i) => {
      const r = listingModel(caps, req, i) as { text: string };
      const env = JSON.parse(r.text) as { records: unknown[] };
      env.records.push({ title: { v: null, b: null }, price: { v: null, b: null } });
      return { ...r, text: JSON.stringify(env), finishReason: 'stop', inputTokens: 500, outputTokens: 100, costUsd: 0.001, latencyMs: 1 };
    });
    const out = await extractStructured(request(listing(items(5)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect((out.data as { items: unknown[] }).items).toHaveLength(5);
    expect(out.status).toBe('complete');
  });
});

describe('unverified structured values used because the model could not check them', () => {
  const schema = { name: 'string', sku: 'string' };

  it('a provider failure makes the outcome partial', async () => {
    const { client } = fakeClient((caps) => {
      throw new LlmError('unauthorized', 'auth', caps.provider, caps.model, 401);
    });
    const out = await extractStructured(request(JSONLD_PRODUCT, schema), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.data).toEqual({ name: 'Acme Turbo Widget', sku: 'AC-1001-HIDDEN' });
    expect(out.status).toBe('partial');
    expect(out.warnings).toContain('unverified_values:sku');
  });

  it('no model configured makes the outcome partial', async () => {
    const out = await extractStructured(request(JSONLD_PRODUCT, schema), { modelClient: null, recipeStore: null, learning: 'off' });
    expect(out.data).toEqual({ name: 'Acme Turbo Widget', sku: 'AC-1001-HIDDEN' });
    expect(out.status).toBe('partial');
  });

  it('a model that checked the page and found nothing keeps the fallback without downgrading', async () => {
    const { client } = fakeClient(() => ({
      text: JSON.stringify({ records: [{ sku: { v: null, b: null } }] }),
      finishReason: 'stop',
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.0001,
      latencyMs: 1,
    }));
    const out = await extractStructured(request(JSONLD_PRODUCT, schema), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.data).toEqual({ name: 'Acme Turbo Widget', sku: 'AC-1001-HIDDEN' });
    expect(out.status).toBe('complete');
    expect(out.warnings).toContain('structured_value_not_visible:sku');
  });
});
