// An explicit {type: 'object'} schema returns one object (an array would
// violate the customer's own schema), but on a page that clearly lists
// several matching records the outcome says so.

import { describe, expect, it } from 'vitest';
import { extractStructured } from '../../src/extract/index.js';
import type { FakeHandler } from '../../src/extract/llm/index.js';
import { fakeClient, items, listing, LISTING_URL, listingModel, NEVER, PLAIN_PRODUCT, blockId, request } from './helpers.js';

const OBJECT_SCHEMA = { type: 'object', properties: { title: { type: 'string' }, price: { type: 'number' } } };

describe('object schema on a listing page', () => {
  it('keeps one object and warns when the model returns several records', async () => {
    const { client } = fakeClient(listingModel);
    const out = await extractStructured(request(listing(items(8)), OBJECT_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.data).toEqual({ title: 'Gadget Model A0', price: 19 });
    expect(out.status).toBe('complete');
    expect(out.warnings).toContain('multiple_records_for_object_schema:8');
  });

  it('warns too when the model obeys "one record" but read it from one of 8 repeated cards', async () => {
    const firstOnly: FakeHandler = (caps, req, i) => {
      const r = listingModel(caps, req, i) as { text: string };
      const env = JSON.parse(r.text) as { records: unknown[] };
      return { ...r, text: JSON.stringify({ records: env.records.slice(0, 1) }), finishReason: 'stop', inputTokens: 500, outputTokens: 100, costUsd: 0.001, latencyMs: 1 };
    };
    const { client } = fakeClient(firstOnly);
    const out = await extractStructured(request(listing(items(8)), OBJECT_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.data).toEqual({ title: 'Gadget Model A0', price: 19 });
    expect(out.warnings).toContain('multiple_records_for_object_schema:8');
  });

  it('warns when structured data alone answers from a list of products', async () => {
    const list = items(8);
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: list.map((it, i) => ({ '@type': 'ListItem', position: i + 1, item: { '@type': 'Product', name: it.title, offers: { '@type': 'Offer', price: it.price.slice(1) } } })),
    };
    const html = listing(list).replace('</head>', `<script type="application/ld+json">${JSON.stringify(ld)}</script></head>`);
    const { client } = fakeClient(NEVER);
    const out = await extractStructured(request(html, { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number' } } }, { url: LISTING_URL }), {
      modelClient: client,
      recipeStore: null,
      learning: 'off',
    });
    expect(out.data).toEqual({ name: 'Gadget Model A0', price: 19 });
    expect(out.method).toBe('structured-data');
    expect(out.warnings).toContain('multiple_records_for_object_schema:8');
  });

  it('a product page answered as an object gets no such warning', async () => {
    const titleId = blockId(PLAIN_PRODUCT, 'Acme Turbo Widget');
    const priceId = blockId(PLAIN_PRODUCT, '$1,299.00');
    const { client } = fakeClient(() => ({
      text: JSON.stringify({ records: [{ title: { v: 'Acme Turbo Widget', b: titleId }, price: { v: '$1,299.00', b: priceId } }] }),
      finishReason: 'stop',
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.0001,
      latencyMs: 1,
    }));
    const out = await extractStructured(request(PLAIN_PRODUCT, OBJECT_SCHEMA), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.status).toBe('complete');
    expect(out.warnings.some((w) => w.startsWith('multiple_records_for_object_schema'))).toBe(false);
  });
});
