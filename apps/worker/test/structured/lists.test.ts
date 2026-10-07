import { describe, expect, it } from 'vitest';
import { extractFromStructuredData } from '../../src/extract/structured/index.js';
import type { RequestedShape } from '../../src/extract/types.js';
import { embedded, ld, makeDoc, makeSchema, microdata, og, raws } from './helpers.js';

function products(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    '@type': 'Product',
    name: `Book ${i + offset + 1}`,
    url: `https://books.example.com/b/${i + offset + 1}`,
    offers: { '@type': 'Offer', price: `${(10 + i + offset).toFixed(2)}`, priceCurrency: 'GBP' },
  }));
}

function listingText(n: number): string {
  return Array.from({ length: n }, (_, i) => `Book ${i + 1}\n\n£${(10 + i).toFixed(2)}`).join('\n\n');
}

const itemList = (n: number) => ({
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  itemListElement: products(n).map((p, i) => ({ '@type': 'ListItem', position: i + 1, item: p })),
});

const schemaFor = (shape: RequestedShape) => makeSchema(['title', { name: 'price', type: 'number' }, 'url'], shape);

describe('ItemList listings', () => {
  it('auto: an ItemList of 20 products becomes 20 records in order', () => {
    const doc = makeDoc({
      title: 'Poetry | Books',
      text: listingText(20),
      items: [ld({ '@type': 'WebSite', name: 'Books', url: 'https://books.example.com/' }), ld(itemList(20)), og({ 'og:type': 'website', 'og:title': 'Poetry' })],
    });
    const res = extractFromStructuredData(doc, schemaFor('auto'));
    expect(res.shape).toBe('array');
    expect(res.records).toHaveLength(20);
    expect(res.records.map((r) => r.title.raw)).toEqual(Array.from({ length: 20 }, (_, i) => `Book ${i + 1}`));
    expect(raws(res.records[3])).toEqual({ title: 'Book 4', price: '13.00', url: 'https://books.example.com/b/4' });
    expect(res.records[3].price).toMatchObject({ structuredId: 'sd1', pointer: '/itemListElement/3/item/offers/price', visibleInPage: true });
    expect(res.filledFields).toEqual(['title', 'price', 'url']);
    expect(res.warnings.filter((w) => w.startsWith('structured_value_not_visible')).sort()).toEqual(['structured_value_not_visible:url']);
  });

  it('array: same listing', () => {
    const res = extractFromStructuredData(makeDoc({ text: listingText(5), items: [ld(itemList(5))] }), schemaFor('array'));
    expect(res.shape).toBe('array');
    expect(res.records).toHaveLength(5);
  });

  it('object: never an array; the best item, flagged as ambiguous', () => {
    const res = extractFromStructuredData(makeDoc({ text: listingText(5), items: [ld(itemList(5))] }), schemaFor('object'));
    expect(res.shape).toBe('object');
    expect(res.records).toHaveLength(1);
    expect(raws(res.records[0]).title).toBe('Book 1');
    expect(res.warnings).toContain('multiple_entities:Product');
  });

  it('follows ListItem positions when the array is out of order', () => {
    const list = itemList(4);
    list.itemListElement.reverse();
    const res = extractFromStructuredData(makeDoc({ items: [ld(list)] }), schemaFor('array'));
    expect(res.records.map((r) => r.title.raw)).toEqual(['Book 1', 'Book 2', 'Book 3', 'Book 4']);
    expect(res.records[0].title.pointer).toBe('/itemListElement/3/item/name');
  });

  it('ListItems referencing top-level products by @id', () => {
    const items = products(3).map((p, i) => ({ ...p, '@id': `#p${i}` }));
    const list = { '@type': 'ItemList', itemListElement: items.map((_, i) => ({ '@type': 'ListItem', position: i + 1, item: { '@id': `#p${i}` } })) };
    const res = extractFromStructuredData(makeDoc({ items: [ld(list), ...items.map(ld)] }), schemaFor('auto'));
    expect(res.shape).toBe('array');
    expect(res.records.map((r) => [r.title.raw, r.title.structuredId, r.title.pointer])).toEqual([
      ['Book 1', 'sd1', '/name'],
      ['Book 2', 'sd2', '/name'],
      ['Book 3', 'sd3', '/name'],
    ]);
  });

  it('ListItems with only name/url (summary carousels) still give records', () => {
    const list = {
      '@type': 'ItemList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, url: 'https://x.example.com/a', name: 'Alpha' },
        { '@type': 'ListItem', position: 2, url: 'https://x.example.com/b', name: 'Beta' },
      ],
    };
    const res = extractFromStructuredData(makeDoc({ items: [ld(list)] }), makeSchema(['name', 'link', { name: 'rank', type: 'integer' }], 'array'));
    expect(res.records.map(raws)).toEqual([
      { name: 'Alpha', link: 'https://x.example.com/a', rank: 1 },
      { name: 'Beta', link: 'https://x.example.com/b', rank: 2 },
    ]);
  });

  it('OfferCatalog of offers reads products through itemOffered', () => {
    const catalog = {
      '@type': 'OfferCatalog',
      itemListElement: [
        { '@type': 'Offer', price: '5', priceCurrency: 'USD', itemOffered: { '@type': 'Product', name: 'Pen' } },
        { '@type': 'Offer', price: '7', priceCurrency: 'USD', itemOffered: { '@type': 'Product', name: 'Pencil case' } },
      ],
    };
    const res = extractFromStructuredData(makeDoc({ items: [ld(catalog)] }), makeSchema(['name', 'price', 'currency'], 'auto'));
    expect(res.shape).toBe('array');
    expect(res.records.map(raws)).toEqual([
      { name: 'Pen', price: '5', currency: 'USD' },
      { name: 'Pencil case', price: '7', currency: 'USD' },
    ]);
  });

  it('SearchResultsPage listing results in mainEntity', () => {
    const page = { '@type': 'SearchResultsPage', name: 'Results for "book"', mainEntity: products(3) };
    const res = extractFromStructuredData(makeDoc({ items: [ld(page)] }), schemaFor('auto'));
    expect(res.shape).toBe('array');
    expect(res.records.map((r) => r.title.raw)).toEqual(['Book 1', 'Book 2', 'Book 3']);
    expect(res.records[1].title.pointer).toBe('/mainEntity/1/name');
  });

  it('breadcrumbs are never a listing', () => {
    const crumbs = {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://x.example.com/' },
        { '@type': 'ListItem', position: 2, name: 'Books', item: 'https://x.example.com/books' },
      ],
    };
    const res = extractFromStructuredData(makeDoc({ items: [ld(crumbs)] }), makeSchema(['name', 'url'], 'auto'));
    expect(res.shape).toBeNull();
  });
});

