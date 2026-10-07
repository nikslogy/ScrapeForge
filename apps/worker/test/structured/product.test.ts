import { describe, expect, it } from 'vitest';
import { extractFromStructuredData } from '../../src/extract/structured/index.js';
import { embedded, ld, makeDoc, makeSchema, microdata, og, raws } from './helpers.js';

const anvil = {
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Acme Anvil 3000',
  image: ['https://cdn.example.com/a1.jpg', 'https://cdn.example.com/a2.jpg'],
  description: 'A heavy anvil for serious work.',
  sku: 'ANV-3000',
  mpn: 'A3000',
  gtin13: '0012345678905',
  brand: { '@type': 'Brand', name: 'Acme' },
  aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.6', reviewCount: '128', bestRating: '5' },
  offers: {
    '@type': 'Offer',
    price: 199.99,
    priceCurrency: 'USD',
    availability: 'https://schema.org/InStock',
    itemCondition: 'https://schema.org/NewCondition',
    seller: { '@type': 'Organization', name: 'Acme Store' },
  },
};

const anvilText = 'Acme Anvil 3000\n\nBy Acme\n\n$199.99\n\nIn stock\n\n4.6 out of 5 (128 reviews)\n\nA heavy anvil for serious work.';

describe('Product with Offer and AggregateRating', () => {
  const schema = makeSchema([
    'name',
    { name: 'price', type: 'number' },
    'currency',
    'availability',
    { name: 'rating', type: 'number' },
    { name: 'reviewCount', type: 'integer' },
    'brand',
    'image',
    { name: 'images', type: 'array', itemType: 'string' },
    'sku',
    'gtin',
    'mpn',
    'description',
    'condition',
    'seller',
  ]);
  const doc = makeDoc({
    text: anvilText,
    title: 'Acme Anvil 3000 | Acme',
    items: [ld(anvil)],
    attrs: [{ src: 'https://cdn.example.com/a1.jpg', alt: 'Acme Anvil 3000' }],
  });
  const res = extractFromStructuredData(doc, schema);
  const rec = res.records[0];

  it('fills every mappable field from the one product', () => {
    expect(res.shape).toBe('object');
    expect(res.records).toHaveLength(1);
    expect(raws(rec)).toEqual({
      name: 'Acme Anvil 3000',
      price: 199.99,
      currency: 'USD',
      availability: 'https://schema.org/InStock',
      rating: '4.6',
      reviewCount: '128',
      brand: 'Acme',
      image: 'https://cdn.example.com/a1.jpg',
      images: ['https://cdn.example.com/a1.jpg', 'https://cdn.example.com/a2.jpg'],
      sku: 'ANV-3000',
      gtin: '0012345678905',
      mpn: 'A3000',
      description: 'A heavy anvil for serious work.',
      condition: 'https://schema.org/NewCondition',
      seller: 'Acme Store',
    });
    expect(res.filledFields).toEqual(schema.fields.map((f) => f.name));
  });

  it('reports the exact pointer and item for every value', () => {
    const pointers = Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, v.pointer]));
    expect(pointers).toEqual({
      name: '/name',
      price: '/offers/price',
      currency: '/offers/priceCurrency',
      availability: '/offers/availability',
      rating: '/aggregateRating/ratingValue',
      reviewCount: '/aggregateRating/reviewCount',
      brand: '/brand/name',
      image: '/image/0',
      images: '/image',
      sku: '/sku',
      gtin: '/gtin13',
      mpn: '/mpn',
      description: '/description',
      condition: '/offers/itemCondition',
      seller: '/offers/seller/name',
    });
    expect(new Set(Object.values(rec).map((v) => v.structuredId))).toEqual(new Set(['sd0']));
  });

  it('flags what the reader cannot see', () => {
    const visible = Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, v.visibleInPage]));
    expect(visible).toMatchObject({
      name: true,
      price: true,
      currency: true, // "$" on the page
      availability: true, // "In stock"
      rating: true,
      reviewCount: true,
      brand: true,
      image: true, // <img src> on the page
      images: false, // a2.jpg is not shown
      sku: false,
      description: true,
    });
    expect(res.warnings).toContain('structured_value_not_visible:sku');
    expect(res.warnings).toContain('structured_value_not_visible:images');
    expect(res.warnings).not.toContain('structured_value_not_visible:price');
    expect(res.warnings).not.toContain('multiple_offers');
  });

  it('maps a boolean stock field to the raw availability URL', () => {
    const r = extractFromStructuredData(doc, makeSchema([{ name: 'inStock', type: 'boolean' }]));
    expect(raws(r.records[0])).toEqual({ inStock: 'https://schema.org/InStock' });
    expect(r.records[0].inStock.visibleInPage).toBe(true);
  });
});

