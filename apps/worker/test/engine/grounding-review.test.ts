// Grounding by meaning, after the adversarial review of the benchmark fixes:
// - only the block's own words (or an attribute named for the field) can
//   contradict a yes/no answer; data-index="0" or data-quantity="1" cannot;
// - a cited table is read once: the row the answer names by its distinctive
//   values, the column whose header names the field (exact names first), and
//   in a "Spec | Value" table the row whose label names the field;
// - an uncited number found elsewhere on the page must itself be distinctive.

import { describe, expect, it } from 'vitest';
import { buildSourceDocument } from '../../src/extract/document/index.js';
import { extractStructured } from '../../src/extract/engine.js';
import { CircuitBreaker, FakeProvider, fakeCaps, ModelClient } from '../../src/extract/llm/index.js';
import type { ExtractionOutcome, SourceDocument } from '../../src/extract/types.js';

type Answer = Record<string, { v: unknown; b: string | null }>;

async function run(html: string, schema: unknown, records: Answer[]): Promise<ExtractionOutcome> {
  const provider = new FakeProvider(() => ({ text: JSON.stringify({ records }), finishReason: 'stop', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 }));
  const client = new ModelClient({ models: [fakeCaps()], providers: { fake: provider }, breaker: new CircuitBreaker() });
  return extractStructured(
    { html, url: 'https://shop.example/', schema, tenantId: 't', deadlineMs: Date.now() + 60_000, includeEvidence: true, disable: ['structured', 'recipe'] },
    { modelClient: client, recipeStore: null, learning: 'off' },
  );
}

function blockWith(doc: SourceDocument, text: string, from = 0): string {
  const hit = doc.blocks.slice(from).find((b) => b.text === text);
  if (!hit) throw new Error(`no block with ${JSON.stringify(text)}`);
  return hit.id;
}

function reasonAt(outcome: ExtractionOutcome, path: string): string | undefined {
  return outcome.missing.find((m) => m.path === path)?.reason;
}

describe('yes/no answers on cards with markup attributes', () => {
  // WooCommerce markup: data-index on every card, data-quantity="1" on every button.
  const card = (i: number, name: string, stock: boolean) =>
    `<li class="product type-product post-${i} ${stock ? 'instock' : 'outofstock'}" data-index="${i}">` +
    `<a href="/p/${i}" class="woocommerce-LoopProduct-link"><h2>${name}</h2></a>` +
    `<span class="price">$${10 + i}.00</span>` +
    `<p class="stock ${stock ? 'in-stock' : 'out-of-stock'}">${stock ? 'In stock' : 'Out of stock'}</p>` +
    `<a href="/?add-to-cart=${i}" data-quantity="1" data-product_id="${i}" class="button">Read more</a></li>`;
  const html = `<html><body><main><h1>Shop</h1><ul class="products">${[card(0, 'Alpha', true), card(1, 'Beta', false), card(2, 'Gamma', true), card(3, 'Delta', false)].join('')}</ul></main></body></html>`;
  const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, inStock: { type: 'boolean' } } } } } };
  const doc = buildSourceDocument(html, 'https://shop.example/');

  async function answer(name: string, inStock: boolean, cite: string) {
    const outcome = await run(html, schema, [{ name: { v: name, b: blockWith(doc, name) }, inStock: { v: inStock, b: cite } }]);
    return { outcome, value: (outcome.data as { items: Array<{ inStock?: boolean | null }> }).items[0]?.inStock ?? null };
  }

  it('"Out of stock" with data-quantity="1" and data-index="1" on the card: false is grounded', async () => {
    const r = await answer('Beta', false, blockWith(doc, 'Out of stock'));
    expect(r.value).toBe(false);
    expect(reasonAt(r.outcome, '/items/0/inStock')).toBeUndefined();
  });

  it('"In stock" with data-index="0" on the card: true is grounded', async () => {
    const r = await answer('Alpha', true, blockWith(doc, 'In stock'));
    expect(r.value).toBe(true);
  });

  it('the block\'s own words still contradict a wrong answer', async () => {
    const r = await answer('Beta', true, blockWith(doc, 'Out of stock'));
    expect(r.value).toBeNull();
    expect(reasonAt(r.outcome, '/items/0/inStock')).toBe('rejected_ungrounded');
  });

  it('a bare "1" in an unrelated attribute confirms nothing', async () => {
    // Cites Beta's "Read more" button: data-quantity="1" and data-index="1"
    // are no evidence of stock (and the card's "outofstock" class says otherwise).
    const r = await answer('Beta', true, blockWith(doc, 'Read more', doc.blocks.findIndex((b) => b.text === 'Beta')));
    expect(r.value).toBeNull();
    expect(reasonAt(r.outcome, '/items/0/inStock')).toBe('rejected_ungrounded');
  });

  it('an attribute named for the field confirms, and contradicts', async () => {
    const page = (flag: string) =>
      `<html><body><main><h1>Lamp</h1><p class="sku" data-in-stock="${flag}">Model L2, oak finish</p><p>Free returns</p></main></body></html>`;
    const objSchema = { type: 'object', properties: { inStock: { type: 'boolean' } } };
    const cite = (h: string) => blockWith(buildSourceDocument(h, 'https://shop.example/'), 'Model L2, oak finish');
    const yes = page('true');
    expect((await run(yes, objSchema, [{ inStock: { v: true, b: cite(yes) } }])).data).toMatchObject({ inStock: true });
    const no = page('false');
    const wrong = await run(no, objSchema, [{ inStock: { v: true, b: cite(no) } }]);
    expect(reasonAt(wrong, '/inStock')).toBe('rejected_ungrounded');
  });
});

