import { describe, expect, it } from 'vitest';
import { induceRecipe } from '../../src/extract/recipe/induce.js';
import { runRecipe } from '../../src/extract/recipe/run.js';
import { validateRecipe } from '../../src/extract/recipe/validate.js';
import { BASE_URL, books, listingHtml, listingSample, PDP_URL, pdpHtml, pdpSample } from './fixtures.js';

const LISTING_FIELDS = ['title', 'price', 'availability', 'rating', 'url'];
const PDP_FIELDS = ['title', 'price', 'rating', 'upc', 'stock', 'description'];

describe('induceRecipe: 20-card listing', () => {
  const items = books(20);
  const html = listingHtml(items);
  const samples = items.slice(0, 5).map((b) => listingSample(b));

  it('induces a recipe that reproduces every sample and generalizes to all cards', () => {
    const r = induceRecipe({ html, baseUrl: BASE_URL, shape: 'array', recordSelector: 'article.product_pod', samples, fieldNames: LISTING_FIELDS });
    expect(r.coverage).toBe(1);
    expect(r.recipe).not.toBeNull();
    const recipe = r.recipe!;
    expect(validateRecipe(recipe, LISTING_FIELDS).ok).toBe(true);
    expect(recipe.recordSelector).toBe('article.product_pod');
    // Star rating comes from a class token, through a regex.
    expect(recipe.fields.rating).toMatchObject({ attr: 'class', transforms: [{ regex: expect.stringContaining('star-rating') }] });
    expect(recipe.fields.url).toMatchObject({ attr: 'href', transforms: ['absolute-url'] });
    // The title text is truncated on the card; the full title is in the title attribute.
    expect(recipe.fields.title).toMatchObject({ attr: 'title' });
    // Availability must cover the out-of-stock card (index 3), so not "p.instock".
    expect(recipe.fields.availability.selector).not.toContain('instock');

    const out = runRecipe(recipe, { html }, { baseUrl: BASE_URL });
    expect(out.recordCount).toBe(20);
    expect(out.data).toEqual(items.map((b) => listingSample(b)));
  });

  it('works on another page of the same template', () => {
    const r = induceRecipe({ html, baseUrl: BASE_URL, shape: 'array', recordSelector: 'article.product_pod', samples, fieldNames: LISTING_FIELDS });
    const page2Items = books(40).slice(20);
    const page2 = listingHtml(page2Items);
    const out = runRecipe(r.recipe!, { html: page2 }, { baseUrl: BASE_URL });
    expect(out.data).toEqual(page2Items.map((b) => listingSample(b)));
  });

  it('infers the records when no record selector is given', () => {
    const r = induceRecipe({ html, baseUrl: BASE_URL, shape: 'array', samples: samples.slice(0, 3), fieldNames: LISTING_FIELDS });
    expect(r.coverage).toBe(1);
    expect(r.recipe?.recordSelector).toBe('article.product_pod');
    expect(runRecipe(r.recipe!, { html }, { baseUrl: BASE_URL }).recordCount).toBe(20);
  });

  it('shortens a long positional record selector hint to a stable one', () => {
    const hint = 'html > body > div > div > div:nth-child(2) > div:nth-child(2) > section > div > ol > li';
    const r = induceRecipe({ html, baseUrl: BASE_URL, shape: 'array', recordSelector: hint, samples, fieldNames: LISTING_FIELDS });
    expect(r.coverage).toBe(1);
    expect(r.recipe?.recordSelector).toBe('li.col-xs-6');
  });

  it('handles null sample values and fields with no values', () => {
    const withNulls = samples.map((s, i) => ({ ...s, rating: i === 1 ? null : s.rating, isbn: null }));
    const r = induceRecipe({ html, baseUrl: BASE_URL, shape: 'array', recordSelector: 'article.product_pod', samples: withNulls, fieldNames: [...LISTING_FIELDS, 'isbn'] });
    expect(r.coverage).toBe(1);
    expect(r.recipe?.fields.isbn).toBeUndefined();
    expect(r.notes).toContain('field "isbn": no sample values');
  });

  it('returns no recipe below 90% coverage', () => {
    const wrong = samples.map((s, i) => ({ ...s, price: i < 2 ? s.price : '£999.99', availability: i < 2 ? s.availability : 'Ships in 3 weeks' }));
    const r = induceRecipe({ html, baseUrl: BASE_URL, shape: 'array', recordSelector: 'article.product_pod', samples: wrong, fieldNames: LISTING_FIELDS });
    expect(r.recipe).toBeNull();
    expect(r.coverage).toBeLessThan(0.9);
    expect(r.notes.join()).toMatch(/coverage/);
  });

  it('fails cleanly on bad inputs', () => {
    expect(induceRecipe({ html, baseUrl: BASE_URL, shape: 'array', recordSelector: 'article.product_pod', samples: [], fieldNames: LISTING_FIELDS })).toMatchObject({ recipe: null, coverage: 0 });
    expect(induceRecipe({ html, baseUrl: BASE_URL, shape: 'array', recordSelector: 'article.product_pod', samples, fieldNames: [] }).recipe).toBeNull();
    expect(induceRecipe({ html, baseUrl: BASE_URL, shape: 'array', recordSelector: 'li:::bad', samples, fieldNames: LISTING_FIELDS }).notes.join()).toMatch(/does not compile/);
    expect(induceRecipe({ html, baseUrl: BASE_URL, shape: 'array', recordSelector: 'table.none', samples, fieldNames: LISTING_FIELDS }).notes.join()).toMatch(/matched nothing/);
    expect(induceRecipe({ html: '', baseUrl: BASE_URL, shape: 'array', samples, fieldNames: LISTING_FIELDS }).recipe).toBeNull();
    const nothing = induceRecipe({ html, baseUrl: BASE_URL, shape: 'object', samples: [{ title: 'Not on this page at all' }], fieldNames: ['title'] });
    expect(nothing).toMatchObject({ recipe: null, coverage: 0 });
  });
});