describe('auto shape: detail page vs listing', () => {
  const main = {
    '@type': 'Product',
    name: 'Book 99',
    url: 'https://books.example.com/b/99',
    offers: { '@type': 'Offer', price: '99.00', priceCurrency: 'GBP' },
  };

  it('a product page with a related-products ItemList is an object', () => {
    const res = extractFromStructuredData(
      makeDoc({ url: 'https://books.example.com/b/99', title: 'Book 99 | Books', text: `Book 99\n\n£99.00\n\n${listingText(4)}`, items: [ld(main), ld(itemList(4))] }),
      schemaFor('auto'),
    );
    expect(res.shape).toBe('object');
    expect(raws(res.records[0])).toEqual({ title: 'Book 99', price: '99.00', url: 'https://books.example.com/b/99' });
  });

  it('several top-level products and no main one: a listing', () => {
    const res = extractFromStructuredData(makeDoc({ title: 'New arrivals', text: listingText(3), items: products(3).map(ld) }), schemaFor('auto'));
    expect(res.shape).toBe('array');
    expect(res.records.map((r) => r.title.raw)).toEqual(['Book 1', 'Book 2', 'Book 3']);
  });

  it('several top-level products, one named in the title: that product', () => {
    const res = extractFromStructuredData(makeDoc({ title: 'Book 2 – Books Shop', text: listingText(3), items: products(3).map(ld) }), schemaFor('auto'));
    expect(res.shape).toBe('object');
    expect(raws(res.records[0]).title).toBe('Book 2');
  });

  it('a product whose url is the page URL is the main one', () => {
    const res = extractFromStructuredData(makeDoc({ url: 'https://books.example.com/b/3', items: products(3).map(ld) }), schemaFor('auto'));
    expect(res.shape).toBe('object');
    expect(raws(res.records[0]).title).toBe('Book 3');
  });

  it('a single product requested as an array is a one-record array', () => {
    const res = extractFromStructuredData(makeDoc({ items: [ld(main)] }), schemaFor('array'));
    expect(res.shape).toBe('array');
    expect(res.records.map(raws)).toEqual([{ title: 'Book 99', price: '99.00', url: 'https://books.example.com/b/99' }]);
  });

  it('a one-item list in auto mode is an object', () => {
    const res = extractFromStructuredData(makeDoc({ items: [ld(itemList(1))] }), schemaFor('auto'));
    expect(res.shape).toBe('object');
    expect(raws(res.records[0]).title).toBe('Book 1');
  });
});