describe('a cited table', () => {
  const table = (head: string[], rows: string[][]) =>
    `<html><body><main><h1>Compare</h1><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>` +
    rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') +
    '</tbody></table></main></body></html>';
  const listSchema = (props: Record<string, string>) => ({
    type: 'object',
    properties: { items: { type: 'array', items: { type: 'object', properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])) } } },
  });
  const tableId = (html: string) => buildSourceDocument(html, 'https://shop.example/').blocks.find((b) => b.kind === 'table')!.id;

  it('the exact header wins over a longer one containing it ("Warranty", not "Extended warranty")', async () => {
    const html = table(['Model', 'Extended warranty', 'Warranty'], [['Aero', 'No', 'Yes'], ['Brio', 'Yes', 'No'], ['Cleo', 'No', 'No']]);
    const t = tableId(html);
    const schema = listSchema({ model: 'string', warranty: 'boolean' });
    const right = await run(html, schema, [{ model: { v: 'Aero', b: t }, warranty: { v: true, b: t } }, { model: { v: 'Brio', b: t }, warranty: { v: false, b: t } }]);
    expect(right.data).toMatchObject({ items: [{ model: 'Aero', warranty: true }, { model: 'Brio', warranty: false }] });
    const wrong = await run(html, schema, [{ model: { v: 'Aero', b: t }, warranty: { v: false, b: t } }]);
    expect(reasonAt(wrong, '/items/0/warranty')).toBe('rejected_ungrounded');
  });

  it('a value shared by several rows (the brand) does not hide the row the model names', async () => {
    const html = table(['Model', 'Brand', '5G'], [['Nova X1', 'Acme', 'Yes'], ['Nova X2', 'Acme', 'No'], ['Orbis', 'Zeta', 'No']]);
    const t = tableId(html);
    const outcome = await run(html, listSchema({ model: 'string', brand: 'string', has5g: 'boolean' }), [
      { model: { v: 'Nova X1', b: t }, brand: { v: 'Acme', b: t }, has5g: { v: true, b: t } },
      { model: { v: 'Nova X2', b: t }, brand: { v: 'Acme', b: t }, has5g: { v: false, b: t } },
    ]);
    expect(outcome.data).toMatchObject({ items: [{ has5g: true }, { has5g: false }] });
  });

  it('a two-column listing table is read by its header, not as "Spec | Value"', async () => {
    const html = table(['Model', '5G'], [['Nova X1', 'Yes'], ['Orbis', 'No'], ['Pixel', 'No']]);
    const t = tableId(html);
    const outcome = await run(html, listSchema({ model: 'string', has5g: 'boolean' }), [{ model: { v: 'Nova X1', b: t }, has5g: { v: true, b: t } }]);
    expect(outcome.data).toMatchObject({ items: [{ has5g: true }] });
  });

  it('a "Spec | Value" table: the row whose label names the field, not the row naming the product', async () => {
    const html =
      '<html><body><main><h1>Aero 14</h1><table><tbody>' +
      '<tr><th>Model</th><td>Aero 14</td></tr><tr><th>Bluetooth</th><td>Yes</td></tr><tr><th>NFC</th><td>No</td></tr><tr><th>Weight</th><td>3.09 lb</td></tr>' +
      '</tbody></table></main></body></html>';
    const t = tableId(html);
    const schema = { type: 'object', properties: { name: { type: 'string' }, hasNfc: { type: 'boolean' }, bluetooth: { type: 'boolean' } } };
    const outcome = await run(html, schema, [{ name: { v: 'Aero 14', b: t }, hasNfc: { v: false, b: t }, bluetooth: { v: true, b: t } }]);
    expect(outcome.data).toMatchObject({ name: 'Aero 14', hasNfc: false, bluetooth: true });
    const wrong = await run(html, schema, [{ name: { v: 'Aero 14', b: t }, hasNfc: { v: true, b: t } }]);
    expect(reasonAt(wrong, '/hasNfc')).toBe('rejected_ungrounded');
  });

  it('a large table is indexed once: 1,500 rows × 2 yes/no columns, every record citing it', async () => {
    const rows = Array.from({ length: 1_500 }, (_, i) => [`Part ${i}`, `SKU-${100_000 + i}`, i % 2 ? 'Yes' : 'No', i % 3 ? 'Yes' : 'No']);
    const html = table(['Part', 'SKU', 'In stock', 'Refurbished'], rows);
    const t = tableId(html);
    const records = rows.map(([part, sku, stock, refurb]) => ({
      part: { v: part, b: t },
      sku: { v: sku, b: t },
      inStock: { v: stock === 'Yes', b: t },
      refurbished: { v: refurb === 'Yes', b: t },
    }));
    const started = performance.now();
    const outcome = await run(html, listSchema({ part: 'string', sku: 'string', inStock: 'boolean', refurbished: 'boolean' }), records);
    const ms = performance.now() - started;
    expect(outcome.missing.filter((m) => m.reason === 'rejected_ungrounded')).toEqual([]);
    expect(ms).toBeLessThan(8_000);
  }, 60_000);

  it('header cells full of unclosed brackets are read in linear time', async () => {
    const head = ['Model', ...Array.from({ length: 40 }, (_, i) => `S${i} ${'('.repeat(1_900)}`), '5G'];
    const rows = Array.from({ length: 30 }, (_, r) => [`M${r}`, ...Array.from({ length: 40 }, () => 'x'), r % 2 ? 'Yes' : 'No']);
    const html = table(head, rows);
    const t = tableId(html);
    const started = performance.now();
    await run(html, listSchema({ model: 'string', has5g: 'boolean' }), rows.map((r) => ({ model: { v: r[0], b: t }, has5g: { v: r[41] === 'Yes', b: t } })));
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 60_000);
});

