import { describe, expect, it } from 'vitest';
import { extractFromStructuredData } from '../../src/extract/structured/index.js';
import type { SourceDocument, StructuredDataItem } from '../../src/extract/types.js';
import { embedded, ld, makeDoc, makeSchema, microdata, og, raws } from './helpers.js';

const schema = makeSchema(['name', { name: 'price', type: 'number' }, 'currency', 'brand', 'image', { name: 'rating', type: 'number' }]);

function noFailure(res: { warnings: string[] }): void {
  expect(res.warnings.filter((w) => w.startsWith('structured_mapping_failed'))).toEqual([]);
}

function nest(depth: number, leaf: unknown, wrap: (inner: unknown) => unknown): unknown {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = wrap(v);
  return v;
}

describe('odd @type values', () => {
  it('@type arrays, IRIs and prefixed names', () => {
    for (const type of [['Product', 'Thing'], ['https://schema.org/Thing', 'http://schema.org/Product'], 'schema:Product', ['IndividualProduct'], 'https://schema.org/Product']) {
      const res = extractFromStructuredData(makeDoc({ items: [ld({ '@type': type, name: 'Lamp', offers: { price: '3' } })] }), schema);
      noFailure(res);
      expect(raws(res.records[0]), JSON.stringify(type)).toEqual({ name: 'Lamp', price: '3' });
    }
  });

  it('a Product that is also a Book fits book and product schemas', () => {
    const doc = makeDoc({ items: [ld({ '@type': ['Product', 'Book'], name: 'Dune', isbn: '9780441013593', author: { name: 'Frank Herbert' }, offers: { price: '9.99' } })] });
    const res = extractFromStructuredData(doc, makeSchema(['title', 'author', 'isbn', { name: 'price', type: 'number' }]));
    expect(raws(res.records[0])).toEqual({ title: 'Dune', author: 'Frank Herbert', isbn: '9780441013593', price: '9.99' });
  });

  it('missing, numeric, object or absurd @type values', () => {
    for (const type of [undefined, 42, { '@id': 'Product' }, '', 'x'.repeat(10_000), [null, 7, []], ['BreadcrumbList']]) {
      const res = extractFromStructuredData(makeDoc({ items: [ld({ '@type': type, name: 'Lamp' })] }), schema);
      noFailure(res);
    }
  });
});

describe('odd offers', () => {
  it.each([
    ['a string', '19.99'],
    ['a number', 19.99],
    ['null', null],
    ['true', true],
    ['an empty array', []],
    ['an array of junk', ['x', 5, null, [], [[{}]]]],
    ['an empty object', {}],
    ['offers with string prices nobody can read', [{ price: 'TBD' }, { price: 'n/a' }]],
  ])('offers as %s never invent a price', (_, offers) => {
    const res = extractFromStructuredData(makeDoc({ items: [ld({ '@type': 'Product', name: 'Lamp', offers })] }), schema);
    noFailure(res);
    expect(raws(res.records[0])).toEqual({ name: 'Lamp' });
  });

  it('the one real offer among junk is used', () => {
    const res = extractFromStructuredData(makeDoc({ items: [ld({ '@type': 'Product', name: 'Lamp', offers: ['x', null, { price: '10', priceCurrency: 'USD' }] })] }), schema);
    expect(raws(res.records[0])).toEqual({ name: 'Lamp', price: '10', currency: 'USD' });
    expect(res.records[0].price.pointer).toBe('/offers/2/price');
  });

  it('thousands of offers are bounded', () => {
    const offers = Array.from({ length: 50_000 }, (_, i) => ({ price: String(i), priceCurrency: 'USD' }));
    const res = extractFromStructuredData(makeDoc({ text: 'Lamp $0', items: [ld({ '@type': 'Product', name: 'Lamp', offers })] }), schema);
    expect(raws(res.records[0]).price).toBe('0');
    expect(res.warnings).toContain('multiple_offers');
  });
});