describe('explicit array shape: listing or the page entity?', () => {
  const main = {
    '@type': 'Product',
    name: 'Book 99',
    url: 'https://books.example.com/b/99',
    offers: { '@type': 'Offer', price: '99.00', priceCurrency: 'GBP' },
    review: [
      { '@type': 'Review', name: 'Great read', author: 'Ann', reviewRating: { ratingValue: 5 } },
      { '@type': 'Review', name: 'Too long', author: 'Bob', reviewRating: { ratingValue: 2 } },
    ],
  };
  const detail = (extra: object[] = []) =>
    makeDoc({ url: 'https://books.example.com/b/99', title: 'Book 99 | Books', items: [ld(main), ...extra.map(ld)] });

  it('a detail page gives its own entity, not review titles', () => {
    const res = extractFromStructuredData(detail(), schemaFor('array'));
    expect(res.shape).toBe('array');
    expect(res.records.map(raws)).toEqual([{ title: 'Book 99', price: '99.00', url: 'https://books.example.com/b/99' }]);
  });

  it('a detail page with a related-products list gives its own entity', () => {
    const res = extractFromStructuredData(detail([itemList(4)]), schemaFor('array'));
    expect(res.records.map((r) => r.title.raw)).toEqual(['Book 99']);
  });

  it('a review-shaped schema gets the reviews', () => {
    const res = extractFromStructuredData(detail(), makeSchema(['reviewer', { name: 'rating', type: 'number' }], 'array'));
    expect(res.records.map(raws)).toEqual([
      { reviewer: 'Ann', rating: 5 },
      { reviewer: 'Bob', rating: 2 },
    ]);
  });

  it('without a main entity, ties go to the listing', () => {
    const res = extractFromStructuredData(makeDoc({ items: [ld({ ...main, url: undefined, review: undefined }), ld(itemList(3))] }), schemaFor('array'));
    expect(res.records).toHaveLength(3);
  });
});