describe('an uncited number found elsewhere on the page', () => {
  const html =
    '<html><body><main><h1>Phone</h1><p>Rated 4.3 out of 5 by 812 buyers.</p><table><tr><th>Thickness</th><td>4.5 mm</td></tr><tr><th>Storage</th><td>512 GB</td></tr></table></main></body></html>';
  const schema = { type: 'object', properties: { rating: { type: 'number' }, storageGb: { type: 'number' } } };

  it('"4.5 out of 5" is not grounded by an unrelated "4.5"', async () => {
    const outcome = await run(html, schema, [{ rating: { v: '4.5 out of 5', b: null } }]);
    expect(reasonAt(outcome, '/rating')).toBe('rejected_ungrounded');
  });

  it('a distinctive number ("512 GB storage") is still found', async () => {
    const outcome = await run(html, schema, [{ storageGb: { v: '512 GB storage', b: null } }]);
    expect(outcome.data).toMatchObject({ storageGb: 512 });
  });
});

describe('after the second review round', () => {
  const listSchema = (props: Record<string, string>) => ({
    type: 'object',
    properties: { items: { type: 'array', items: { type: 'object', properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])) } } },
  });
  const tableId = (html: string) => buildSourceDocument(html, 'https://shop.example/').blocks.find((b) => b.kind === 'table')!.id;

  it('a header row of plain <td> cells still names the columns', async () => {
    const html =
      '<html><body><main><h1>Compare</h1><table>' +
      '<tr><td><b>Model</b></td><td><b>5G</b></td><td><b>NFC</b></td></tr>' +
      '<tr><td>Nova X1</td><td>Yes</td><td>No</td></tr><tr><td>Orbis</td><td>No</td><td>Yes</td></tr><tr><td>Pixel</td><td>No</td><td>No</td></tr>' +
      '</table></main></body></html>';
    const t = tableId(html);
    const out = await run(html, listSchema({ model: 'string', has5g: 'boolean', nfc: 'boolean' }), [
      { model: { v: 'Nova X1', b: t }, has5g: { v: true, b: t }, nfc: { v: false, b: t } },
      { model: { v: 'Orbis', b: t }, has5g: { v: false, b: t }, nfc: { v: true, b: t } },
    ]);
    expect(out.data).toMatchObject({ items: [{ has5g: true, nfc: false }, { has5g: false, nfc: true }] });
  });

  it('a two-column listing whose header does not spell the field is read by its rows', async () => {
    const html =
      '<html><body><main><h1>Parts</h1><table><thead><tr><th>Part</th><th>Availability</th></tr></thead><tbody>' +
      '<tr><td>Bolt M6</td><td>In stock</td></tr><tr><td>Nut M6</td><td>Out of stock</td></tr><tr><td>Washer</td><td>In stock</td></tr>' +
      '</tbody></table></main></body></html>';
    const t = tableId(html);
    const schema = listSchema({ part: 'string', inStock: 'boolean' });
    const out = await run(html, schema, [{ part: { v: 'Bolt M6', b: t }, inStock: { v: true, b: t } }, { part: { v: 'Nut M6', b: t }, inStock: { v: false, b: t } }]);
    expect(out.data).toMatchObject({ items: [{ inStock: true }, { inStock: false }] });
    const wrong = await run(html, schema, [{ part: { v: 'Nut M6', b: t }, inStock: { v: true, b: t } }]);
    expect(reasonAt(wrong, '/items/0/inStock')).toBe('rejected_ungrounded');
  });

  it("a card's own words in its class or a data attribute still contradict a wrong yes/no", async () => {
    const html =
      '<html><body><main><h1>Shop</h1><ul>' +
      ['Alpha', 'Beta', 'Gamma'].map((n, i) => `<li class="product post-${i} ${i === 1 ? 'outofstock' : 'instock'}" data-stock-status="${i === 1 ? 'outofstock' : 'instock'}"><h2>${n}</h2><span class="price">$${10 + i}</span><a class="button">Add to cart</a></li>`).join('') +
      '</ul></main></body></html>';
    const doc = buildSourceDocument(html, 'https://shop.example/');
    const from = doc.blocks.findIndex((b) => b.text === 'Beta');
    const button = doc.blocks.slice(from).find((b) => b.text === 'Add to cart')!.id;
    const out = await run(html, listSchema({ name: 'string', inStock: 'boolean' }), [{ name: { v: 'Beta', b: blockWith(doc, 'Beta') }, inStock: { v: true, b: button } }]);
    expect(reasonAt(out, '/items/0/inStock')).toBe('rejected_ungrounded');
  });
});
