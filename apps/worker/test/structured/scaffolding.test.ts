// Site scaffolding (Organization, WebSite, WebPage/CollectionPage, Breadcrumbs)
// must never become the record of an object/auto schema it does not fit: a
// product page whose only JSON-LD is the shop's Organization would otherwise
// return the shop name as the product name.

import { describe, expect, it } from 'vitest';
import { extractFromStructuredData } from '../../src/extract/structured/index.js';
import { ld, makeDoc, makeSchema, og, raws } from './helpers.js';

const ORG = ld({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Example Shop', url: 'https://shop.example.com/' });
const SITE = ld({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Example Shop', url: 'https://shop.example.com/' });
const COLLECTION = ld({ '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'All gadgets', description: 'All gadgets' });
const CRUMBS = ld({ '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Example Shop' }] });

const productText = 'Example Shop\n\nAcme Turbo Widget\n\n$1,299.00\n\nIn stock\n\n© 2026 Example Shop';
const listingText = 'Gadget Store\n\nAll gadgets\n\nGadget Model A0\n\n$19.00\n\nGadget Model B1\n\n$22.00\n\nGadget Model C2\n\n$25.00';

describe('scaffolding JSON-LD is not the record', () => {
  for (const [label, item] of [['Organization', ORG], ['WebSite', SITE], ['CollectionPage', COLLECTION], ['BreadcrumbList', CRUMBS]] as const) {
    it(`object: a product-shaped schema does not read the name from ${label}`, () => {
      const res = extractFromStructuredData(
        makeDoc({ text: productText, items: [item] }),
        makeSchema([{ name: 'name', description: 'product name' }, { name: 'price', type: 'number' }], 'object'),
      );
      expect(res.records.map(raws)).toEqual([]);
      expect(res.shape).toBeNull();
    });

    it(`auto: a listing with ${label} JSON-LD is not decided as one object`, () => {
      const res = extractFromStructuredData(
        makeDoc({ text: listingText, items: [item] }),
        makeSchema([{ name: 'title', description: 'product name' }, { name: 'price', type: 'number' }], 'auto'),
      );
      expect(res.shape).toBeNull();
      expect(res.records).toEqual([]);
    });
  }

  it('object: generic fields do not read the shop name from Organization either', () => {
    const res = extractFromStructuredData(makeDoc({ text: productText, items: [ORG, SITE] }), makeSchema(['name'], 'object'));
    expect(res.records).toEqual([]);
  });

  it('object: a title/price/brand schema ignores the Organization', () => {
    const res = extractFromStructuredData(
      makeDoc({ text: productText, items: [ORG] }),
      makeSchema([{ name: 'title', description: 'product title' }, { name: 'price', type: 'number' }, 'brand'], 'object'),
    );
    expect(res.records).toEqual([]);
  });

  it('the product still wins when it is present next to scaffolding', () => {
    const res = extractFromStructuredData(
      makeDoc({ text: productText, items: [ORG, SITE, ld({ '@type': 'Product', name: 'Acme Turbo Widget', offers: { price: '1299.00' } })] }),
      makeSchema(['name', { name: 'price', type: 'number' }], 'object'),
    );
    expect(raws(res.records[0])).toEqual({ name: 'Acme Turbo Widget', price: '1299.00' });
  });

  it('an Organization is still the record of an organization-shaped schema', () => {
    const res = extractFromStructuredData(
      makeDoc({
        text: 'Globex Corporation\n\n+1 555 0100\n\n12 Main St, Springfield',
        items: [ld({ '@type': 'Organization', name: 'Globex Corporation', telephone: '+1 555 0100' })],
      }),
      makeSchema(['name', 'telephone'], 'object'),
    );
    expect(raws(res.records[0])).toEqual({ name: 'Globex Corporation', telephone: '+1 555 0100' });
  });

  it('generic page fields may still be read from a WebPage, like from OpenGraph', () => {
    const res = extractFromStructuredData(
      makeDoc({ text: 'My Post\n\nA short post.', items: [ld({ '@type': 'WebPage', name: 'My Post', description: 'A short post.' })] }),
      makeSchema(['title', 'description'], 'auto'),
    );
    expect(res.shape).toBe('object');
    expect(raws(res.records[0])).toEqual({ title: 'My Post', description: 'A short post.' });
  });

  it('reports what kind of entity the record came from', () => {
    const product = extractFromStructuredData(
      makeDoc({ text: productText, items: [ORG, ld({ '@type': 'Product', name: 'Acme Turbo Widget', offers: { price: '1299.00' } })] }),
      makeSchema(['name', { name: 'price', type: 'number' }], 'auto'),
    );
    expect(product.primary).toMatchObject({ family: 'product', content: true });
    const page = extractFromStructuredData(
      makeDoc({ text: 'My Post', items: [og({ 'og:type': 'website', 'og:title': 'My Post' })] }),
      makeSchema(['title'], 'auto'),
    );
    expect(page.primary).toMatchObject({ content: false });
  });
});
