import { afterEach, describe, expect, it } from 'vitest';
import { buildSourceDocument } from '../../src/extract/document/index.js';
import { extractStructured, flushRecipeLearning } from '../../src/extract/engine.js';
import type { FakeHandler } from '../../src/extract/llm/index.js';
import { normalizeSchema } from '../../src/extract/schema/index.js';
import type { RecipeKey } from '../../src/extract/types.js';
import { parsePrompt } from '../../../../tests/engine/oracle.js';
import { fakeClient, items, listing, LISTING_SCHEMA, LISTING_URL, listingModel, memoryStore, NEVER, page, request } from './helpers.js';

function keyFor(html: string, schema: Record<string, unknown> = LISTING_SCHEMA, url = LISTING_URL): RecipeKey {
  return {
    tenantId: 'tenant-1',
    host: new URL(url).hostname,
    templateSignature: buildSourceDocument(html, url).templateSignature,
    schemaHash: normalizeSchema(schema).hash,
  };
}

const SNAPSHOTS = [0, 20, 40, 60, 80].map((offset) => listing(items(20, offset)));

function expected(offset: number, n = 20): { items: Array<{ title: string; price: number }> } {
  return { items: items(n, offset).map((it) => ({ title: it.title, price: Number(it.price.slice(1)) })) };
}

afterEach(async () => {
  await flushRecipeLearning();
});