describe('induceRecipe: product page', () => {
  it('derives selectors, a class-token regex for the rating and a regex for "Price: £51.77"', () => {
    const r = induceRecipe({ html: pdpHtml(), baseUrl: PDP_URL, shape: 'object', samples: [pdpSample()], fieldNames: PDP_FIELDS });
    expect(r.coverage).toBe(1);
    const recipe = r.recipe!;
    expect(recipe.shape).toBe('object');
    expect(recipe.fields.title.selector).toBe('h1');
    expect(recipe.fields.price).toMatchObject({ selector: 'p.price', transforms: [{ regex: expect.stringMatching(/^Price:/) }] });
    expect(recipe.fields.rating).toMatchObject({ attr: 'class', transforms: [{ regex: expect.stringContaining('star-rating') }] });
    expect(recipe.fields.description.selector).toBe('#product_description + p');
    expect(recipe.fields.stock.transforms).toHaveLength(1);

    const other = { title: 'Tipping the Velvet', price: '£1,053.74', rating: 'One', upc: '90fa61229261140a', stock: 7 };
    const out = runRecipe(recipe, { html: pdpHtml(other) }, { baseUrl: PDP_URL });
    expect(out.data).toEqual(pdpSample(other));
  });

  it('prefers page content over <title>, meta tags and breadcrumbs for the same text', () => {
    const r = induceRecipe({ html: pdpHtml(), baseUrl: PDP_URL, shape: 'object', samples: [{ title: 'A Light in the Attic' }], fieldNames: ['title'] });
    expect(r.recipe?.fields.title).toEqual({ selector: 'h1' });
  });

  it('only uses the first sample for object shape', () => {
    const r = induceRecipe({ html: pdpHtml(), baseUrl: PDP_URL, shape: 'object', samples: [pdpSample(), { title: 'zzz' }], fieldNames: ['title'] });
    expect(r.coverage).toBe(1);
    expect(r.notes).toContain('object shape: only the first sample is used');
  });
});