describe('other lists', () => {
  it('navigation lists are never listings', () => {
    const nav = {
      '@type': 'ItemList',
      itemListElement: ['Home', 'Shop', 'About'].map((name, i) => ({ '@type': 'SiteNavigationElement', position: i + 1, name, url: `https://x.example.com/${name}` })),
    };
    const res = extractFromStructuredData(makeDoc({ items: [ld(nav), ld({ '@type': 'WPHeader', name: 'Header' })] }), makeSchema(['name', 'url'], 'auto'));
    expect(res.shape).toBeNull();
  });

  it('FAQPage questions as records', () => {
    const faq = {
      '@type': 'FAQPage',
      mainEntity: [
        { '@type': 'Question', name: 'Do you ship abroad?', acceptedAnswer: { '@type': 'Answer', text: 'Yes, to 40 countries.' } },
        { '@type': 'Question', name: 'Can I return items?', acceptedAnswer: { '@type': 'Answer', text: '<p>Within 30 days.</p>' } },
      ],
    };
    const schema = makeSchema(['question', 'answer'], 'auto');
    const res = extractFromStructuredData(makeDoc({ text: 'FAQ\n\nDo you ship abroad?\n\nYes, to 40 countries.\n\nCan I return items?\n\nWithin 30 days.', items: [ld(faq)] }), schema);
    expect(res.shape).toBe('array');
    expect(res.records.map(raws)).toEqual([
      { question: 'Do you ship abroad?', answer: 'Yes, to 40 countries.' },
      { question: 'Can I return items?', answer: '<p>Within 30 days.</p>' },
    ]);
    expect(res.records[1].answer).toMatchObject({ pointer: '/mainEntity/1/acceptedAnswer/text', visibleInPage: true });
  });

  it('reviews of a product: auto picks the reviews when the schema is about reviews', () => {
    const product = {
      '@type': 'Product',
      name: 'Kettle',
      aggregateRating: { ratingValue: 4, reviewCount: 2 },
      review: [
        { '@type': 'Review', author: { '@type': 'Person', name: 'Ann' }, reviewRating: { ratingValue: 5 }, reviewBody: 'Boils fast.', datePublished: '2024-01-02' },
        { '@type': 'Review', author: 'Bob', reviewRating: { ratingValue: 3 }, reviewBody: 'A bit loud.' },
      ],
    };
    const doc = makeDoc({ title: 'Kettle', items: [ld(product)] });
    const reviews = extractFromStructuredData(doc, makeSchema(['reviewer', { name: 'rating', type: 'number' }, 'reviewText', 'date'], 'auto'));
    expect(reviews.shape).toBe('array');
    expect(reviews.records.map(raws)).toEqual([
      { reviewer: 'Ann', rating: 5, reviewText: 'Boils fast.', date: '2024-01-02' },
      { reviewer: 'Bob', rating: 3, reviewText: 'A bit loud.' },
    ]);
    const productRecord = extractFromStructuredData(doc, makeSchema(['name', { name: 'rating', type: 'number' }], 'auto'));
    expect(productRecord.shape).toBe('object');
    expect(raws(productRecord.records[0])).toEqual({ name: 'Kettle', rating: 4 });
  });

  it('microdata product cards', () => {
    const cards = [1, 2, 3].map((i) => microdata({ '@type': 'Product', name: `Card ${i}`, offers: { '@type': 'Offer', price: `${i}.00` } }));
    const res = extractFromStructuredData(makeDoc({ items: cards }), makeSchema(['name', 'price'], 'auto'));
    expect(res.shape).toBe('array');
    expect(res.records.map((r) => [r.name.raw, r.name.structuredId])).toEqual([
      ['Card 1', 'sd0'],
      ['Card 2', 'sd1'],
      ['Card 3', 'sd2'],
    ]);
  });

  it('the fuller of two lists wins; between equally full lists, the longer one', () => {
    const names = { '@type': 'ItemList', itemListElement: [1, 2, 3, 4, 5, 6].map((i) => ({ '@type': 'ListItem', position: i, name: `Name ${i}` })) };
    const res = extractFromStructuredData(makeDoc({ items: [ld(names), ld(itemList(3))] }), schemaFor('array'));
    expect(res.records.map((r) => r.title.raw)).toEqual(['Book 1', 'Book 2', 'Book 3']);
    const longer = extractFromStructuredData(makeDoc({ items: [ld(itemList(2)), ld({ ...itemList(5) })] }), schemaFor('array'));
    expect(longer.records).toHaveLength(5);
  });
});