describe('offers and prices', () => {
  const schema = makeSchema([
    'name',
    { name: 'price', type: 'number' },
    'currency',
    { name: 'lowPrice', type: 'number' },
    { name: 'highPrice', type: 'number' },
    { name: 'originalPrice', type: 'number' },
    'availability',
  ]);
  const run = (offers: unknown, text = 'Widget', extra: Record<string, unknown> = {}) =>
    extractFromStructuredData(makeDoc({ text, items: [ld({ '@type': 'Product', name: 'Widget', offers, ...extra })] }), schema);

  it('AggregateOffer with a price range: lowPrice, flagged as multiple offers', () => {
    const res = run({ '@type': 'AggregateOffer', lowPrice: '19.99', highPrice: '39.99', priceCurrency: 'EUR', offerCount: 4 }, 'Widget from €19.99');
    expect(raws(res.records[0])).toEqual({ name: 'Widget', price: '19.99', currency: 'EUR', lowPrice: '19.99', highPrice: '39.99' });
    expect(res.records[0].price.pointer).toBe('/offers/lowPrice');
    expect(res.warnings).toContain('multiple_offers');
  });

  it('AggregateOffer whose low and high agree is not ambiguous', () => {
    const res = run({ '@type': 'AggregateOffer', lowPrice: 10, highPrice: 10, priceCurrency: 'USD' }, 'Widget $10');
    expect(raws(res.records[0]).price).toBe(10);
    expect(res.warnings).not.toContain('multiple_offers');
  });

  it('never uses highPrice as the original price', () => {
    const res = run({ '@type': 'AggregateOffer', lowPrice: '5', highPrice: '9', priceCurrency: 'USD' });
    expect(raws(res.records[0])).not.toHaveProperty('originalPrice');
  });

  it('several offers with one price and currency: the first, no warning', () => {
    const res = run(
      [
        { '@type': 'Offer', price: '12.50', priceCurrency: 'GBP', availability: 'https://schema.org/InStock' },
        { '@type': 'Offer', price: 12.5, priceCurrency: 'gbp', availability: 'https://schema.org/OutOfStock' },
      ],
      'Widget £12.50',
    );
    expect(raws(res.records[0])).toMatchObject({ price: '12.50', currency: 'GBP', availability: 'https://schema.org/InStock' });
    expect(res.records[0].price.pointer).toBe('/offers/0/price');
    expect(res.warnings).not.toContain('multiple_offers');
  });

  it('offers that disagree: the one visible on the page, with a warning, and its own currency', () => {
    const res = run(
      [
        { '@type': 'Offer', price: '30.00', priceCurrency: 'USD', availability: 'https://schema.org/OutOfStock' },
        { '@type': 'Offer', price: '27.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
      ],
      'Widget\n\nNow $27.00',
    );
    expect(raws(res.records[0])).toMatchObject({ price: '27.00', currency: 'USD', availability: 'https://schema.org/InStock' });
    expect(res.records[0].price.pointer).toBe('/offers/1/price');
    expect(res.records[0].currency.pointer).toBe('/offers/1/priceCurrency');
    expect(res.warnings).toContain('multiple_offers');
  });

  it('offers in different currencies with none visible: the first, with a warning', () => {
    const res = run([
      { '@type': 'Offer', price: '10', priceCurrency: 'USD' },
      { '@type': 'Offer', price: '10', priceCurrency: 'EUR' },
    ]);
    expect(raws(res.records[0])).toMatchObject({ price: '10', currency: 'USD' });
    expect(res.warnings).toContain('multiple_offers');
  });

  it('an AggregateOffer among disagreeing offers wins with its lowPrice', () => {
    const res = run([
      { '@type': 'Offer', price: '30', priceCurrency: 'USD' },
      { '@type': 'AggregateOffer', lowPrice: '25', highPrice: '30', priceCurrency: 'USD' },
    ]);
    expect(raws(res.records[0]).price).toBe('25');
    expect(res.records[0].price.pointer).toBe('/offers/1/lowPrice');
    expect(res.warnings).toContain('multiple_offers');
  });

  it('priceSpecification: SalePrice for the price, ListPrice / StrikethroughPrice only for originalPrice', () => {
    const res = run({
      '@type': 'Offer',
      priceCurrency: 'USD',
      priceSpecification: [
        { '@type': 'UnitPriceSpecification', price: 2.5, priceCurrency: 'USD', referenceQuantity: { value: 1, unitCode: 'KGM' } },
        { '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/ListPrice', price: 59.0, priceCurrency: 'USD' },
        { '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/SalePrice', price: 49.0, priceCurrency: 'USD' },
      ],
    });
    expect(raws(res.records[0])).toMatchObject({ price: 49, originalPrice: 59, currency: 'USD' });
    expect(res.records[0].price.pointer).toBe('/offers/priceSpecification/2/price');
    expect(res.records[0].originalPrice.pointer).toBe('/offers/priceSpecification/1/price');
  });

  it('StrikethroughPrice as {"@id"} enumeration counts as an original price', () => {
    const res = run({
      '@type': 'Offer',
      price: '15.00',
      priceCurrency: 'USD',
      priceSpecification: { '@type': 'UnitPriceSpecification', priceType: { '@id': 'schema:StrikethroughPrice' }, price: '20.00' },
    });
    expect(raws(res.records[0])).toMatchObject({ price: '15.00', originalPrice: '20.00' });
  });

  it('no explicit reference price → originalPrice stays unfilled', () => {
    const res = run({ '@type': 'Offer', price: '15.00', priceCurrency: 'USD', priceSpecification: { price: '15.00' } });
    expect(raws(res.records[0])).not.toHaveProperty('originalPrice');
    expect(res.filledFields).not.toContain('originalPrice');
  });

  it('prices that are not numbers are not prices', () => {
    for (const price of ['Call for price', '', '{{ product.price }}', '10 - 20', 'from $5', null, true, { foo: 1 }]) {
      const res = run({ '@type': 'Offer', price, priceCurrency: 'USD' });
      expect(raws(res.records[0]), JSON.stringify(price)).not.toHaveProperty('price');
    }
  });

  it('numeric strings in any locale are kept raw and checked by value', () => {
    let res = run({ '@type': 'Offer', price: '1,299.00', priceCurrency: 'USD' }, 'Widget $1,299.00');
    expect(raws(res.records[0]).price).toBe('1,299.00');
    expect(res.records[0].price.visibleInPage).toBe(true);
    res = run({ '@type': 'Offer', price: 1299, priceCurrency: 'USD' }, 'Widget $1,299');
    expect(res.records[0].price.visibleInPage).toBe(true);
    res = run({ '@type': 'Offer', price: '1.299,00', priceCurrency: 'EUR' }, 'Widget 1.299,00 €');
    expect(raws(res.records[0]).price).toBe('1.299,00');
    expect(res.records[0].price.visibleInPage).toBe(true);
  });

  it('a stale JSON-LD price is returned raw but flagged as not visible', () => {
    const res = run({ '@type': 'Offer', price: '49.99', priceCurrency: 'USD' }, 'Widget\n\nSale! $39.99');
    expect(raws(res.records[0]).price).toBe('49.99');
    expect(res.records[0].price.visibleInPage).toBe(false);
    expect(res.warnings).toContain('structured_value_not_visible:price');
  });

  it('a price put directly on the product (non-standard) is still found', () => {
    const res = extractFromStructuredData(
      makeDoc({ text: 'Widget $5', items: [ld({ '@type': 'Product', name: 'Widget', price: '5.00', priceCurrency: 'USD' })] }),
      schema,
    );
    expect(raws(res.records[0])).toMatchObject({ price: '5.00', currency: 'USD' });
    expect(res.records[0].price.pointer).toBe('/price');
  });

  it('a standalone Offer is a product-like entity (itemOffered supplies the name)', () => {
    const res = extractFromStructuredData(
      makeDoc({
        text: 'Gadget $7',
        items: [ld({ '@type': 'Offer', price: '7', priceCurrency: 'USD', itemOffered: { '@type': 'Product', name: 'Gadget' } })],
      }),
      schema,
    );
    expect(raws(res.records[0])).toMatchObject({ name: 'Gadget', price: '7', currency: 'USD' });
    expect(res.records[0].name.pointer).toBe('/itemOffered/name');
  });
});

describe('choosing between entities (object shape)', () => {
  const kettle = { '@type': 'Product', name: 'Red Kettle', offers: { '@type': 'Offer', price: '20', priceCurrency: 'USD' } };
  const toaster = {
    '@type': 'Product',
    name: 'Blue Toaster',
    offers: { '@type': 'Offer', price: '35', priceCurrency: 'USD' },
    aggregateRating: { ratingValue: 4.1, reviewCount: 9 },
  };
  const schema = makeSchema(['name', { name: 'price', type: 'number' }, { name: 'rating', type: 'number' }]);

  it('never merges two different products into one record', () => {
    const res = extractFromStructuredData(makeDoc({ text: 'Red Kettle $20\n\nBlue Toaster $35 4.1', items: [ld(kettle), ld(toaster)] }), schema);
    expect(res.shape).toBe('object');
    const rec = res.records[0];
    // The toaster fills more fields; every value must come from it alone.
    expect(raws(rec)).toEqual({ name: 'Blue Toaster', price: '35', rating: 4.1 });
    expect(new Set(Object.values(rec).map((v) => v.structuredId))).toEqual(new Set(['sd1']));
    expect(res.warnings).toContain('multiple_entities:Product');
  });

  it('the page’s main product wins, and a rival’s fields are not borrowed', () => {
    const res = extractFromStructuredData(
      makeDoc({ title: 'Red Kettle – Kitchen Shop', text: 'Red Kettle $20\n\nYou may also like: Blue Toaster', items: [ld(toaster), ld(kettle)] }),
      schema,
    );
    expect(raws(res.records[0])).toEqual({ name: 'Red Kettle', price: '20' });
    expect(res.filledFields).toEqual(['name', 'price']);
    expect(res.warnings.some((w) => w.startsWith('multiple_entities'))).toBe(false);
  });

  it('prefers a product over site scaffolding for price-ish schemas', () => {
    const res = extractFromStructuredData(
      makeDoc({
        text: 'Red Kettle $20',
        items: [
          ld({ '@type': 'WebSite', name: 'Kitchen Shop', url: 'https://shop.example.com/' }),
          ld({ '@type': 'Organization', name: 'Kitchen Shop Ltd', aggregateRating: { ratingValue: 4.9 } }),
          ld({ '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home' }] }),
          ld(kettle),
        ],
      }),
      schema,
    );
    expect(raws(res.records[0])).toEqual({ name: 'Red Kettle', price: '20' });
    expect(res.records[0].name.structuredId).toBe('sd3');
  });

  it('completes the record from a second description of the same product (same sku)', () => {
    const res = extractFromStructuredData(
      makeDoc({
        text: 'Red Kettle $20 4.5',
        items: [
          ld({ ...kettle, sku: 'K-1' }),
          microdata({ '@type': 'Product', name: 'Red Kettle 1.7L', sku: 'K-1', aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.5' } }),
        ],
      }),
      schema,
    );
    expect(raws(res.records[0])).toEqual({ name: 'Red Kettle', price: '20', rating: '4.5' });
    expect(res.records[0].rating.structuredId).toBe('sd1');
  });

  it('a shared page URL does not make two differently named products one', () => {
    const url = 'https://shop.example.com/p/1';
    const res = extractFromStructuredData(
      makeDoc({ url, text: 'Red Kettle', items: [ld({ ...kettle, url }), ld({ '@type': 'Product', name: 'Blue Toaster', url, aggregateRating: { ratingValue: 4.1 } })] }),
      schema,
    );
    expect(raws(res.records[0])).toEqual({ name: 'Red Kettle', price: '20' });
    expect(res.warnings).toContain('multiple_entities:Product');
  });

  it('a conflicting identifier blocks completion even when names agree', () => {
    const res = extractFromStructuredData(
      makeDoc({
        text: 'Red Kettle',
        items: [ld({ ...kettle, sku: 'K-1' }), microdata({ '@type': 'Product', name: 'Red Kettle', sku: 'K-2', aggregateRating: { ratingValue: '4.5' } })],
      }),
      schema,
    );
    expect(raws(res.records[0])).not.toHaveProperty('rating');
  });
});

describe('microdata', () => {
  it('maps a microdata product (string values, nested itemscopes)', () => {
    const res = extractFromStructuredData(
      makeDoc({
        text: 'Trail Runner X\n\n€89,95\n\nOnly 3 left in stock\n\nRated 4,7 / 5 based on 312 reviews',
        items: [
          microdata({
            '@type': 'Product',
            name: 'Trail Runner X',
            image: 'https://shop.example.com/img/trx.jpg',
            offers: { '@type': 'Offer', price: '89.95', priceCurrency: 'EUR', availability: 'https://schema.org/LimitedAvailability' },
            aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.7', reviewCount: '312' },
          }),
        ],
      }),
      makeSchema(['productName', 'salePrice', 'priceCurrency', 'stockStatus', 'stars', 'numReviews', 'imageUrl']),
    );
    expect(raws(res.records[0])).toEqual({
      productName: 'Trail Runner X',
      salePrice: '89.95',
      priceCurrency: 'EUR',
      stockStatus: 'https://schema.org/LimitedAvailability',
      stars: '4.7',
      numReviews: '312',
      imageUrl: 'https://shop.example.com/img/trx.jpg',
    });
    // Comma-decimal display ("€89,95", "4,7") still counts as visible.
    expect(res.records[0].salePrice.visibleInPage).toBe(true);
    expect(res.records[0].stars.visibleInPage).toBe(true);
    expect(res.records[0].stockStatus.visibleInPage).toBe(false);
  });
});

describe('OpenGraph', () => {
  const ogData = {
    'og:type': 'product',
    'og:title': 'Ceramic Mug | Mugs & Co',
    'og:description': 'A hand-thrown ceramic mug.',
    'og:image': 'https://mugs.example.com/mug.jpg',
    'og:url': 'https://mugs.example.com/p/mug',
    'product:price:amount': '18.00',
    'product:price:currency': 'GBP',
    'product:availability': 'in stock',
  };

  it('fills a product record from an OpenGraph-only page', () => {
    const res = extractFromStructuredData(
      makeDoc({ text: 'Ceramic Mug\n\n£18.00\n\nA hand-thrown ceramic mug.', items: [og(ogData)] }),
      makeSchema(['title', { name: 'price', type: 'number' }, 'currency', 'image', 'url', 'description', 'availability', 'rating']),
    );
    expect(res.shape).toBe('object');
    expect(raws(res.records[0])).toEqual({
      title: 'Ceramic Mug | Mugs & Co',
      price: '18.00',
      currency: 'GBP',
      image: 'https://mugs.example.com/mug.jpg',
      url: 'https://mugs.example.com/p/mug',
      description: 'A hand-thrown ceramic mug.',
      availability: 'in stock',
    });
    expect(res.records[0].price.pointer).toBe('/product:price:amount');
    expect(res.records[0].currency.pointer).toBe('/product:price:currency');
  });

  it('sale price is the price; the regular price becomes the original price', () => {
    const res = extractFromStructuredData(
      makeDoc({
        text: 'Mug £12.00 was £18.00',
        items: [og({ ...ogData, 'product:sale_price:amount': '12.00', 'product:sale_price:currency': 'GBP' })],
      }),
      makeSchema([{ name: 'price', type: 'number' }, { name: 'originalPrice', type: 'number' }, 'currency']),
    );
    expect(raws(res.records[0])).toEqual({ price: '12.00', originalPrice: '18.00', currency: 'GBP' });
  });

  it('completes a JSON-LD product with og:image only when OpenGraph describes that product', () => {
    const schema = makeSchema(['name', { name: 'price', type: 'number' }, 'image']);
    const product = ld({ '@type': 'Product', name: 'Ceramic Mug', offers: { price: '18.00', priceCurrency: 'GBP' } });
    const same = extractFromStructuredData(makeDoc({ text: 'Ceramic Mug £18.00', items: [product, og(ogData)] }), schema);
    expect(raws(same.records[0])).toEqual({ name: 'Ceramic Mug', price: '18.00', image: 'https://mugs.example.com/mug.jpg' });
    expect(same.records[0].name.structuredId).toBe('sd0');
    expect(same.records[0].image.structuredId).toBe('sd1');

    const other = extractFromStructuredData(
      makeDoc({ text: 'Ceramic Mug £18.00', items: [product, og({ ...ogData, 'og:title': 'Spring Sale | Mugs & Co', 'og:url': 'https://mugs.example.com/sale' })] }),
      schema,
    );
    expect(raws(other.records[0])).toEqual({ name: 'Ceramic Mug', price: '18.00' });

    const article = extractFromStructuredData(makeDoc({ text: 'Ceramic Mug', items: [product, og({ ...ogData, 'og:type': 'article' })] }), schema);
    expect(raws(article.records[0])).not.toHaveProperty('image');
  });

  it('page-level descriptions never replace the product description', () => {
    const res = extractFromStructuredData(
      makeDoc({ text: 'Ceramic Mug', items: [ld({ '@type': 'Product', name: 'Ceramic Mug' }), og(ogData)] }),
      makeSchema(['name', 'description']),
    );
    expect(raws(res.records[0])).toEqual({ name: 'Ceramic Mug' });
  });
});

describe('embedded app state (__NEXT_DATA__)', () => {
  const nextData = {
    props: {
      pageProps: {
        navigation: { items: [{ title: 'Men' }, { title: 'Women' }] },
        product: {
          id: 'p_123',
          title: 'Trail Shoe',
          slug: 'trail-shoe',
          price: { amount: '89.00', currencyCode: 'USD' },
          compareAtPrice: { amount: '110.00', currencyCode: 'USD' },
          images: [{ url: 'https://cdn.shop.example.com/trail-1.jpg' }, { url: 'https://cdn.shop.example.com/trail-2.jpg' }],
          brand: { name: 'Peak' },
          rating: 4.4,
          reviewCount: 52,
          inStock: true,
        },
      },
    },
    page: '/products/[slug]',
    buildId: 'abc',
  };
  const text = 'Trail Shoe\n\nPeak\n\n$89.00 $110.00\n\n4.4 (52 reviews)\n\nAdd to cart';

  it('finds the product object and reads its own key names', () => {
    const res = extractFromStructuredData(
      makeDoc({ text, items: [embedded(nextData)] }),
      makeSchema([
        'name',
        { name: 'price', type: 'number' },
        { name: 'originalPrice', type: 'number' },
        'currency',
        'brand',
        { name: 'rating', type: 'number' },
        { name: 'reviewCount', type: 'integer' },
        'image',
        { name: 'inStock', type: 'boolean' },
      ]),
    );
    expect(raws(res.records[0])).toEqual({
      name: 'Trail Shoe',
      price: '89.00',
      originalPrice: '110.00',
      currency: 'USD',
      brand: 'Peak',
      rating: 4.4,
      reviewCount: 52,
      image: 'https://cdn.shop.example.com/trail-1.jpg',
      inStock: true,
    });
    const p = '/props/pageProps/product';
    expect(res.records[0].name.pointer).toBe(`${p}/title`);
    expect(res.records[0].price.pointer).toBe(`${p}/price/amount`);
    expect(res.records[0].currency.pointer).toBe(`${p}/price/currencyCode`);
    expect(res.records[0].image.pointer).toBe(`${p}/images/0/url`);
    expect(res.records[0].price.visibleInPage).toBe(true);
  });

  it('ignores an embedded "product" whose name the page does not show', () => {
    const hidden = { props: { pageProps: { product: { title: 'Some Other Shoe', price: 10 } } } };
    const res = extractFromStructuredData(makeDoc({ text: `${text}\n\n${'Lorem ipsum dolor sit amet. '.repeat(10)}`, items: [embedded(hidden)] }), makeSchema(['name', 'price']));
    expect(res.shape).toBeNull();
  });

  it('JSON-LD wins over embedded state for the same product; embedded completes it', () => {
    const res = extractFromStructuredData(
      makeDoc({ text, items: [ld({ '@type': 'Product', name: 'Trail Shoe', offers: { price: '89.00', priceCurrency: 'USD' } }), embedded(nextData)] }),
      makeSchema(['name', { name: 'price', type: 'number' }, { name: 'reviewCount', type: 'integer' }]),
    );
    expect(raws(res.records[0])).toEqual({ name: 'Trail Shoe', price: '89.00', reviewCount: 52 });
    expect(res.records[0].price.structuredId).toBe('sd0');
    expect(res.records[0].reviewCount.structuredId).toBe('sd1');
  });
});
