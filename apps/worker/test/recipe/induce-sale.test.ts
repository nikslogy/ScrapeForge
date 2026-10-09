// Induction on listings where a few cards show a struck-through "was" price
// before the current one: the recipe must reproduce every sample value (the
// engine accepts a recipe only on exact agreement), so it has to pick a
// selector that tells the current price from the struck one, or none at all.

import { describe, expect, it } from 'vitest';
import { induceRecipe, MIN_INDUCTION_COVERAGE } from '../../src/extract/recipe/induce.js';
import { runRecipe } from '../../src/extract/recipe/run.js';

const BASE = 'https://shop.example/';
const SALE = (i: number): boolean => i % 7 === 5;

type Style = 'class' | 'del-ins' | 'del-ins-visible' | 'inline-style';

function priceHtml(style: Style, price: string, was: string, sale: boolean): string {
  if (style === 'del-ins' || style === 'del-ins-visible') {
    // WooCommerce markup: both amounts share the same classes; only <del>/<ins> differ.
    const amount = (v: string): string => `<span class="woocommerce-Price-amount amount"><bdi>${v}</bdi></span>`;
    const del = style === 'del-ins' ? '<del aria-hidden="true">' : '<del>';
    return sale
      ? `<span class="price">${del}${amount(was)}</del> <ins>${amount(price)}</ins></span>`
      : `<span class="price">${amount(price)}</span>`;
  }
  if (style === 'inline-style') {
    return sale
      ? `<div class="cost"><span class="amount" style="text-decoration: line-through">${was}</span> <span class="amount">${price}</span></div>`
      : `<div class="cost"><span class="amount">${price}</span></div>`;
  }
  return sale
    ? `<p class="price"><span class="amount was">${was}</span> <span class="amount">${price}</span></p>`
    : `<p class="price"><span class="amount">${price}</span></p>`;
}

function listing(style: Style, n: number, offset = 0, sale = SALE): { html: string; gold: Array<{ title: string; price: string }> } {
  const gold: Array<{ title: string; price: string }> = [];
  const cards = Array.from({ length: n }, (_, i) => {
    const k = i + offset;
    const title = `Gadget Model ${String.fromCharCode(65 + (k % 26))}${k}`;
    const price = `$${(19 + k * 3).toFixed(2)}`;
    const was = `$${(29 + k * 3).toFixed(2)}`;
    gold.push({ title, price });
    return `<li class="card"><article class="product"><h3><a href="/p/${k}">${title}</a></h3>${priceHtml(style, price, was, sale(i))}<button>Add to cart</button></article></li>`;
  }).join('');
  return { html: `<html><body><main><h1>All gadgets</h1><ul class="grid">${cards}</ul></main></body></html>`, gold };
}

describe('induceRecipe: listings with struck-through prices', () => {
  it('requires every sample value to be reproduced', () => {
    expect(MIN_INDUCTION_COVERAGE).toBe(1);
  });

  // The selector the refinement should settle on (null: any selector that works).
  const expected: Record<Style, RegExp | null> = {
    class: /^span\.amount:not\(\.was\)$/,
    // <del aria-hidden> is not page text, so a plain selector already works.
    'del-ins': null,
    'del-ins-visible': /:not\(del \*\)$/,
    'inline-style': /:not\(\[style\*="line-through" i\]\)$/,
  };

  for (const style of ['class', 'del-ins', 'del-ins-visible', 'inline-style'] as const) {
    it(`picks a selector that skips the "was" price (${style})`, () => {
      const page = listing(style, 20);
      const r = induceRecipe({ html: page.html, baseUrl: BASE, shape: 'array', recordSelector: 'li.card', samples: page.gold, fieldNames: ['title', 'price'] });
      expect(r.coverage).toBe(1);
      expect(r.recipe).not.toBeNull();
      if (expected[style]) expect(r.recipe!.fields.price.selector).toMatch(expected[style]!);
      // Generalizes to another page whose sale cards sit elsewhere.
      const other = listing(style, 30, 40, (i) => i % 4 === 1);
      expect(runRecipe(r.recipe!, { html: other.html }, { baseUrl: BASE }).data).toEqual(other.gold);
    });
  }

  it('also works when the first sample record is itself on sale', () => {
    const page = listing('class', 20, 0, (i) => i % 6 === 0);
    const r = induceRecipe({ html: page.html, baseUrl: BASE, shape: 'array', recordSelector: 'li.card', samples: page.gold, fieldNames: ['title', 'price'] });
    expect(r.coverage).toBe(1);
    expect(r.recipe!.fields.price.selector).toBe('span.amount:not(.was)');
    expect(runRecipe(r.recipe!, { html: page.html }, { baseUrl: BASE }).data).toEqual(page.gold);
  });

  it('returns no recipe when one sample value cannot be reproduced', () => {
    const page = listing('class', 20, 0, () => false);
    // 39 of 40 values reproducible (97.5%): still no recipe, the engine would reject it anyway.
    const samples = page.gold.map((g, i) => (i === 13 ? { ...g, price: '$1.00' } : g));
    const r = induceRecipe({ html: page.html, baseUrl: BASE, shape: 'array', recordSelector: 'li.card', samples, fieldNames: ['title', 'price'] });
    expect(r.recipe).toBeNull();
    expect(r.coverage).toBeGreaterThan(0.9);
    expect(r.coverage).toBeLessThan(1);
    expect(r.notes.join()).toMatch(/coverage/);
  });
});
