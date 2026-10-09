// A recipe is saved and promoted only when it reproduces every grounded
// reference value: one wrong value in a listing is enough to reject it.

import { describe, expect, it } from 'vitest';
import { compareOutputs, valuesMatch } from '../../src/extract/recipe/compare.js';
import { extractStructured, flushRecipeLearning } from '../../src/extract/index.js';
import { buildSourceDocument } from '../../src/extract/document/index.js';
import { normalizeSchema } from '../../src/extract/schema/index.js';
import type { FakeHandler } from '../../src/extract/llm/index.js';
import { fakeClient, LISTING_SCHEMA, LISTING_URL, memoryStore, page, request } from '../engine/helpers.js';
import { parsePrompt } from '../../../../tests/engine/oracle.js';

const FIELDS = ['title', 'price'];

function records(n: number, mutate?: (r: Record<string, unknown>, i: number) => void): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => {
    const r: Record<string, unknown> = { title: `Gadget ${i}`, price: 19 + i * 3 };
    mutate?.(r, i);
    return r;
  });
}

describe('compareOutputs requires exact agreement', () => {
  it('rejects a listing with 2 wrong values out of 40', () => {
    const recipe = records(20, (r, i) => {
      if (i === 12 || i === 17) r.price = (r.price as number) + 10;
    });
    const r = compareOutputs(recipe, records(20), FIELDS);
    expect(r.agree).toBe(false);
    expect(r.fieldAgreement).toBeCloseTo(38 / 40);
    expect(r.details).toContain('/12/price: 65 vs 55');
  });

  it('numbers must be equal, not merely close', () => {
    expect(compareOutputs({ price: 1299 }, { price: 1299.99 }, ['price']).agree).toBe(false);
    expect(compareOutputs({ price: '$1,299.99' }, { price: 1299.99 }, ['price']).agree).toBe(true);
    expect(valuesMatch(0.1 + 0.2, 0.3)).toBe(true);
    expect(valuesMatch(100, 100.4)).toBe(false);
  });

  it('compares every record, not only the first ones', () => {
    const recipe = records(60, (r, i) => {
      if (i === 55) r.title = 'garbage';
    });
    expect(compareOutputs(recipe, records(60), FIELDS).agree).toBe(false);
  });

  it('an unpaired record with values is a disagreement; empty unpaired records are ignored', () => {
    expect(compareOutputs(records(21), records(20), FIELDS).agree).toBe(false);
    expect(compareOutputs(records(18), records(20), FIELDS).agree).toBe(false);
    expect(compareOutputs([...records(20), { title: null, price: null }], records(20), FIELDS).agree).toBe(true);
  });
});

// Listing where cards 12 and 17 are on sale: the struck "was" price comes first.
function saleListing(offset: number): { html: string; gold: Array<{ title: string; price: number }> } {
  const gold: Array<{ title: string; price: number }> = [];
  const cards = Array.from({ length: 20 }, (_, i) => {
    const title = `Gadget Model ${String.fromCharCode(65 + ((i + offset) % 26))}${i + offset}`;
    const price = 19 + (i + offset) * 3;
    const sale = i === 12 || i === 17;
    gold.push({ title, price });
    const priceHtml = sale
      ? `<p class="price"><span class="amount was">$${(price + 10).toFixed(2)}</span> <span class="amount">$${price.toFixed(2)}</span></p>`
      : `<p class="price"><span class="amount">$${price.toFixed(2)}</span></p>`;
    return `<li class="card"><article class="product"><h3><a href="/p/${i}">${title}</a></h3>${priceHtml}<button>Add to cart</button></article></li>`;
  }).join('');
  const html = page(
    `<header><a href="/">Gadget Store</a></header><main><h1>All gadgets</h1><ul class="grid">${cards}</ul></main><footer><p>© 2026 Gadget Store</p></footer>`,
    '<title>All gadgets | Gadget Store</title>',
  );
  return { html, gold };
}

// Correct model: the current price is the last "$" amount in the card.
const saleModel: FakeHandler = (_caps, req) => {
  const prompt = parsePrompt(req);
  const recs = prompt.scopes
    .filter((s) => s.kind === 'record')
    .map((s) => {
      const heading = s.blocks.find((b) => b.text.startsWith('### '));
      const priceBlocks = s.blocks.filter((b) => /\$\d/.test(b.text));
      const priceBlock = priceBlocks[priceBlocks.length - 1];
      const amounts = priceBlock?.text.match(/\$\d[\d.,]*/g) ?? [];
      return {
        title: { v: heading?.text.slice(4) ?? null, b: heading?.id ?? null },
        price: { v: amounts.length ? amounts[amounts.length - 1] : null, b: priceBlock?.id ?? null },
      };
    });
  return { text: JSON.stringify({ records: recs }), finishReason: 'stop', inputTokens: 500, outputTokens: 100, costUsd: 0.001, latencyMs: 1 };
};

describe('recipe learning on a listing with a few sale cards', () => {
  it('never saves or promotes a recipe that reads the struck-through price', async () => {
    const { store } = memoryStore();
    const { client } = fakeClient(saleModel);
    const first = saleListing(0);
    const key = {
      tenantId: 'tenant-1',
      host: new URL(LISTING_URL).hostname,
      templateSignature: buildSourceDocument(first.html, LISTING_URL).templateSignature,
      schemaHash: normalizeSchema(LISTING_SCHEMA).hash,
    };
    for (const offset of [0, 20, 40]) {
      const s = saleListing(offset);
      const out = await extractStructured(request(s.html, LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: store, learning: 'await' });
      expect(out.method).toBe('llm');
      const stored = await store.get(key);
      // Any stored recipe must reproduce the grounded sale prices.
      if (stored) expect(JSON.stringify(stored.recipe.fields.price)).not.toBe(JSON.stringify({ selector: 'span.amount' }));
    }
    const s = saleListing(60);
    const out = await extractStructured(request(s.html, LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: store, learning: 'await' });
    const got = (out.data as { items: Array<{ title: string; price: number }> }).items;
    expect(got.map((r) => r.price)).toEqual(s.gold.map((g) => g.price));
    await flushRecipeLearning();
  });
});
