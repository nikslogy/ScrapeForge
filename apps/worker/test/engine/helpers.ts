// Shared helpers for engine tests: an in-memory recipe store, model clients
// over scripted fake providers, small pages and response builders.

import { CircuitBreaker, FakeProvider, fakeCaps, ModelClient, type FakeHandler } from '../../src/extract/llm/index.js';
import { RecipeStore, type RecipeKv, type RecipeStoreOptions } from '../../src/extract/recipe/index.js';
import type { ExtractRequest, ModelCapabilities } from '../../src/extract/types.js';
import { buildSourceDocument } from '../../src/extract/document/index.js';
import { parsePrompt } from '../../../../tests/engine/oracle.js';

export class MemoryKv implements RecipeKv {
  readonly data = new Map<string, string>();
  readonly ops: string[] = [];
  failWith: Error | null = null;
  /** When set, get() calls from the `gateFromGet`-th one on wait for this promise (to observe ordering). */
  gate: Promise<void> | null = null;
  gateFromGet = 0;
  private gets = 0;

  async get(key: string): Promise<string | null> {
    this.ops.push(`get ${key}`);
    if (this.gate && this.gets++ >= this.gateFromGet) await this.gate;
    if (this.failWith) throw this.failWith;
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.ops.push(`set ${key}`);
    if (this.failWith) throw this.failWith;
    this.data.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<unknown> {
    this.ops.push(`del ${key}`);
    if (this.failWith) throw this.failWith;
    return this.data.delete(key) ? 1 : 0;
  }
}

export function memoryStore(opts: RecipeStoreOptions = {}): { kv: MemoryKv; store: RecipeStore } {
  const kv = new MemoryKv();
  return { kv, store: new RecipeStore(kv, opts) };
}

export interface TestClient {
  client: ModelClient;
  provider: FakeProvider;
}

/** ModelClient over one fake model with its own breaker (no state shared between tests). */
export function fakeClient(handler: FakeHandler, caps: Partial<ModelCapabilities> = {}): TestClient {
  const provider = new FakeProvider(handler);
  const client = new ModelClient({
    models: [fakeCaps(caps)],
    providers: { fake: provider },
    breaker: new CircuitBreaker(),
    sleep: async () => undefined,
  });
  return { client, provider };
}

/** A handler that fails the test if the model is called. */
export const NEVER: FakeHandler = (caps) => {
  throw new Error(`unexpected model call to ${caps.key}`);
};

export function request(html: string, schema: Record<string, unknown>, overrides: Partial<ExtractRequest> = {}): ExtractRequest {
  return {
    html,
    url: 'https://shop.example.com/products/widget',
    schema,
    tenantId: 'tenant-1',
    deadlineMs: Date.now() + 30_000,
    includeEvidence: true,
    ...overrides,
  };
}

/** Block id whose text equals (or, failing that, contains) `text`. Throws when absent. */
export function blockId(html: string, text: string, url = 'https://shop.example.com/products/widget'): string {
  const doc = buildSourceDocument(html, url);
  const exact = doc.blocks.find((b) => b.text === text);
  const hit = exact ?? doc.blocks.find((b) => b.text.includes(text));
  if (!hit) throw new Error(`no block with text ${JSON.stringify(text)}`);
  return hit.id;
}

/** {"records":[…]} envelope text from plain {field: [v, b]} records. */
export function envelope(records: Array<Record<string, [unknown, string | null]>>): string {
  return JSON.stringify({
    records: records.map((r) => Object.fromEntries(Object.entries(r).map(([k, [v, b]]) => [k, { v, b }]))),
  });
}

export function page(body: string, head = '<title>Widget</title>'): string {
  return `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
}

/** Product page with no structured data. */
export const PLAIN_PRODUCT = page(`
  <header><nav><a href="/">Home</a> <a href="/shop">Shop</a></nav></header>
  <main>
    <h1>Acme Turbo Widget</h1>
    <p class="price">$1,299.00</p>
    <p class="stock">In stock</p>
    <p class="sku">SKU: AC-1001</p>
    <section><h2>Description</h2><p>The Acme Turbo Widget spins at 3,000 rpm and ships with a two-year warranty for home workshops.</p></section>
    <section><h2>Shipping</h2><p>Free shipping on orders over $50. Returns accepted within 30 days.</p></section>
  </main>
  <footer><p>© 2026 Example Shop</p></footer>`);

/** Same product with JSON-LD whose name and price are visible on the page. */
export const JSONLD_PRODUCT = page(
  `<main>
    <h1>Acme Turbo Widget</h1>
    <p class="price">$1,299.00</p>
    <p class="stock">In stock</p>
    <section><h2>Description</h2><p>The Acme Turbo Widget spins at 3,000 rpm and ships with a two-year warranty for home workshops.</p></section>
  </main>`,
  `<title>Acme Turbo Widget | Example Shop</title>
   <script type="application/ld+json">${JSON.stringify({
     '@context': 'https://schema.org',
     '@type': 'Product',
     name: 'Acme Turbo Widget',
     sku: 'AC-1001-HIDDEN',
     offers: { '@type': 'Offer', price: '1299.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
   })}</script>`,
);

export interface Item {
  title: string;
  price: string;
}

export function items(n: number, offset = 0): Item[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `Gadget Model ${String.fromCharCode(65 + ((i + offset) % 26))}${i + offset}`,
    price: `$${(19 + (i + offset) * 3).toFixed(2)}`,
  }));
}

/** Listing page with one product card per item (stable template, varying content). */
export function listing(list: Item[], opts: { priceClass?: string; banner?: string } = {}): string {
  const priceClass = opts.priceClass ?? 'price';
  const cards = list
    .map(
      (it, i) => `
      <li class="card">
        <article class="product">
          <h3><a href="/p/${i}">${it.title}</a></h3>
          <p class="${priceClass}">${it.price}</p>
          <button>Add to cart</button>
        </article>
      </li>`,
    )
    .join('');
  return page(
    `<header><a href="/">Gadget Store</a>${opts.banner ? `<p>${opts.banner}</p>` : ''}</header>
     <main><h1>All gadgets</h1><ul class="grid">${cards}</ul></main>
     <footer><p>© 2026 Gadget Store</p></footer>`,
    '<title>All gadgets | Gadget Store</title>',
  );
}

export const LISTING_SCHEMA = { items: [{ title: 'string — product name', price: 'number — price' }] };
export const LISTING_URL = 'https://gadgets.example.com/collections/all';

/**
 * A model that reads listing prompts like the ones built by listing(): one
 * record per <record> frame, title from the "###" heading, price from the
 * "$…" line, citing those blocks. Records outside the prompt are not seen.
 */
export const listingModel: FakeHandler = (_caps, req) => {
  const prompt = parsePrompt(req);
  const records = prompt.scopes
    .filter((s) => s.kind === 'record')
    .map((s) => {
      const heading = s.blocks.find((b) => b.text.startsWith('### '));
      const price = s.blocks.find((b) => /^\$\d/.test(b.text));
      const rec: Record<string, { v: string | null; b: string | null }> = {};
      if (prompt.fields.includes('title')) rec.title = heading ? { v: heading.text.slice(4), b: heading.id } : { v: null, b: null };
      if (prompt.fields.includes('price')) rec.price = price ? { v: price.text, b: price.id } : { v: null, b: null };
      return rec;
    });
  return { text: JSON.stringify({ records }), finishReason: 'stop', inputTokens: 500, outputTokens: 100, costUsd: 0.001, latencyMs: 1 };
};