describe('recipe learning (await mode)', () => {
  it('saves a candidate, promotes it after 2 more agreeing snapshots, then serves it without the model', async () => {
    const { store } = memoryStore();
    const { client, provider } = fakeClient(listingModel);
    const key = keyFor(SNAPSHOTS[0]);
    const run = (html: string) =>
      extractStructured(request(html, LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: store, learning: 'await' });

    const first = await run(SNAPSHOTS[0]);
    expect(first.method).toBe('llm');
    expect(first.timings).toHaveProperty('learn');
    let stored = await store.get(key);
    expect(stored).toMatchObject({ state: 'candidate', validatedOn: [first.scope.snapshotHash], requiredFields: ['title', 'price'], recordCount: { min: 20, max: 20 } });
    expect(stored?.recipe.shape).toBe('array');
    expect(stored?.recipe.recordSelector).toBeTruthy();

    await run(SNAPSHOTS[1]);
    stored = await store.get(key);
    expect(stored).toMatchObject({ state: 'candidate' });
    expect(stored?.validatedOn).toHaveLength(2);

    await run(SNAPSHOTS[2]);
    stored = await store.get(key);
    expect(stored?.state).toBe('active');
    expect(provider.calls).toHaveLength(3);

    const served = await run(SNAPSHOTS[3]);
    expect(provider.calls).toHaveLength(3);
    expect(served).toMatchObject({ status: 'complete', method: 'recipe', schemaValid: true, llm: { calls: 0 } });
    expect(served.data).toEqual(expected(60));
    expect(served.evidence.find((e) => e.path === '/items/0/price')).toMatchObject({ source: 'recipe', grounded: true, raw: '$199.00' });
    expect(served.timings).toHaveProperty('recipe');
    expect(served.timings).not.toHaveProperty('llm');
    expect((await store.get(key))?.uses).toBe(1);
  });

  it('invalidates a drifted recipe and goes back to the model', async () => {
    const { store } = memoryStore({ maxConsecutiveFailures: 1 });
    const { client, provider } = fakeClient(listingModel);
    const key = keyFor(SNAPSHOTS[0]);
    const run = (html: string) =>
      extractStructured(request(html, LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: store, learning: 'await' });
    for (const html of SNAPSHOTS.slice(0, 3)) await run(html);
    expect((await store.get(key))?.state).toBe('active');

    // Same template, but the price element was renamed: the recipe finds no prices.
    const drifted = listing(items(20, 100), { priceClass: 'amount' });
    expect(keyFor(drifted)).toEqual(key);
    const out = await run(drifted);
    expect(provider.calls).toHaveLength(4);
    expect(out.method).toBe('llm');
    expect(out.data).toEqual(expected(100));
    expect(out.warnings.some((w) => w.startsWith('recipe_rejected:'))).toBe(true);
    // Drift deleted the recipe; this run did not learn from a page that just broke one.
    expect(await store.get(key)).toBeNull();

    // The next run starts learning again.
    await run(listing(items(20, 120), { priceClass: 'amount' }));
    expect((await store.get(key))?.state).toBe('candidate');
  });

  it('keeps an active recipe through one failure by default (and still answers via the model)', async () => {
    const { store } = memoryStore();
    const { client, provider } = fakeClient(listingModel);
    const key = keyFor(SNAPSHOTS[0]);
    const run = (html: string) =>
      extractStructured(request(html, LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: store, learning: 'await' });
    for (const html of SNAPSHOTS.slice(0, 3)) await run(html);
    const out = await run(listing(items(20, 100), { priceClass: 'amount' }));
    expect(out.method).toBe('llm');
    expect(provider.calls).toHaveLength(4);
    expect(await store.get(key)).toMatchObject({ state: 'active', failures: 1 });
  });

  it('drops a candidate that disagrees with a later grounded result', async () => {
    const { store } = memoryStore();
    const key = keyFor(SNAPSHOTS[0]);
    const { client } = fakeClient(listingModel);
    await extractStructured(request(SNAPSHOTS[0], LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: store, learning: 'await' });
    expect((await store.get(key))?.state).toBe('candidate');

    // Each card now shows a placeholder price first; the model (correctly) reads the second one.
    const html = SNAPSHOTS[1].replaceAll('<p class="price">', '<p class="price">$1.00</p><p class="sale">');
    expect(keyFor(html)).toEqual(key);
    const secondPrice: FakeHandler = (caps, req, i) => {
      const prompt = parsePrompt(req);
      const records = prompt.scopes
        .filter((s) => s.kind === 'record')
        .map((s) => {
          const heading = s.blocks.find((b) => b.text.startsWith('### '));
          const prices = s.blocks.filter((b) => /^\$\d/.test(b.text));
          const price = prices[prices.length - 1];
          return { title: { v: heading?.text.slice(4) ?? null, b: heading?.id ?? null }, price: { v: price?.text ?? null, b: price?.id ?? null } };
        });
      void caps;
      void i;
      return { text: JSON.stringify({ records }), finishReason: 'stop', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 };
    };
    const { client: c2 } = fakeClient(secondPrice);
    const out = await extractStructured(request(html, LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: c2, recipeStore: store, learning: 'await' });
    expect(out.status).toBe('complete');
    expect(await store.get(key)).toBeNull();
  });

  it('learns object recipes and fills the covered fields without the model', async () => {
    const product = (name: string, price: string, sku: string) =>
      page(`<header><a href="/">Shop</a></header><main><h1>${name}</h1><p class="price">${price}</p><p class="sku">SKU: ${sku}</p>
        <section><h2>Details</h2><p>Built to last, with a two-year warranty and free returns within 30 days.</p></section></main>`);
    const schema = { name: 'string', price: 'number', sku: 'string' };
    const url = (i: number) => `https://shop.example.com/products/item-${i}`;
    const objectModel: FakeHandler = (_c, req) => {
      const prompt = parsePrompt(req);
      const find = (re: RegExp) => prompt.blocks.find((b) => re.test(b.text));
      const name = find(/^# /);
      const price = find(/^\$/);
      const sku = find(/^SKU: /);
      const rec: Record<string, { v: string | null; b: string | null }> = {};
      if (prompt.fields.includes('name')) rec.name = { v: name ? name.text.slice(2) : null, b: name?.id ?? null };
      if (prompt.fields.includes('price')) rec.price = { v: price?.text ?? null, b: price?.id ?? null };
      if (prompt.fields.includes('sku')) rec.sku = { v: sku ? sku.text.slice(5) : null, b: sku?.id ?? null };
      return { text: JSON.stringify({ records: [rec] }), finishReason: 'stop', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 };
    };
    const { store } = memoryStore();
    const { client, provider } = fakeClient(objectModel);
    const pages = [
      product('Brass Lamp', '$40.00', 'BL-1'),
      product('Oak Table', '$410.50', 'OT-22'),
      product('Wool Rug', '$129.99', 'WR-333'),
      product('Glass Vase', '$18.25', 'GV-4444'),
    ];
    for (let i = 0; i < 3; i++) {
      await extractStructured(request(pages[i], schema, { url: url(i) }), { modelClient: client, recipeStore: store, learning: 'await' });
    }
    expect((await store.get(keyFor(pages[0], schema, url(0))))?.state).toBe('active');
    const out = await extractStructured(request(pages[3], schema, { url: url(3) }), { modelClient: client, recipeStore: store, learning: 'await' });
    expect(provider.calls).toHaveLength(3);
    expect(out).toMatchObject({ method: 'recipe', status: 'complete', data: { name: 'Glass Vase', price: 18.25, sku: 'GV-4444' } });
  });

  it('does not learn when disabled, or from results with citation problems', async () => {
    const { store, kv } = memoryStore();
    const { client } = fakeClient(listingModel);
    await extractStructured(request(SNAPSHOTS[0], LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: store, learning: 'off' });
    await extractStructured(request(SNAPSHOTS[0], LISTING_SCHEMA, { url: LISTING_URL, disable: ['recipe-learning'] }), {
      modelClient: client,
      recipeStore: store,
      learning: 'await',
    });
    expect(kv.data.size).toBe(0);

    const miscited: FakeHandler = (caps, req, i) => {
      const res = listingModel(caps, req, i) as { text: string };
      const body = JSON.parse(res.text) as { records: Array<Record<string, { v: unknown; b: string | null }>> };
      for (const r of body.records) r.price.b = 'b0';
      return { ...(res as object), text: JSON.stringify(body) } as never;
    };
    const { client: c2 } = fakeClient(miscited);
    const out = await extractStructured(request(SNAPSHOTS[0], LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: c2, recipeStore: store, learning: 'await' });
    expect(out.warnings.some((w) => w.startsWith('citation_mismatch:'))).toBe(true);
    expect(kv.data.size).toBe(0);
  });

  it('does not learn from truncated input', async () => {
    const { store, kv } = memoryStore();
    const { client } = fakeClient(listingModel, { contextTokens: 2_500, maxOutputTokens: 512 });
    const out = await extractStructured(request(listing(items(60)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: store, learning: 'await' });
    expect(out.scope.truncated).toBe(true);
    expect(kv.data.size).toBe(0);
  });
});

describe('recipe learning (background mode)', () => {
  it('does not delay the answer and completes afterwards', async () => {
    const { store, kv } = memoryStore();
    const { client } = fakeClient(listingModel);
    let release!: () => void;
    // The recipe stage reads the store first (get #0); learning's reads (get #1 on) stall until released.
    kv.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    kv.gateFromGet = 1;
    const out = await extractStructured(request(SNAPSHOTS[0], LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: store });
    expect(out.status).toBe('complete');
    expect(out.timings).not.toHaveProperty('learn');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(kv.data.size).toBe(0);
    release();
    await flushRecipeLearning();
    expect([...kv.data.keys()]).toHaveLength(1);
  });

  it('answers while the store is stalled and swallows store errors without unhandled rejections', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { store, kv } = memoryStore();
      const logs: string[] = [];
      const { client } = fakeClient(listingModel);
      kv.failWith = new Error('connection reset by peer');
      const out = await extractStructured(request(SNAPSHOTS[0], LISTING_SCHEMA, { url: LISTING_URL }), {
        modelClient: client,
        recipeStore: store,
        log: (m) => logs.push(m),
      });
      expect(out.status).toBe('complete');
      await flushRecipeLearning();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(logs).toEqual(['[extract] background recipe learning failed: Error']);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('never runs when there is nothing trustworthy to learn from', async () => {
    const { store, kv } = memoryStore();
    const out = await extractStructured(request(SNAPSHOTS[0], LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: fakeClient(NEVER).client, recipeStore: store });
    expect(out.status).toBe('failed');
    await flushRecipeLearning();
    expect(kv.ops.filter((o) => o.startsWith('set'))).toEqual([]);
  });
});
