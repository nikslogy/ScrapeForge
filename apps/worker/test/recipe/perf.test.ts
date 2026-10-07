import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { runRecipe } from '../../src/extract/recipe/run.js';
import { validateRecipe } from '../../src/extract/recipe/validate.js';
import type { ExtractionRecipe } from '../../src/extract/types.js';
import { BASE_URL, books, listingHtml } from './fixtures.js';

function recipe(fields: Record<string, unknown>, recordSelector = 'article.product_pod'): ExtractionRecipe {
  const r = validateRecipe({ version: 1, shape: 'array', recordSelector, fields });
  if (!r.ok) throw new Error(r.errors.join());
  return r.recipe;
}

describe('runRecipe performance', () => {
  const items = books(5_000);
  const html = listingHtml(items);
  const $ = cheerio.load(html);

  it('extracts 5,000 records × 5 fields in under 1 s', () => {
    const r = recipe({
      title: { selector: 'h3 a', attr: 'title' },
      price: { selector: 'p.price_color', transforms: ['parse-number'] },
      inStock: { selector: 'p.availability', transforms: ['parse-boolean'] },
      rating: { selector: 'p.star-rating', attr: 'class', transforms: [{ regex: 'star-rating\\s+(\\S+)' }, { map: { one: 1, two: 2, three: 3, four: 4, five: 5 } }] },
      url: { selector: 'h3 a', attr: 'href', transforms: ['absolute-url'] },
    });
    runRecipe(r, { $ }, { baseUrl: BASE_URL, maxRecords: 50 }); // warm-up
    const start = performance.now();
    const out = runRecipe(r, { $ }, { baseUrl: BASE_URL });
    const ms = performance.now() - start;
    expect(out.errors).toEqual([]);
    expect(out.recordCount).toBe(5_000);
    expect(out.evidence).toHaveLength(25_000);
    const last = (out.data as Array<Record<string, unknown>>)[4_999];
    expect(last.title).toBe(items[4_999].title);
    expect(ms).toBeLessThan(1_000);
  });

  it('selectors outside the fast subset also stay under 1 s', () => {
    const r = recipe({
      title: { selector: 'h3 > a:not(.x)', attr: 'title' },
      price: { selector: 'div.product_price :is(p.price_color)', transforms: ['parse-number'] },
    });
    const start = performance.now();
    const out = runRecipe(r, { $ }, { baseUrl: BASE_URL });
    expect(out.recordCount).toBe(5_000);
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it('descendant selectors stay linear on a hostile 10,000-deep DOM', () => {
    const depth = 10_000;
    const deep = cheerio.load(`<section class="r">${'<div>'.repeat(depth)}<p>x</p>${'</div>'.repeat(depth)}</section>`);
    for (const selector of ['ul div div div div p', 'div div div div div', 'section div p', '> div div > div p']) {
      const start = performance.now();
      const out = runRecipe(recipe({ a: { selector, all: true } }, 'section.r'), { $: deep }, { baseUrl: BASE_URL });
      expect(out.recordCount, selector).toBe(1);
      expect(performance.now() - start, selector).toBeLessThan(1_000);
    }
  });

  it('a 5,001st record is cut by the default maxRecords', () => {
    const more = `${html.slice(0, html.lastIndexOf('</ol>'))}<li><article class="product_pod"><h3><a title="extra">extra</a></h3></article></li></ol>`;
    const out = runRecipe(recipe({ title: { selector: 'h3 a', attr: 'title' } }), { html: more }, { baseUrl: BASE_URL });
    expect(out.recordCount).toBe(5_000);
    expect(out.errors[0]).toMatch(/maxRecords reached: 5001 records matched/);
  });
});