describe('numeric strings and odd scalars', () => {
  it('numbers as strings, strings as numbers', () => {
    const res = extractFromStructuredData(
      makeDoc({ items: [ld({ '@type': 'Product', name: 12345, offers: { price: ' 7.50 ' }, aggregateRating: { ratingValue: '4,5' } })] }),
      schema,
    );
    expect(raws(res.records[0])).toEqual({ name: 12345, price: ' 7.50 ', rating: '4,5' });
  });

  it('JSON-LD @value wrappers and language maps', () => {
    const res = extractFromStructuredData(
      makeDoc({ items: [ld({ '@type': 'Product', name: { '@value': 'Lampe', '@language': 'fr' }, brand: [{ '@value': 'Lumi' }] })] }),
      schema,
    );
    expect(raws(res.records[0])).toEqual({ name: 'Lampe', brand: 'Lumi' });
    expect(res.records[0].name.pointer).toBe('/name/@value');
  });

  it('non-finite numbers, empty and template strings are not values', () => {
    const res = extractFromStructuredData(
      makeDoc({ items: [ld({ '@type': 'Product', name: '{{ product.title }}', brand: '   ', image: 'javascript:alert(1)', offers: { price: Number.NaN }, aggregateRating: { ratingValue: Infinity } })] }),
      schema,
    );
    noFailure(res);
    expect(res.shape).toBeNull();
  });

  it('data: and javascript: URLs are not images', () => {
    const res = extractFromStructuredData(makeDoc({ items: [ld({ '@type': 'Product', name: 'Lamp', image: ['data:image/png;base64,AAAA', 'javascript:x', '/img/lamp.jpg'] })] }), schema);
    expect(raws(res.records[0])).toEqual({ name: 'Lamp', image: '/img/lamp.jpg' });
    for (const image of ['img/lamp.jpg', '../media/lamp.webp?v=2']) {
      const r = extractFromStructuredData(makeDoc({ items: [ld({ '@type': 'Product', name: 'Lamp', image: ['mailto:a@b.c', 'not a url', image] })] }), schema);
      expect(raws(r.records[0]).image).toBe(image);
    }
  });
});