describe('induceRecipe: other markup', () => {
  it('ignores hashed CSS-in-JS classes and uses stable attributes', () => {
    const cards = Array.from({ length: 6 }, (_, i) => `
      <div class="css-1x2y3z sc-AxjAm" data-testid="product-card">
        <span class="css-9q8w7e" itemprop="name">Gadget ${i}</span>
        <span class="Price_root__a1B2c">$${i + 1}.99</span>
        <a class="jsx-123456" href="/p/${i}" data-sku="SKU-${1000 + i}">view</a>
      </div>`).join('');
    const html = `<html><body><main><section class="grid">${cards}</section></main></body></html>`;
    const samples = Array.from({ length: 3 }, (_, i) => ({ name: `Gadget ${i}`, price: `$${i + 1}.99`, sku: `SKU-${1000 + i}` }));
    const r = induceRecipe({ html, baseUrl: 'https://shop.example/', shape: 'array', samples, fieldNames: ['name', 'price', 'sku'] });
    expect(r.coverage).toBe(1);
    const json = JSON.stringify(r.recipe);
    expect(json).not.toMatch(/css-|sc-|jsx-|Price_root/);
    expect(r.recipe?.recordSelector).toBe('div[data-testid="product-card"]');
    expect(r.recipe?.fields.name.selector).toBe('span[itemprop="name"]');
    expect(r.recipe?.fields.sku).toMatchObject({ attr: 'data-sku' });
    expect(runRecipe(r.recipe!, { html }, { baseUrl: 'https://shop.example/' }).recordCount).toBe(6);
  });

  it('handles a table listing with a header row', () => {
    const rows = Array.from({ length: 8 }, (_, i) => `<tr><td>Item ${i}</td><td>${(i + 1) * 3} pcs</td><td>€${i},50</td></tr>`).join('');
    const html = `<html><body><table id="stock"><tr><th>Name</th><th>Qty</th><th>Price</th></tr>${rows}</table></body></html>`;
    const samples = [0, 1, 2].map((i) => ({ name: `Item ${i}`, qty: String((i + 1) * 3), price: `€${i},50` }));
    const r = induceRecipe({ html, baseUrl: 'https://x.example/', shape: 'array', samples, fieldNames: ['name', 'qty', 'price'] });
    expect(r.coverage).toBe(1);
    const out = runRecipe(r.recipe!, { html }, { baseUrl: 'https://x.example/' });
    expect(out.recordCount).toBe(8);
    expect((out.data as Array<Record<string, unknown>>)[7]).toEqual({ name: 'Item 7', qty: '24', price: '€7,50' });
  });

  it('reads meta content and datetime attributes', () => {
    const html = `<html><head><meta property="og:site_name" content="Example News"></head><body>
      <article><h1>Big story</h1><time datetime="2026-10-07T09:00:00Z">Today</time></article></body></html>`;
    const r = induceRecipe({ html, baseUrl: 'https://news.example/', shape: 'object', samples: [{ site: 'Example News', published: '2026-10-07T09:00:00Z' }], fieldNames: ['site', 'published'] });
    expect(r.coverage).toBe(1);
    expect(r.recipe?.fields.site).toMatchObject({ attr: 'content' });
    expect(r.recipe?.fields.published).toMatchObject({ selector: 'time[datetime]', attr: 'datetime' });
  });

  it('is not fooled by adversarial sample values', () => {
    const html = pdpHtml();
    const hostile = [{ title: '<script>alert(1)</script>', price: '(a+)+$', rating: '"; process.exit(1); "' }];
    const r = induceRecipe({ html, baseUrl: PDP_URL, shape: 'object', samples: hostile, fieldNames: ['title', 'price', 'rating'] });
    expect(r.recipe).toBeNull();
    const long = induceRecipe({ html, baseUrl: PDP_URL, shape: 'object', samples: [{ title: 'x'.repeat(100_000) }], fieldNames: ['title'] });
    expect(long.recipe).toBeNull();
  });

  it('stays fast on a large page', () => {
    const items = books(400);
    const html = listingHtml(items);
    const start = performance.now();
    const r = induceRecipe({ html, baseUrl: BASE_URL, shape: 'array', samples: items.slice(0, 10).map((b) => listingSample(b)), fieldNames: LISTING_FIELDS });
    expect(r.coverage).toBe(1);
    expect(performance.now() - start).toBeLessThan(5_000);
  });
});
