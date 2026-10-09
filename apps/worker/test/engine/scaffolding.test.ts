// Site-wide Organization / WebSite / CollectionPage JSON-LD must not decide
// the record: not the product name on a product page, and not "one object"
// on a listing page.

import { describe, expect, it } from 'vitest';
import { extractStructured } from '../../src/extract/index.js';
import { blockId, fakeClient, items, listing, LISTING_URL, listingModel, page, request } from './helpers.js';

const orgLd = `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Example Shop', url: 'https://shop.example.com/', logo: 'https://shop.example.com/logo.png' })}</script>`;

describe('scaffolding JSON-LD', () => {
  const html = page(
    `<header><a href="/">Example Shop</a></header><main><h1>Acme Turbo Widget</h1><p class="price">$1,299.00</p><p class="stock">In stock</p></main><footer><p>© 2026 Example Shop</p></footer>`,
    `<title>Acme Turbo Widget | Example Shop</title>${orgLd}`,
  );
  const bName = blockId(html, 'Acme Turbo Widget');
  const bPrice = blockId(html, '$1,299.00');
  const productModel = fakeClient((_caps, req) => {
    const rec: Record<string, { v: string | null; b: string | null }> = {};
    if (req.system.includes('"name"')) rec.name = { v: 'Acme Turbo Widget', b: bName };
    if (req.system.includes('"title"')) rec.title = { v: 'Acme Turbo Widget', b: bName };
    if (req.system.includes('"price"')) rec.price = { v: '$1,299.00', b: bPrice };
    if (req.system.includes('"brand"')) rec.brand = { v: null, b: null };
    return { text: JSON.stringify({ records: [rec] }), finishReason: 'stop', inputTokens: 10, outputTokens: 10, costUsd: 0.0001, latencyMs: 1 };
  });

  const schemas: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['shorthand', { name: 'string — product name', price: 'number — price' }, { name: 'Acme Turbo Widget', price: 1299 }],
    ['type:object', { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number' } } }, { name: 'Acme Turbo Widget', price: 1299 }],
    [
      'title/brand',
      { type: 'object', properties: { title: { type: 'string', description: 'product title' }, price: { type: 'number' }, brand: { type: 'string' } } },
      { title: 'Acme Turbo Widget', price: 1299 },
    ],
  ];
  for (const [label, schema, expected] of schemas) {
    it(`product page with only an Organization: the product name is not the shop name (${label})`, async () => {
      const out = await extractStructured(request(html, schema), { modelClient: productModel.client, recipeStore: null, learning: 'off' });
      expect(out.data).toMatchObject(expected);
      expect(out.method).toBe('llm');
    });
  }

  const variants: Record<string, string> = {
    org: `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Gadget Store', url: 'https://gadgets.example.com/' })}</script>`,
    website: `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Gadget Store', url: 'https://gadgets.example.com/' })}</script>`,
    collection: `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'All gadgets', description: 'All gadgets' })}</script>`,
  };
  for (const [label, inject] of Object.entries(variants)) {
    it(`an auto listing with ${label} JSON-LD stays a listing`, async () => {
      const listingHtml = listing(items(8)).replace('</head>', `${inject}</head>`);
      const { client, provider } = fakeClient(listingModel);
      const out = await extractStructured(request(listingHtml, { title: 'string — product name', price: 'number — price' }, { url: LISTING_URL }), {
        modelClient: client,
        recipeStore: null,
        learning: 'off',
      });
      expect(Array.isArray(out.data)).toBe(true);
      expect(out.data).toHaveLength(8);
      expect(out.status).toBe('complete');
      expect(out.method).toBe('llm');
      expect(provider.calls[0].req.system).not.toMatch(/Return exactly one record/);
    });
  }
});