describe('deeply nested junk', () => {
  it('deep arrays and objects around values', () => {
    const res = extractFromStructuredData(
      makeDoc({
        items: [
          ld({
            '@type': 'Product',
            name: 'Lamp',
            brand: nest(5_000, { name: 'Deep' }, (v) => [v]),
            image: nest(5_000, 'https://x.example.com/a.jpg', (v) => ({ url: v })),
            junk: nest(10_000, 1, (v) => ({ a: [v] })),
          }),
        ],
      }),
      schema,
    );
    noFailure(res);
    // Values more than a few wrappers deep are not read.
    expect(raws(res.records[0])).toEqual({ name: 'Lamp' });
  });

  it('deep embedded app state is walked within a budget', () => {
    const deep = nest(20_000, { product: { title: 'Lamp', price: 1 } }, (v) => ({ child: v }));
    const wide = { props: { pageProps: Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`k${i}`, { v: Array.from({ length: 50 }, (_, j) => ({ j })) }])) } };
    const t0 = performance.now();
    const res = extractFromStructuredData(makeDoc({ text: 'Lamp', items: [embedded(deep), embedded(wide), embedded(nest(50_000, [], (v) => [v]))] }), schema);
    noFailure(res);
    expect(res.shape).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

describe('hostile keys and prototypes', () => {
  it('"__proto__", "constructor" and "toString" in page data stay data', () => {
    const data = JSON.parse('{"@type":"Product","name":"Good","__proto__":{"name":"Evil","polluted":true},"constructor":{"name":"Bad"},"offers":{"__proto__":{"price":"666"}}}');
    const res = extractFromStructuredData(makeDoc({ items: [ld(data)] }), schema);
    expect(raws(res.records[0])).toEqual({ name: 'Good' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('customer fields named "__proto__" or "constructor" do not touch prototypes', () => {
    const data = JSON.parse('{"@type":"Product","name":"Lamp","__proto__":"x","constructor":"y","toString":"z"}');
    const res = extractFromStructuredData(makeDoc({ items: [ld(data)] }), makeSchema(['name', '__proto__', 'constructor', 'toString']));
    noFailure(res);
    const rec = res.records[0];
    expect(Object.getPrototypeOf(rec)).toBe(Object.prototype);
    expect(Object.hasOwn(rec, 'name')).toBe(true);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('items that were not flattened', () => {
  it('an @graph container and a top-level array are read node by node', () => {
    const graph = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', name: 'Shop' },
        { '@type': 'Product', '@id': '#p', name: 'Lamp', brand: { '@id': '#b' }, offers: { price: '5' } },
        { '@type': 'Brand', '@id': '#b', name: 'Lumi' },
      ],
    };
    const res = extractFromStructuredData(makeDoc({ items: [ld(graph)] }), schema);
    expect(raws(res.records[0])).toEqual({ name: 'Lamp', price: '5', brand: 'Lumi' });
    expect(res.records[0].name.pointer).toBe('/@graph/1/name');
    expect(res.records[0].brand.pointer).toBe('/@graph/2/name');

    const array = extractFromStructuredData(makeDoc({ items: [{ source: 'json-ld', data: [{ '@type': 'Product', name: 'A' }, { '@type': 'Product', name: 'B' }] }] }), makeSchema(['name'], 'array'));
    expect(array.records.map((r) => [r.name.raw, r.name.pointer])).toEqual([
      ['A', '/0/name'],
      ['B', '/1/name'],
    ]);
  });

  it('huge or deeply nested graphs are bounded', () => {
    const many = { '@graph': Array.from({ length: 100_000 }, (_, i) => ({ '@type': 'Thing', name: `T${i}` })) };
    const deep = nest(100_000, { '@type': 'Product', name: 'Deep' }, (v) => ({ '@graph': [v] }));
    const t0 = performance.now();
    const res = extractFromStructuredData(makeDoc({ items: [ld(many), ld(deep)] }), makeSchema(['name']));
    noFailure(res);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});

describe('malformed documents', () => {
  it('garbage items and missing fields never throw', () => {
    const items = [
      { id: 'sd0', source: 'json-ld', data: null },
      { id: 'sd1', source: 'json-ld', data: 42 },
      { id: 'sd2', source: 'json-ld', data: 'Product' },
      { id: 'sd3', source: 'json-ld', data: [[{ '@type': 'Product', name: 'Hidden in array' }]] },
      { id: 'sd4', source: 'microdata', data: { '@type': 'Product' } },
      { id: 'sd5', source: 'embedded-json', data: null },
      { id: 'sd6', source: 'opengraph', data: 'og' },
      { id: 'sd7', source: 'meta', data: [] },
      { id: 'sd8', source: 'carrier-pigeon', data: { name: 'x' } },
      null,
      7,
    ] as unknown as StructuredDataItem[];
    const doc = { ...makeDoc({ items: [] }), structured: items, text: undefined, blocks: null } as unknown as SourceDocument;
    const res = extractFromStructuredData(doc, schema);
    noFailure(res);
    // Only the product nested in arrays is usable.
    expect(res.records.map(raws)).toEqual([{ name: 'Hidden in array' }]);
    expect(res.records[0].name).toMatchObject({ structuredId: 'sd3', pointer: '/0/0/name', visibleInPage: false });
  });

  it('a document without structured data or text', () => {
    const doc = { url: 'https://x.example.com' } as unknown as SourceDocument;
    expect(extractFromStructuredData(doc, schema)).toEqual({ shape: null, records: [], filledFields: [], warnings: [] });
  });

  it('a schema without fields', () => {
    const s = { ...makeSchema([]), fields: undefined } as unknown as ReturnType<typeof makeSchema>;
    expect(extractFromStructuredData(makeDoc({ items: [ld({ '@type': 'Product', name: 'x' })] }), s).shape).toBeNull();
  });

  it('OpenGraph with non-string values and odd keys', () => {
    const res = extractFromStructuredData(
      makeDoc({ items: [og({ 'og:title': 'Lamp' }), { source: 'opengraph', data: { 'og:title': 5, 'og:image': ['x'], 'product:price:amount': { a: 1 } } }] }),
      schema,
    );
    noFailure(res);
    expect(raws(res.records[0])).toEqual({ name: 'Lamp' });
  });

  it('microdata with repeated properties (arrays) and nested items', () => {
    const res = extractFromStructuredData(
      makeDoc({ items: [microdata({ '@type': 'Product', name: ['Lamp', 'Lamp (alt)'], offers: [{ '@type': 'Offer', price: '5' }, { '@type': 'Offer', price: '5' }], brand: { '@type': 'Brand', name: ['Lumi'] } })] }),
      schema,
    );
    expect(raws(res.records[0])).toEqual({ name: 'Lamp', price: '5', brand: 'Lumi' });
  });
});

describe('scale of top-level entities', () => {
  it('thousands of top-level products form one bounded listing quickly', () => {
    const items = Array.from({ length: 6_000 }, (_, i) => ld({ '@type': 'Product', name: `P${i}`, sku: `S${i % 5_500}` }));
    const t0 = performance.now();
    const res = extractFromStructuredData(makeDoc({ items }), makeSchema(['name', 'sku'], 'array'));
    noFailure(res);
    // sku duplicates beyond 5,500 are the same products described twice.
    expect(res.records).toHaveLength(5_000);
    expect(res.warnings).toContain('structured_records_capped:5000');
    expect(performance.now() - t0).toBeLessThan(3_000);
  });
});

describe('last-resort guard', () => {
  it('a throwing document getter becomes a warning, not an exception', () => {
    const doc = makeDoc({ items: [ld({ '@type': 'Product', name: 'Lamp' })] });
    Object.defineProperty(doc, 'structured', {
      get() {
        throw new TypeError('boom');
      },
    });
    expect(extractFromStructuredData(doc, schema)).toEqual({ shape: null, records: [], filledFields: [], warnings: ['structured_mapping_failed:TypeError'] });
  });
});
