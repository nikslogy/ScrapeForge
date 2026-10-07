import { describe, expect, it } from 'vitest';
import { conceptsForName, conceptsInDescription, planSchema } from '../../src/extract/structured/concepts.js';
import { extractFromStructuredData } from '../../src/extract/structured/index.js';
import { ld, makeDoc, makeSchema, raws } from './helpers.js';

const ids = (name: string) => conceptsForName(name).map((c) => c.id);

describe('field names → concepts', () => {
  it.each([
    ['title', 'name'],
    ['productName', 'name'],
    ['product_name', 'name'],
    ['Product-Title', 'name'],
    ['headline', 'name'],
    ['price', 'price'],
    ['salePrice', 'price'],
    ['current_price', 'price'],
    ['amount', 'price'],
    ['priceText', 'price'],
    ['item_price', 'price'],
    ['originalPrice', 'originalPrice'],
    ['listPrice', 'originalPrice'],
    ['was_price', 'originalPrice'],
    ['compareAtPrice', 'originalPrice'],
    ['MSRP', 'originalPrice'],
    ['currency', 'currency'],
    ['priceCurrency', 'currency'],
    ['inStock', 'availability'],
    ['is_in_stock', 'availability'],
    ['availability', 'availability'],
    ['rating', 'rating'],
    ['stars', 'rating'],
    ['ratingValue', 'rating'],
    ['averageRating', 'rating'],
    ['reviewCount', 'reviewCount'],
    ['reviews', 'reviewCount'],
    ['numReviews', 'reviewCount'],
    ['ratingCount', 'ratingCount'],
    ['brand', 'brand'],
    ['brandName', 'brand'],
    ['sku', 'sku'],
    ['productId', 'productId'],
    ['gtin13', 'gtin13'],
    ['ean', 'gtin13'],
    ['UPC', 'gtin12'],
    ['mpn', 'mpn'],
    ['image', 'image'],
    ['imageUrl', 'image'],
    ['images', 'image'],
    ['url', 'url'],
    ['productUrl', 'url'],
    ['link', 'url'],
    ['description', 'description'],
    ['author', 'author'],
    ['authors', 'author'],
    ['authorName', 'author'],
    ['datePublished', 'datePublished'],
    ['publishedAt', 'datePublished'],
    ['date', 'date'],
    ['updatedAt', 'dateModified'],
    ['publisher', 'publisher'],
    ['category', 'category'],
    ['categories', 'category'],
    ['color', 'color'],
    ['isbn', 'isbn'],
    ['numberOfPages', 'numberOfPages'],
    ['salary', 'salary'],
    ['company', 'company'],
    ['employer', 'company'],
    ['location', 'location'],
    ['startDate', 'startDate'],
    ['endDate', 'endDate'],
    ['ingredients', 'ingredients'],
    ['jobTitle', 'jobTitle'],
  ])('%s → %s', (name, concept) => {
    expect(ids(name)[0]).toBe(concept);
  });

  it('an ambiguous name keeps every candidate in order', () => {
    expect(ids('position')).toEqual(['jobTitle', 'rank']);
  });

  it('unknown or empty names match nothing', () => {
    for (const name of ['', '   ', 'foo', 'warrantyYears', 'shippingNotes', 'value', 'item', 'type', 'status', 'stock', 'shipping cost', 'x'.repeat(500)]) {
      expect(ids(name), name).toEqual([]);
    }
  });

  it('descriptions name a concept only when exactly one is named', () => {
    expect(conceptsInDescription('numeric price in pounds').map((c) => c.id)).toEqual(['price']);
    expect(conceptsInDescription('The price before discount').map((c) => c.id)).toEqual(['originalPrice']);
    expect(conceptsInDescription('price and rating').map((c) => c.id)).toEqual(['price', 'rating']);
    expect(conceptsInDescription('rating out of 5').map((c) => c.id)).toEqual(['rating']);
  });
});

