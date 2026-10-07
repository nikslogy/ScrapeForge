import { describe, expect, it } from 'vitest';
import { buildSourceDocument } from '../../src/extract/document/index.js';
import { templateSignature, urlPathShape } from '../../src/extract/document/template.js';
import { listingPage, productPage } from './fixtures.js';

describe('urlPathShape', () => {
  it('normalizes ids and slugs but keeps stable words', () => {
    expect(urlPathShape('https://books.example.com/catalogue/a-light-in-the-attic_1000/index.html'))
      .toBe('/catalogue/:s/index.html');
    expect(urlPathShape('https://shop.example.com/product/12345')).toBe('/product/:n');
    expect(urlPathShape('https://www.amazon.example/dp/B08N5WRWNW')).toBe('/dp/:s');
    expect(urlPathShape('https://x.test/')).toBe('/');
    expect(urlPathShape('https://x.test/a%20b/%E0%A4')).toBe('/:s/:s');
  });

  it('keeps sorted query keys and drops tracking parameters', () => {
    expect(urlPathShape('https://x.test/search?q=shoes&page=2&utm_source=mail&gclid=abc'))
      .toBe('/search?page&q');
    expect(urlPathShape('https://x.test/index.php?route=product/product&product_id=40'))
      .toBe('/index.php?product_id&route');
  });

  it('returns an empty shape for invalid URLs', () => {
    expect(urlPathShape('not a url')).toBe('');
  });
});

describe('templateSignature', () => {
  it('is equal for two product pages of the same template', () => {
    const a = buildSourceDocument(
      productPage({ name: 'A Light in the Attic', sku: 'a897fe39b1053632', price: '51.77' }),
      'https://books.example.com/catalogue/a-light-in-the-attic_1000/index.html',
    );
    const b = buildSourceDocument(
      productPage({ name: 'Tipping the Velvet', sku: '90fa61229261140a', price: '53.74', slug: 'tipping-the-velvet_999' }),
      'https://books.example.com/catalogue/tipping-the-velvet_999/index.html',
    );
    expect(a.snapshotHash).not.toBe(b.snapshotHash);
    expect(a.templateSignature).toBe(b.templateSignature);
  });

  it('is independent of the host', () => {
    const html = productPage();
    const a = buildSourceDocument(html, 'https://books.example.com/catalogue/x_1/index.html');
    const b = buildSourceDocument(html, 'https://mirror.example.org/catalogue/y_2/index.html');
    expect(a.templateSignature).toBe(b.templateSignature);
  });

  it('is equal for listing pages with different card counts and categories', () => {
    const a = buildSourceDocument(listingPage(20), 'https://books.example.com/catalogue/category/books/mystery_3/index.html');
    const b = buildSourceDocument(listingPage(7, 'catalogue/category/books/travel_2/index.html'), 'https://books.example.com/catalogue/category/books/travel_2/index.html');
    expect(a.templateSignature).toBe(b.templateSignature);
  });

  it('differs between a listing page and a product page', () => {
    const listing = buildSourceDocument(listingPage(20), 'https://books.example.com/catalogue/category/books/mystery_3/index.html');
    const product = buildSourceDocument(productPage(), 'https://books.example.com/catalogue/a-light-in-the-attic_1000/index.html');
    expect(listing.templateSignature).not.toBe(product.templateSignature);
    // Same DOM under a different URL shape also differs.
    const moved = buildSourceDocument(productPage(), 'https://books.example.com/p/12');
    expect(moved.templateSignature).not.toBe(product.templateSignature);
  });

  it('ignores UI state classes and digits in class names', () => {
    const page = (cls: string): string => `<html><body><div class="${cls}"><ul class="col-md-${cls.length}"><li>x</li></ul></div></body></html>`;
    const a = buildSourceDocument(page('active wrapper'), 'https://x.test/p/1');
    const b = buildSourceDocument(page('wrapper'), 'https://x.test/p/2');
    expect(a.templateSignature).toBe(b.templateSignature);
    expect(templateSignature('https://x.test/', ['b', 'a', 'a'])).toBe(templateSignature('https://x.test/', ['a', 'b']));
  });
});
