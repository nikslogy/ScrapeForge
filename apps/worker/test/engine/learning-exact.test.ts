// A recipe is saved and promoted only when it reproduces every grounded
// reference record: a selector that reads the struck-through "was" price of a
// few sale cards must never be served.

import { afterEach, describe, expect, it } from 'vitest';
import { buildSourceDocument } from '../../src/extract/document/index.js';
import { extractStructured, flushRecipeLearning } from '../../src/extract/engine.js';
import type { FakeHandler } from '../../src/extract/llm/index.js';
import { normalizeSchema } from '../../src/extract/schema/index.js';
import type { RecipeStore } from '../../src/extract/recipe/index.js';
import type { RecipeKey, StoredRecipe } from '../../src/extract/types.js';
import { parsePrompt } from '../../../../tests/engine/oracle.js';
import { fakeClient, LISTING_SCHEMA, LISTING_URL, memoryStore, page, request } from './helpers.js';

afterEach(async () => {
  await flushRecipeLearning();
});

interface Snapshot {
  html: string;
  gold: Array<{ title: string; price: number }>;
}

/** Listing of n cards; cards in `sale` show the struck "was" price first, then the current one. */
function snapshot(offset: number, n: number, sale: ReadonlySet<number>): Snapshot {
  const gold: Snapshot['gold'] = [];
  const cards = Array.from({ length: n }, (_, i) => {
    const title = `Gadget Model ${String.fromCharCode(65 + ((i + offset) % 26))}${i + offset}`;
    const price = 19 + (i + offset) * 3;
    gold.push({ title, price });
    const priceHtml = sale.has(i)
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

/** A correct model: the current price is the last "$" amount of the card. */
const saleAwareModel: FakeHandler = (_caps, req) => {
  const prompt = parsePrompt(req);
  const records = prompt.scopes
    .filter((s) => s.kind === 'record')
    .map((s) => {
      const heading = s.blocks.find((b) => b.text.startsWith('### '));
      const priceBlocks = s.blocks.filter((b) => /\$\d/.test(b.text));
      const priceBlock = priceBlocks[priceBlocks.length - 1];
      const amounts = priceBlock ? (priceBlock.text.match(/\$\d[\d.,]*/g) ?? []) : [];
      return {
        title: { v: heading ? heading.text.slice(4) : null, b: heading?.id ?? null },
        price: { v: amounts.length > 0 ? amounts[amounts.length - 1] : null, b: priceBlock?.id ?? null },
      };
    });
  return { text: JSON.stringify({ records }), finishReason: 'stop', inputTokens: 500, outputTokens: 100, costUsd: 0.001, latencyMs: 1 };
};

function keyFor(html: string): RecipeKey {
  return {
    tenantId: 'tenant-1',
    host: new URL(LISTING_URL).hostname,
    templateSignature: buildSourceDocument(html, LISTING_URL).templateSignature,
    schemaHash: normalizeSchema(LISTING_SCHEMA).hash,
  };
}

describe('recipe learning requires exact agreement with every grounded record', () => {
  const cases: Array<[string, number, number[]]> = [
    ['sale cards among the first 20 records', 20, [12, 17]],
    ['one sale card after the first 20 records', 30, [25]],
  ];
  for (const [label, n, saleAt] of cases) {
    it(`never stores or serves a recipe that reads a wrong price (${label})`, async () => {
      const sale = new Set(saleAt);
      const { store } = memoryStore();
      const { client } = fakeClient(saleAwareModel);
      const key = keyFor(snapshot(0, n, sale).html);
      const run = (s: Snapshot) =>
        extractStructured(request(s.html, LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: store, learning: 'await' });

      for (const offset of [0, n, 2 * n, 3 * n]) {
        const s = snapshot(offset, n, sale);
        expect(keyFor(s.html)).toEqual(key);
        const out = await run(s);
        expect(out.status).toBe('complete');
        expect((out.data as { items: unknown[] }).items).toEqual(s.gold);
        // Whatever is stored must reproduce this snapshot's grounded values exactly.
        const stored = await store.get(key);
        if (stored && out.method === 'llm') {
          const replay = await extractStructured(request(s.html, LISTING_SCHEMA, { url: LISTING_URL }), {
            modelClient: null,
            recipeStore: memoryStoreWith(stored),
            learning: 'off',
          });
          expect((replay.data as { items: unknown[] } | null)?.items).toEqual(s.gold);
        }
      }
    });
  }
});

/** A store serving one recipe as active (to replay what learning stored). */
function memoryStoreWith(stored: StoredRecipe): RecipeStore {
  const { store } = memoryStore();
  store.get = async () => ({ ...stored, state: 'active' });
  store.recordUse = async () => null;
  return store;
}