describe('embedded app-state listings', () => {
  const state = (names: string[]) => ({
    props: {
      pageProps: {
        menu: { items: [{ title: 'Home' }, { title: 'Sale' }, { title: 'Contact' }] },
        search: {
          products: names.map((name, i) => ({ id: i, name, price: { value: 10 + i, currency: 'USD' }, url: `/p/${i}` })),
        },
      },
    },
  });

  it('a products array whose names are on the page', () => {
    const names = ['Alpine Tent', 'Camp Stove', 'Trail Lamp'];
    const res = extractFromStructuredData(
      makeDoc({ text: `${names.join('\n\n')}\n\n${'Free shipping on orders over $50. '.repeat(8)}`, items: [embedded(state(names))] }),
      makeSchema(['name', { name: 'price', type: 'number' }, 'currency'], 'auto'),
    );
    expect(res.shape).toBe('array');
    expect(res.records.map(raws)).toEqual([
      { name: 'Alpine Tent', price: 10, currency: 'USD' },
      { name: 'Camp Stove', price: 11, currency: 'USD' },
      { name: 'Trail Lamp', price: 12, currency: 'USD' },
    ]);
    expect(res.records[2].price.pointer).toBe('/props/pageProps/search/products/2/price/value');
  });

  it('a products array the page does not show (recommendations, stale cache) is ignored', () => {
    const res = extractFromStructuredData(
      makeDoc({ text: `Alpine Tent\n\n${'Free shipping on orders over $50. '.repeat(8)}`, items: [embedded(state(['Alpine Tent', 'Hidden A', 'Hidden B', 'Hidden C']))] }),
      makeSchema(['name', 'price'], 'array'),
    );
    expect(res.shape).toBeNull();
  });

  it('GraphQL edges/node connections', () => {
    const data = { data: { collection: { products: { edges: ['A', 'B'].map((n) => ({ cursor: n, node: { title: `Lamp ${n}`, handle: n } })) } } } };
    const res = extractFromStructuredData(makeDoc({ items: [embedded(data)] }), makeSchema(['title'], 'array'));
    expect(res.records.map((r) => [r.title.raw, r.title.pointer])).toEqual([
      ['Lamp A', '/data/collection/products/edges/0/node/title'],
      ['Lamp B', '/data/collection/products/edges/1/node/title'],
    ]);
  });
});

describe('limits', () => {
  it('caps a huge list at 5,000 records with a warning', () => {
    const n = 6_000;
    const list = { '@type': 'ItemList', itemListElement: Array.from({ length: n }, (_, i) => ({ '@type': 'ListItem', position: i + 1, item: { '@type': 'Product', name: `P${i}` } })) };
    const res = extractFromStructuredData(makeDoc({ items: [ld(list)] }), makeSchema(['name'], 'array'));
    expect(res.records).toHaveLength(5_000);
    expect(res.records[4_999].name.raw).toBe('P4999');
    expect(res.warnings).toContain('structured_records_capped:5000');
  });

  it('maps 5,000 records with visibility checks quickly', () => {
    const n = 5_000;
    const list = {
      '@type': 'ItemList',
      itemListElement: Array.from({ length: n }, (_, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: { '@type': 'Product', name: `Product number ${i}`, sku: `SKU-${i}`, offers: { price: `${i}.99`, priceCurrency: 'USD' } },
      })),
    };
    const text = Array.from({ length: n }, (_, i) => `Product number ${i}\n\n$${i}.99`).join('\n\n');
    const doc = makeDoc({ text, items: [ld(list)] });
    const t0 = performance.now();
    const res = extractFromStructuredData(doc, makeSchema(['name', { name: 'price', type: 'number' }, 'currency', 'sku'], 'array'));
    const ms = performance.now() - t0;
    expect(res.records).toHaveLength(n);
    expect(res.records[4321].name.visibleInPage).toBe(true);
    expect(res.records[4321].price.visibleInPage).toBe(true);
    expect(ms).toBeLessThan(3_000);
  });
});
