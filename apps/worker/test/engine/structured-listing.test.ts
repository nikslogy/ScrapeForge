// A structured listing (JSON-LD ItemList) answers a listing request on its
// own only when it covers the records the page shows; a featured-items or
// capped ItemList must not be returned as the whole listing.

import { describe, expect, it } from 'vitest';
import { extractStructured } from '../../src/extract/index.js';
import { fakeClient, items, listing, LISTING_SCHEMA, LISTING_URL, listingModel, NEVER, page, request } from './helpers.js';

function withItemList(html: string, list: ReturnType<typeof items>): string {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: list.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: { '@type': 'Product', name: it.title, url: `https://gadgets.example.com/p/${i}`, offers: { '@type': 'Offer', price: it.price.slice(1), priceCurrency: 'USD' } },
    })),
  };
  return html.replace('</head>', `<script type="application/ld+json">${JSON.stringify(ld)}</script></head>`);
}

const len = (data: unknown): number | undefined =>
  Array.isArray(data) ? data.length : (data as { items?: unknown[] } | null)?.items?.length;

describe('structured listings that cover only part of the page', () => {
  const all = items(20);
  const html = withItemList(listing(all), all.slice(0, 5));

  for (const [label, schema] of [
    ['wrapper array', LISTING_SCHEMA],
    ['shorthand auto', { title: 'string — product name', price: 'number — price' }],
  ] as const) {
    it(`an ItemList of 5 on a 20-card page is not the whole listing (${label})`, async () => {
      const { client, provider } = fakeClient(listingModel);
      const out = await extractStructured(request(html, schema, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
      expect(out.scope.recordsDetected).toBe(20);
      expect(provider.calls.length).toBe(1);
      expect(len(out.data)).toBe(20);
      expect(out.status).toBe('complete');
      expect(out.warnings).toContain('structured_list_incomplete:5_of_20');
    });
  }

  it('without a model the 5 structured records are not reported as complete', async () => {
    const out = await extractStructured(request(html, LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: null, recipeStore: null, learning: 'off' });
    expect(out.status).not.toBe('complete');
  });

  it('an ItemList covering every card is still used alone (no model call)', async () => {
    const { client } = fakeClient(NEVER);
    const out = await extractStructured(request(withItemList(listing(all), all), LISTING_SCHEMA, { url: LISTING_URL }), {
      modelClient: client,
      recipeStore: null,
      learning: 'off',
    });
    expect(len(out.data)).toBe(20);
    expect(out.status).toBe('complete');
    expect(out.method).toBe('structured-data');
  });

  it('one extra card (a promo slot) in a 20-card grid is tolerated', async () => {
    const { client } = fakeClient(NEVER);
    const out = await extractStructured(request(withItemList(listing(all), all.slice(0, 19)), LISTING_SCHEMA, { url: LISTING_URL }), {
      modelClient: client,
      recipeStore: null,
      learning: 'off',
    });
    expect(len(out.data)).toBe(19);
    expect(out.method).toBe('structured-data');
  });
});

describe('a structured listing cut by the mapper cap', () => {
  it('is returned but reported as truncated and partial', async () => {
    // One block per item, so the whole list fits the document's block budget.
    const all = items(5_005);
    const compact = page(`<main><h1>All gadgets</h1><ul>${all.map((it) => `<li>${it.title} ${it.price}</li>`).join('')}</ul></main>`);
    const { client } = fakeClient(NEVER);
    const out = await extractStructured(request(withItemList(compact, all), LISTING_SCHEMA, { url: LISTING_URL }), {
      modelClient: client,
      recipeStore: null,
      learning: 'off',
    });
    expect(out.warnings).toContain('structured_records_capped:5000');
    expect(len(out.data)).toBe(5_000);
    expect(out.status).toBe('partial');
    expect(out.scope.truncated).toBe(true);
    expect(out.missing[0]).toMatchObject({ path: '/items', reason: 'not_processed' });
  }, 60_000);
});