describe('schema plans', () => {
  it('uses the description only when the name means nothing', () => {
    const plan = planSchema(
      makeSchema([
        { name: 'cost_gbp', type: 'number', description: 'numeric price in pounds' },
        { name: 'thing', description: 'price or rating' },
        { name: 'title', description: 'the price' },
      ]),
    );
    expect(plan.fields.map((f) => [f.matchedBy, f.concepts.map((c) => c.id)])).toEqual([
      ['description', ['price']],
      ['none', []],
      ['name', ['name']],
    ]);
  });

  it('drops concepts whose values cannot fit the field type', () => {
    const plan = planSchema(
      makeSchema([
        { name: 'name', type: 'number' },
        { name: 'reviews', type: 'array', itemType: 'object' },
        { name: 'price', type: 'boolean' },
        { name: 'inStock', type: 'boolean' },
        { name: 'brand', type: 'object' },
        { name: 'images', type: 'array', itemType: 'string' },
        { name: 'price', type: 'array', itemType: 'number' },
      ]),
    );
    expect(plan.fields.map((f) => f.concepts.map((c) => c.id))).toEqual([[], [], [], ['availability'], [], ['image'], []]);
    // A name that matched a concept never falls back to an exact-key read.
    expect(plan.fields.map((f) => f.exactKeyFallback)).toEqual([false, false, false, false, false, false, false]);
  });

  it('caches plans per schema object', () => {
    const schema = makeSchema(['name']);
    expect(planSchema(schema)).toBe(planSchema(schema));
  });
});

describe('mapping behaviour of fields', () => {
  const product = {
    '@type': 'Product',
    name: 'Desk Lamp',
    pattern: 'Striped',
    countryOfOrigin: 'PT',
    weight: { '@type': 'QuantitativeValue', value: 1.2, unitCode: 'KGM' },
    offers: { '@type': 'Offer', price: '45.00', priceCurrency: 'EUR' },
    keywords: 'lamp, desk, lighting',
    color: ['Black', 'White'],
  };
  const doc = makeDoc({ text: 'Desk Lamp €45.00', items: [ld(product)] });

  it('fields with no mapping are simply not filled', () => {
    const res = extractFromStructuredData(doc, makeSchema(['name', { name: 'price', type: 'number' }, 'warrantyYears', 'shippingNotes', 'weight']));
    expect(raws(res.records[0])).toEqual({ name: 'Desk Lamp', price: '45.00' });
    expect(res.filledFields).toEqual(['name', 'price']);
  });

  it('a field named exactly like a property is read from it', () => {
    const res = extractFromStructuredData(doc, makeSchema(['pattern', 'countryOfOrigin', 'country_of_origin']));
    expect(raws(res.records[0])).toEqual({ pattern: 'Striped', countryOfOrigin: 'PT', country_of_origin: 'PT' });
    expect(res.records[0].pattern.pointer).toBe('/pattern');
  });

  it('a description fallback fills an oddly named field', () => {
    const res = extractFromStructuredData(doc, makeSchema([{ name: 'cost_eur', type: 'number', description: 'Numeric price of the item' }]));
    expect(raws(res.records[0])).toEqual({ cost_eur: '45.00' });
  });

  it('multi-valued values: arrays for array fields, joined for strings, first for unjoinable ones', () => {
    const res = extractFromStructuredData(
      doc,
      makeSchema([{ name: 'tags', type: 'array', itemType: 'string' }, 'keywords', { name: 'colors', type: 'array', itemType: 'string' }, 'color', { name: 'colour', type: 'unknown' }]),
    );
    expect(raws(res.records[0])).toEqual({
      tags: ['lamp', 'desk', 'lighting'],
      keywords: 'lamp, desk, lighting',
      colors: ['Black', 'White'],
      color: 'Black, White',
      colour: ['Black', 'White'],
    });
  });

  it('a number field never receives text, a boolean field only availability', () => {
    const res = extractFromStructuredData(doc, makeSchema([{ name: 'name', type: 'number' }, { name: 'price', type: 'boolean' }, { name: 'brand', type: 'object' }]));
    expect(res.shape).toBeNull();
    expect(res.records).toEqual([]);
    expect(res.filledFields).toEqual([]);
  });

  it('an empty schema or empty page maps nothing', () => {
    expect(extractFromStructuredData(doc, makeSchema([]))).toEqual({ shape: null, records: [], filledFields: [], warnings: [] });
    expect(extractFromStructuredData(makeDoc({ items: [] }), makeSchema(['name']))).toEqual({ shape: null, records: [], filledFields: [], warnings: [] });
  });

  it('filledFields lists only fields filled in every record', () => {
    const list = {
      '@type': 'ItemList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, item: { '@type': 'Product', name: 'A', offers: { price: '1' } } },
        { '@type': 'ListItem', position: 2, item: { '@type': 'Product', name: 'B' } },
      ],
    };
    const res = extractFromStructuredData(makeDoc({ items: [ld(list)] }), makeSchema(['name', 'price'], 'array'));
    expect(res.records.map(raws)).toEqual([{ name: 'A', price: '1' }, { name: 'B' }]);
    expect(res.filledFields).toEqual(['name']);
  });
});
