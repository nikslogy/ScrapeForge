import { describe, expect, it } from 'vitest';
import { extractStructured } from '../../src/extract/engine.js';
import { delay, estimateTokens, fakeError, fakeResponse, scripted, type FakeHandler } from '../../src/extract/llm/index.js';
import { StageTracer } from '../../src/tracing.js';
import {
  blockId,
  envelope,
  fakeClient,
  items,
  JSONLD_PRODUCT,
  listing,
  LISTING_SCHEMA,
  LISTING_URL,
  listingModel,
  memoryStore,
  NEVER,
  page,
  PLAIN_PRODUCT,
  request,
} from './helpers.js';

const PRODUCT_SCHEMA = { name: 'string — product name', price: 'number — current price', sku: 'string — SKU code' };

describe('extractStructured: structured data', () => {
  it('completes from visible structured data without calling the model', async () => {
    const { client, provider } = fakeClient(NEVER);
    const out = await extractStructured(request(JSONLD_PRODUCT, { name: 'string', price: 'number', currency: 'string' }), {
      modelClient: client,
      recipeStore: null,
    });
    expect(provider.calls).toHaveLength(0);
    expect(out).toMatchObject({
      status: 'complete',
      method: 'structured-data',
      schemaValid: true,
      data: { name: 'Acme Turbo Widget', price: 1299, currency: 'USD' },
      missing: [],
      llm: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
    expect(out.evidence.find((e) => e.path === '/price')).toMatchObject({ source: 'structured-data', structuredId: 'sd0', raw: '1299.00', grounded: true });
    expect(out.timings).toHaveProperty('document');
    expect(out.timings).toHaveProperty('structured');
    expect(out.timings).not.toHaveProperty('llm');
  });

  it('asks the model only for fields structured data did not fill visibly', async () => {
    let fields: string[] = [];
    const { client } = fakeClient((_c, req) => {
      fields = [...req.system.matchAll(/^- "([^"]+)"/gm)].map((m) => m[1]);
      return fakeResponse(envelope([{ sku: ['AC-1001', blockId(JSONLD_PRODUCT.replace('</main>', '<p>SKU: AC-1001</p></main>'), 'SKU: AC-1001')] }]));
    });
    const html = JSONLD_PRODUCT.replace('</main>', '<p>SKU: AC-1001</p></main>');
    const out = await extractStructured(request(html, PRODUCT_SCHEMA), { modelClient: client, recipeStore: null });
    // sku is in JSON-LD but not visible: it is asked for, and the visible value wins.
    expect(fields).toEqual(['sku']);
    expect(out.data).toEqual({ name: 'Acme Turbo Widget', price: 1299, sku: 'AC-1001' });
    expect(out.method).toBe('mixed');
    expect(out.warnings).toContain('conflict:sku');
    expect(out.status).toBe('complete');
  });

  it('falls back to an unverified structured value when the model finds nothing', async () => {
    const { client } = fakeClient(scripted(fakeResponse(envelope([{ sku: [null, null] }]))));
    const out = await extractStructured(request(JSONLD_PRODUCT, PRODUCT_SCHEMA), { modelClient: client, recipeStore: null });
    expect(out.data).toEqual({ name: 'Acme Turbo Widget', price: 1299, sku: 'AC-1001-HIDDEN' });
    expect(out.warnings).toContain('structured_value_not_visible:sku');
    expect(out.evidence.find((e) => e.path === '/sku')).toMatchObject({ source: 'structured-data', grounded: false });
    expect(out.missing).toEqual([]);
    expect(out.status).toBe('complete');
  });

  it('does not accept a schema.org enumeration URL as displayed text for a string field', async () => {
    const id = blockId(JSONLD_PRODUCT, 'In stock');
    const { client, provider } = fakeClient(scripted(fakeResponse(envelope([{ availability: ['In stock', id] }]))));
    const out = await extractStructured(request(JSONLD_PRODUCT, { name: 'string', availability: 'string — stock status as shown' }), {
      modelClient: client,
      recipeStore: null,
    });
    expect(provider.calls).toHaveLength(1);
    expect(out.data).toEqual({ name: 'Acme Turbo Widget', availability: 'In stock' });
    expect(out.warnings).toContain('conflict:availability');
  });

  it('can be disabled', async () => {
    const { client } = fakeClient(scripted(fakeResponse(envelope([{ name: ['Acme Turbo Widget', 'b0'] }]))));
    const out = await extractStructured(request(JSONLD_PRODUCT, { name: 'string' }, { disable: ['structured'] }), { modelClient: client, recipeStore: null });
    expect(out.method).toBe('llm');
    expect(out.timings).not.toHaveProperty('structured');
  });
});

describe('extractStructured: LLM path', () => {
  const titleId = blockId(PLAIN_PRODUCT, 'Acme Turbo Widget');
  const priceId = blockId(PLAIN_PRODUCT, '$1,299.00');
  const skuId = blockId(PLAIN_PRODUCT, 'SKU: AC-1001');
  const stockId = blockId(PLAIN_PRODUCT, 'In stock');

  it('normalizes grounded raw values in code and records evidence and usage', async () => {
    const { client, provider } = fakeClient(
      scripted(fakeResponse(envelope([{ name: ['Acme Turbo Widget', titleId], price: ['$1,299.00', priceId], sku: ['AC-1001', skuId] }]), { inputTokens: 900, outputTokens: 80, costUsd: 0.0012 })),
    );
    const out = await extractStructured(request(PLAIN_PRODUCT, PRODUCT_SCHEMA), { modelClient: client, recipeStore: null });
    expect(out).toMatchObject({ status: 'complete', method: 'llm', schemaValid: true, data: { name: 'Acme Turbo Widget', price: 1299, sku: 'AC-1001' } });
    expect(out.llm).toMatchObject({ calls: 1, inputTokens: 900, outputTokens: 80, costUsd: 0.0012 });
    expect(out.llm.attempts[0]).toMatchObject({ provider: 'fake', purpose: 'extract', ok: true });
    expect(out.evidence.find((e) => e.path === '/price')).toMatchObject({
      source: 'llm',
      blockId: priceId,
      raw: '$1,299.00',
      grounded: true,
      excerpt: '$1,299.00',
    });
    expect(out.evidence.find((e) => e.path === '/price')?.normalization).toContain('parse-number');
    expect(out.scope).toMatchObject({ truncated: false, description: 'page-snapshot' });
    expect(out.scope.blocksSentToModel).toBeGreaterThan(5);
    expect(out.timings.llm).toBeGreaterThanOrEqual(0);
    // The prompt carries the page as blocks, with the URL, and only the requested fields.
    const user = provider.calls[0].req.user;
    expect(user).toContain('Page URL: https://shop.example.com/products/widget');
    expect(user).toContain(`[${priceId}] $1,299.00`);
  });

  it('rejects values that are not on the page (and never returns them)', async () => {
    const { client } = fakeClient(scripted(fakeResponse(envelope([{ name: ['Acme Hyper Widget 9000', titleId], price: ['$899.00', priceId], sku: ['AC-1001', skuId] }]))));
    const out = await extractStructured(request(PLAIN_PRODUCT, PRODUCT_SCHEMA), { modelClient: client, recipeStore: null });
    expect(out.data).toEqual({ name: null, price: null, sku: 'AC-1001' });
    expect(out.missing).toEqual([
      { path: '/name', reason: 'rejected_ungrounded', detail: `value not found in cited block ${titleId} or on the page` },
      { path: '/price', reason: 'rejected_ungrounded', detail: `value not found in cited block ${priceId} or on the page` },
    ]);
    expect(out.warnings).toContain('ungrounded_values_rejected:2');
    expect(out.status).toBe('partial');
  });

  it('fails when every value is rejected', async () => {
    const { client } = fakeClient(scripted(fakeResponse(envelope([{ name: ['Invented', 'b1'], price: ['$1.00', 'b2'], sku: ['ZZ-9', 'b3'] }]))));
    const out = await extractStructured(request(PLAIN_PRODUCT, PRODUCT_SCHEMA), { modelClient: client, recipeStore: null });
    expect(out).toMatchObject({ status: 'failed', data: null, method: 'none', schemaValid: false });
    expect(out.missing.map((m) => m.reason)).toEqual(['rejected_ungrounded', 'rejected_ungrounded', 'rejected_ungrounded']);
  });

  it('accepts a value found outside the cited block with a citation warning', async () => {
    const { client } = fakeClient(scripted(fakeResponse(envelope([{ name: ['Acme Turbo Widget', titleId], price: ['$1,299.00', skuId], sku: ['AC-1001', 'b999'] }]))));
    const out = await extractStructured(request(PLAIN_PRODUCT, PRODUCT_SCHEMA), { modelClient: client, recipeStore: null });
    expect(out.data).toEqual({ name: 'Acme Turbo Widget', price: 1299, sku: 'AC-1001' });
    expect(out.warnings).toEqual(expect.arrayContaining(['citation_mismatch:/price', 'citation_mismatch:/sku']));
    expect(out.evidence.find((e) => e.path === '/price')).toMatchObject({ blockId: skuId, grounded: true, note: expect.stringContaining(`cited ${skuId}`) });
    // An unknown block id is not echoed as evidence.
    expect(out.evidence.find((e) => e.path === '/sku')?.blockId).toBeUndefined();
    expect(out.status).toBe('complete');
  });

  it('keeps derived fields without grounding and labels them', async () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, summary: { type: 'string', 'x-derived': true } },
    };
    const descId = blockId(PLAIN_PRODUCT, 'spins at 3,000 rpm');
    const { client } = fakeClient(scripted(fakeResponse(envelope([{ name: ['Acme Turbo Widget', titleId], summary: ['A fast widget for home workshops.', descId] }]))));
    const out = await extractStructured(request(PLAIN_PRODUCT, schema), { modelClient: client, recipeStore: null });
    expect(out.data).toEqual({ name: 'Acme Turbo Widget', summary: 'A fast widget for home workshops.' });
    expect(out.evidence.find((e) => e.path === '/summary')).toMatchObject({ derived: true, grounded: false, blockId: descId });
    expect(out.status).toBe('complete');
  });

  it('reports ambiguous and unparseable values instead of guessing', async () => {
    const html = page('<h1>Range Widget</h1><p>$10 - $20</p><p>Price: Free</p><p>Some more text to make this a page.</p>');
    const range = blockId(html, '$10 - $20');
    const free = blockId(html, 'Price: Free');
    const { client } = fakeClient(scripted(fakeResponse(envelope([{ low: ['$10 - $20', range], other: ['Free', free] }]))));
    const out = await extractStructured(request(html, { low: 'number', other: 'number' }), { modelClient: client, recipeStore: null });
    expect(out.data).toBeNull();
    expect(out.status).toBe('failed');
    expect(out.missing).toEqual([
      { path: '/low', reason: 'ambiguous', detail: expect.stringContaining('ambiguous: several numbers') },
      // On the page but not a number: not genuinely absent.
      { path: '/other', reason: 'unparseable', detail: expect.stringContaining('unparseable') },
    ]);
  });

  it('treats an absent value as not_found and still completes for nullable fields', async () => {
    const { client } = fakeClient(scripted(fakeResponse(envelope([{ name: ['Acme Turbo Widget', titleId], price: [null, null], sku: ['AC-1001', skuId] }]))));
    const out = await extractStructured(request(PLAIN_PRODUCT, PRODUCT_SCHEMA), { modelClient: client, recipeStore: null });
    expect(out.data).toEqual({ name: 'Acme Turbo Widget', price: null, sku: 'AC-1001' });
    expect(out.missing).toEqual([{ path: '/price', reason: 'not_found' }]);
    expect(out.status).toBe('complete');
  });

  it('omits optional non-nullable fields that are absent, and keeps required ones as null (partial)', async () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, rating: { type: 'number' }, price: { type: 'number' } },
      required: ['name', 'price'],
    };
    const { client } = fakeClient(scripted(fakeResponse(envelope([{ name: ['Acme Turbo Widget', titleId], rating: [null, null], price: [null, null] }]))));
    const out = await extractStructured(request(PLAIN_PRODUCT, schema), { modelClient: client, recipeStore: null });
    expect(out.data).toEqual({ name: 'Acme Turbo Widget', price: null });
    expect(out.schemaValid).toBe(false);
    expect(out.schemaErrors?.[0]).toMatch(/price/);
    expect(out.status).toBe('partial');

    const { client: c2 } = fakeClient(scripted(fakeResponse(envelope([{ name: ['Acme Turbo Widget', titleId], rating: [null, null], price: ['$1,299.00', priceId] }]))));
    const ok = await extractStructured(request(PLAIN_PRODUCT, schema), { modelClient: c2, recipeStore: null });
    expect(ok.data).toEqual({ name: 'Acme Turbo Widget', price: 1299 });
    expect(ok.missing).toEqual([{ path: '/rating', reason: 'not_found' }]);
    expect(ok.status).toBe('complete');
  });

  it('parses booleans from displayed text', async () => {
    const { client } = fakeClient(scripted(fakeResponse(envelope([{ inStock: ['In stock', stockId] }]))));
    const out = await extractStructured(request(PLAIN_PRODUCT, { inStock: 'boolean' }), { modelClient: client, recipeStore: null });
    expect(out.data).toEqual({ inStock: true });
  });

  it('omits evidence unless asked, but always reports missing, warnings, scope, llm and timings', async () => {
    const { client } = fakeClient(scripted(fakeResponse(envelope([{ name: ['Acme Turbo Widget', titleId], price: [null, null], sku: ['AC-1001', 'b0'] }]))));
    const out = await extractStructured(request(PLAIN_PRODUCT, PRODUCT_SCHEMA, { includeEvidence: false }), { modelClient: client, recipeStore: null });
    expect(out.evidence).toEqual([]);
    expect(out.missing).toHaveLength(1);
    expect(out.warnings).toContain('citation_mismatch:/sku');
    expect(out.llm.calls).toBe(1);
    expect(Object.keys(out.timings)).toEqual(expect.arrayContaining(['schema', 'document', 'structured', 'llm', 'validate']));
  });

  it('adds stage times to the caller tracer', async () => {
    const tracer = new StageTracer();
    const { client } = fakeClient(scripted(fakeResponse(envelope([{ name: ['Acme Turbo Widget', titleId] }]))));
    await extractStructured(request(PLAIN_PRODUCT, { name: 'string' }), { modelClient: client, recipeStore: null, tracer });
    expect(Object.keys(tracer.snapshot().stages)).toEqual(expect.arrayContaining(['document', 'llm', 'validate']));
  });

  it('uses the page language for ambiguous thousands separators', async () => {
    const html = '<!doctype html><html lang="de"><head><title>Kaffee</title></head><body><h1>Kaffeemühle</h1><p>Preis: 1.299 €</p><p>Ein schönes Gerät für die Küche zu Hause.</p></body></html>';
    const id = blockId(html, 'Preis: 1.299 €');
    const { client } = fakeClient(scripted(fakeResponse(envelope([{ price: ['1.299 €', id] }]))));
    const out = await extractStructured(request(html, { price: 'number' }), { modelClient: client, recipeStore: null });
    expect(out.data).toEqual({ price: 1299 });
  });
});

describe('extractStructured: model failures', () => {
  it('repairs a response that is not JSON with one repair call', async () => {
    const titleId = blockId(PLAIN_PRODUCT, 'Acme Turbo Widget');
    const { client, provider } = fakeClient(
      scripted(
        fakeResponse(`Sure! {'records': [{'name': {'v': 'Acme Turbo Widget', 'b': '${titleId}'}}]}`),
        fakeResponse(envelope([{ name: ['Acme Turbo Widget', titleId] }])),
      ),
    );
    const out = await extractStructured(request(PLAIN_PRODUCT, { name: 'string' }), { modelClient: client, recipeStore: null });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].req.system).toMatch(/repair malformed JSON/);
    expect(out.llm.attempts.map((a) => a.purpose)).toEqual(['extract', 'repair']);
    expect(out.data).toEqual({ name: 'Acme Turbo Widget' });
    expect(out.status).toBe('complete');
  });

  it('gives up after one failed repair', async () => {
    const { client, provider } = fakeClient(scripted(fakeResponse('no json here'), fakeResponse('still {not json')));
    const out = await extractStructured(request(PLAIN_PRODUCT, { name: 'string', price: 'number' }), { modelClient: client, recipeStore: null });
    expect(provider.calls).toHaveLength(2);
    expect(out.status).toBe('failed');
    expect(out.warnings).toContain('llm_failed:parse_error');
    expect(out.missing[0]).toEqual({ path: '/name', reason: 'provider_failure', detail: 'parse_error' });
    expect(out.llm.calls).toBe(2);
  });

  it('retries once with half the input after output truncation and reports truncation', async () => {
    const titleId = blockId(PLAIN_PRODUCT, 'Acme Turbo Widget');
    const { client, provider } = fakeClient(
      scripted(fakeResponse('{"records":[{"name":{"v":"Acme', { finishReason: 'length' }), fakeResponse(envelope([{ name: ['Acme Turbo Widget', titleId] }]))),
    );
    const out = await extractStructured(request(PLAIN_PRODUCT, { name: 'string', sku: 'string' }), { modelClient: client, recipeStore: null });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].req.user.length).toBeLessThan(provider.calls[0].req.user.length);
    expect(out.scope.truncated).toBe(true);
    expect(out.warnings).toEqual(expect.arrayContaining(['llm_retry_smaller_input:output_truncated', 'input_truncated']));
    expect(out.status).toBe('partial');
    expect(out.data).toEqual({ name: 'Acme Turbo Widget', sku: null });
    expect(out.missing).toEqual([{ path: '/sku', reason: 'not_processed', detail: expect.stringContaining('truncated') }]);
    expect(out.llm.attempts.map((a) => a.ok)).toEqual([false, true]);
  });

  it('reports output truncation that persists after the retry', async () => {
    const cut = () => fakeResponse('{"records":[', { finishReason: 'length' });
    const { client } = fakeClient(scripted(cut(), cut()));
    const out = await extractStructured(request(PLAIN_PRODUCT, { name: 'string' }), { modelClient: client, recipeStore: null });
    expect(out.status).toBe('failed');
    expect(out.missing).toEqual([{ path: '/name', reason: 'truncated', detail: 'output_truncated' }]);
  });

  it('reports a provider failure as missing provider_failure (failed without other data)', async () => {
    const { client } = fakeClient(scripted(fakeError('auth', { status: 401 })));
    const out = await extractStructured(request(PLAIN_PRODUCT, PRODUCT_SCHEMA), { modelClient: client, recipeStore: null });
    expect(out.status).toBe('failed');
    expect(out.data).toBeNull();
    expect(out.warnings).toContain('llm_failed:auth');
    expect(out.missing).toEqual(PRODUCT_SCHEMA && [
      { path: '/name', reason: 'provider_failure', detail: 'auth' },
      { path: '/price', reason: 'provider_failure', detail: 'auth' },
      { path: '/sku', reason: 'provider_failure', detail: 'auth' },
    ]);
    expect(out.llm.attempts).toHaveLength(1);
    expect(out.llm.attempts[0]).toMatchObject({ ok: false, errorCategory: 'auth' });
  });

  it('keeps structured values and reports partial when the model fails', async () => {
    const { client } = fakeClient(scripted(fakeError('auth', { status: 401 })));
    const out = await extractStructured(request(JSONLD_PRODUCT, { ...PRODUCT_SCHEMA, color: 'string' }), { modelClient: client, recipeStore: null });
    expect(out.status).toBe('partial');
    // sku exists only in JSON-LD (not visible): used as a labelled fallback, not reported as a provider failure.
    expect(out.data).toEqual({ name: 'Acme Turbo Widget', price: 1299, sku: 'AC-1001-HIDDEN', color: null });
    expect(out.missing).toEqual([{ path: '/color', reason: 'provider_failure', detail: 'auth' }]);
    expect(out.warnings).toEqual(expect.arrayContaining(['llm_failed:auth', 'structured_value_not_visible:sku']));
  });

  it('reports a missing model configuration', async () => {
    for (const modelClient of [null, fakeClient(NEVER).client]) {
      const client = modelClient && { ...modelClient, models: [] };
      const out = await extractStructured(request(PLAIN_PRODUCT, { name: 'string' }), {
        modelClient: (client ?? null) as never,
        recipeStore: null,
      });
      expect(out.status).toBe('failed');
      expect(out.warnings).toContain('no_model_configured');
      expect(out.missing).toEqual([{ path: '/name', reason: 'provider_failure', detail: 'no_model_configured' }]);
      expect(out.llm.calls).toBe(0);
    }
  });

  it('does not call the model past the deadline or with a zero spend cap', async () => {
    for (const overrides of [{ deadlineMs: Date.now() - 1 }, { maxCostUsd: 0 }]) {
      const { client, provider } = fakeClient(NEVER);
      const out = await extractStructured(request(PLAIN_PRODUCT, { name: 'string' }, overrides), { modelClient: client, recipeStore: null });
      expect(provider.calls).toHaveLength(0);
      expect(out.status).toBe('failed');
      expect(out.warnings).toContain('llm_failed:budget_exhausted');
      expect(out.missing).toEqual([{ path: '/name', reason: 'provider_failure', detail: 'budget_exhausted' }]);
    }
  });

  it('stops when the cost cap is reached before the repair call', async () => {
    const { client, provider } = fakeClient(scripted(fakeResponse('not json', { costUsd: 0.02 })));
    const out = await extractStructured(request(PLAIN_PRODUCT, { name: 'string' }, { maxCostUsd: 0.01 }), { modelClient: client, recipeStore: null });
    expect(provider.calls).toHaveLength(1);
    expect(out.warnings).toContain('llm_failed:budget_exhausted');
    expect(out.llm.costUsd).toBeCloseTo(0.02);
  });

  it('does not throw for a provider that throws a non-LLM error', async () => {
    const { client } = fakeClient(() => {
      throw new TypeError('provider bug');
    });
    const out = await extractStructured(request(PLAIN_PRODUCT, { name: 'string' }), { modelClient: client, recipeStore: null });
    expect(out.status).toBe('failed');
    expect(out.missing[0]).toMatchObject({ reason: 'provider_failure' });
  });
});

describe('extractStructured: truncation', () => {
  it('sends what fits to a small-context model and reports partial + not_processed', async () => {
    const filler = Array.from({ length: 200 }, (_, i) => `<p>Paragraph ${i} about widgets, gears, springs and other parts of the catalogue.</p>`).join('');
    const html = page(`<h1>Acme Turbo Widget</h1><p>$1,299.00</p>${filler}<p>SKU: AC-1001</p>`);
    const titleId = blockId(html, 'Acme Turbo Widget');
    let user = '';
    const { client } = fakeClient(
      (_c, req) => {
        user = req.user;
        return fakeResponse(envelope([{ name: ['Acme Turbo Widget', titleId], sku: [null, null] }]));
      },
      { contextTokens: 3_000, maxOutputTokens: 512 },
    );
    const out = await extractStructured(request(html, { name: 'string', sku: 'string' }), { modelClient: client, recipeStore: null });
    expect(user).not.toContain('SKU: AC-1001');
    expect(out.scope.truncated).toBe(true);
    expect(out.scope.blocksSentToModel).toBeLessThan(out.scope.blocksTotal);
    expect(out.warnings).toContain('input_truncated');
    expect(out.status).toBe('partial');
    expect(out.missing).toEqual([{ path: '/sku', reason: 'not_processed', detail: expect.any(String) }]);
  });

  it('reports not_processed for the unseen part of a listing', async () => {
    const html = listing(items(60));
    const { client } = fakeClient(listingModel, { contextTokens: 2_500, maxOutputTokens: 512 });
    const out = await extractStructured(request(html, LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null });
    const list = (out.data as { items: unknown[] }).items;
    expect(list.length).toBeGreaterThan(0);
    expect(list.length).toBeLessThan(60);
    expect(out.status).toBe('partial');
    expect(out.missing).toContainEqual({ path: '/items', reason: 'not_processed', detail: expect.stringContaining('input truncated') });
  });
});

describe('extractStructured: shapes', () => {
  it('keeps the wrapper key and uses JSON pointers into the final data', async () => {
    const { client } = fakeClient(listingModel);
    const out = await extractStructured(request(listing(items(5)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null });
    expect(out.status).toBe('complete');
    expect(out.data).toEqual({ items: items(5).map((it) => ({ title: it.title, price: Number(it.price.slice(1)) })) });
    expect(out.evidence.map((e) => e.path)).toContain('/items/3/price');
    expect(out.scope.recordsDetected).toBe(5);
  });

  it('returns a bare array for a top-level array schema', async () => {
    const { client } = fakeClient(listingModel);
    const schema = { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, price: { type: 'number' } }, required: ['title'] } };
    const out = await extractStructured(request(listing(items(3)), schema, { url: LISTING_URL }), { modelClient: client, recipeStore: null });
    expect(Array.isArray(out.data)).toBe(true);
    expect(out.evidence.map((e) => e.path)).toContain('/2/title');
    expect(out.status).toBe('complete');
  });

  it("'auto' returns an array for several records and an object for one", async () => {
    const schema = { title: 'string', price: 'number' };
    const { client } = fakeClient(listingModel);
    const many = await extractStructured(request(listing(items(4)), schema, { url: LISTING_URL }), { modelClient: client, recipeStore: null });
    expect(Array.isArray(many.data)).toBe(true);
    expect(many.data).toHaveLength(4);
    expect(many.schemaValid).toBe(true);
    expect(many.evidence[0].path).toBe('/0/title');

    const html = listing(items(3));
    const id = blockId(html, '$22.00');
    const { client: one } = fakeClient(scripted(fakeResponse(envelope([{ title: ['Gadget Model B1', blockId(html, 'Gadget Model B1')], price: ['$22.00', id] }]))));
    const single = await extractStructured(request(html, schema, { url: LISTING_URL }), { modelClient: one, recipeStore: null });
    expect(single.data).toEqual({ title: 'Gadget Model B1', price: 22 });
    expect(single.schemaValid).toBe(true);
  });

  it('fails an array request when the model finds no records, and drops records without values', async () => {
    const { client } = fakeClient(scripted(fakeResponse('{"records":[]}')));
    const none = await extractStructured(request(listing(items(3)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null });
    expect(none).toMatchObject({ status: 'failed', data: null });
    expect(none.missing).toEqual([{ path: '/items', reason: 'not_found', detail: 'no records found' }]);

    const html = listing(items(3));
    const { client: c2 } = fakeClient(
      scripted(fakeResponse(envelope([{ title: ['Gadget Model A0', blockId(html, 'Gadget Model A0')], price: ['$19.00', blockId(html, '$19.00')] }, { title: ['Fake', 'b1'], price: ['$1.23', 'b1'] }]))),
    );
    const some = await extractStructured(request(html, LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: c2, recipeStore: null });
    expect(some.data).toEqual({ items: [{ title: 'Gadget Model A0', price: 19 }] });
    expect(some.warnings).toEqual(expect.arrayContaining(['dropped_records_without_values:1', 'ungrounded_values_rejected:2']));
  });

  it('reports a failed listing call at the list path', async () => {
    const { client } = fakeClient(scripted(fakeError('quota', { status: 402 })));
    const out = await extractStructured(request(listing(items(3)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null });
    expect(out.status).toBe('failed');
    expect(out.missing).toEqual([{ path: '/items', reason: 'provider_failure', detail: 'quota' }]);
  });
});

describe('extractStructured: blocked pages and invalid schemas', () => {
  const CHALLENGE = page(
    `<div class="main-content"><h1>shop.example.com</h1><p>Verifying you are human. This may take a few seconds.</p>
     <div class="cf-turnstile" data-sitekey="x"></div><p>shop.example.com needs to review the security of your connection before proceeding.</p></div>`,
    '<title>Just a moment...</title>',
  );

  it('fails a challenge page without any model call', async () => {
    const { client, provider } = fakeClient(NEVER);
    const out = await extractStructured(request(CHALLENGE, PRODUCT_SCHEMA), { modelClient: client, recipeStore: null });
    expect(provider.calls).toHaveLength(0);
    expect(out).toMatchObject({ status: 'failed', data: null, method: 'none', schemaValid: false, llm: { calls: 0 } });
    expect(out.warnings).toEqual(['source_page_blocked:challenge_page']);
    expect(out.missing).toEqual([
      { path: '/name', reason: 'not_processed', detail: 'source_page_blocked' },
      { path: '/price', reason: 'not_processed', detail: 'source_page_blocked' },
      { path: '/sku', reason: 'not_processed', detail: 'source_page_blocked' },
    ]);
  });

  it('honours a block classification from the fetch layer', async () => {
    const { client, provider } = fakeClient(NEVER);
    const out = await extractStructured(request(JSONLD_PRODUCT, LISTING_SCHEMA), {
      modelClient: client,
      recipeStore: null,
      sourceBlocked: { reason: 'bot wall\n(403)' },
    });
    expect(provider.calls).toHaveLength(0);
    expect(out.status).toBe('failed');
    expect(out.warnings).toEqual(['source_page_blocked:bot_wall_(403)']);
    expect(out.missing).toEqual([{ path: '/items', reason: 'not_processed', detail: 'source_page_blocked' }]);
  });

  it.each([
    [{ title: 42 }, 'invalid_schema:invalid_schema'],
    [{ type: 'string' }, 'invalid_schema:invalid_schema'],
    [{}, 'invalid_schema:empty_schema'],
    [{ type: 'object', properties: { a: { $ref: 'https://evil.example/x.json' } } }, 'invalid_schema:unsupported_ref'],
    [{ type: 'object', properties: { a: { type: 'string', pattern: '(a+)+$' } } }, 'invalid_schema:unsafe_pattern'],
  ])('fails an invalid schema %j without work', async (schema, prefix) => {
    const { client, provider } = fakeClient(NEVER);
    const out = await extractStructured(request(PLAIN_PRODUCT, schema as Record<string, unknown>), { modelClient: client, recipeStore: null });
    expect(provider.calls).toHaveLength(0);
    expect(out).toMatchObject({ status: 'failed', data: null, schemaValid: false, missing: [] });
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0].startsWith(`${prefix}: `)).toBe(true);
    expect(out.scope.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('extractStructured: contract', () => {
  it('throws only for programmer errors', async () => {
    const deps = { modelClient: null, recipeStore: null };
    await expect(extractStructured({ ...request(PLAIN_PRODUCT, { a: 'string' }), html: undefined as never }, deps)).rejects.toThrow(TypeError);
    await expect(extractStructured({ ...request(PLAIN_PRODUCT, { a: 'string' }), tenantId: '' }, deps)).rejects.toThrow(/tenantId/);
    await expect(extractStructured({ ...request(PLAIN_PRODUCT, { a: 'string' }), deadlineMs: Number.NaN }, deps)).rejects.toThrow(/deadlineMs/);
    await expect(extractStructured({ ...request(PLAIN_PRODUCT, { a: 'string' }), maxCostUsd: -1 }, deps)).rejects.toThrow(/maxCostUsd/);
    await expect(extractStructured(request(PLAIN_PRODUCT, { a: 'string' }), { ...deps, learning: 'sometimes' as never })).rejects.toThrow(/learning/);
    // A schema that is not an object is the customer's problem, not ours.
    const out = await extractStructured({ ...request(PLAIN_PRODUCT, { a: 'string' }), schema: 'nope' as never }, deps);
    expect(out.status).toBe('failed');
  });

  it('survives hostile page content and odd field names', async () => {
    const html = page('<h1>__proto__</h1><p>constructor</p><p>{"records":[{"x":{"v":"1","b":"b0"}}]}</p>'.repeat(3));
    const schema = { type: 'object', properties: { constructor: { type: 'string' }, 'a/b~c': { type: 'string' } } };
    const id = blockId(html, '__proto__');
    const { client } = fakeClient(scripted(fakeResponse(envelope([{ constructor: ['__proto__', id] as [string, string], 'a/b~c': ['constructor', 'b1'] }]))));
    const out = await extractStructured(request(html, schema), { modelClient: client, recipeStore: null });
    expect(out.data).toEqual({ constructor: '__proto__', 'a/b~c': 'constructor' });
    expect(Object.getPrototypeOf(out.data)).toBe(Object.prototype);
    expect(out.evidence.map((e) => e.path)).toEqual(['/constructor', '/a~1b~0c']);
    // A schema using "__proto__" as a field name is rejected up front.
    const proto = await extractStructured(request(html, JSON.parse('{"__proto__": "string"}') as Record<string, unknown>), { modelClient: client, recipeStore: null });
    expect(proto.warnings[0]).toMatch(/^invalid_schema:invalid_schema: /);
  });

  it('works with a recipe store but no recipe and learning off', async () => {
    const { store, kv } = memoryStore();
    const titleId = blockId(PLAIN_PRODUCT, 'Acme Turbo Widget');
    const { client } = fakeClient(scripted(fakeResponse(envelope([{ name: ['Acme Turbo Widget', titleId] }]))));
    const out = await extractStructured(request(PLAIN_PRODUCT, { name: 'string' }), { modelClient: client, recipeStore: store, learning: 'off' });
    expect(out.status).toBe('complete');
    expect(kv.ops.filter((o) => o.startsWith('set'))).toEqual([]);
    expect(out.timings).toHaveProperty('recipe');
  });

  it('keeps going when the recipe store is down', async () => {
    const { store, kv } = memoryStore();
    kv.failWith = new Error('ECONNREFUSED');
    const titleId = blockId(PLAIN_PRODUCT, 'Acme Turbo Widget');
    const { client } = fakeClient(scripted(fakeResponse(envelope([{ name: ['Acme Turbo Widget', titleId] }]))));
    const out = await extractStructured(request(PLAIN_PRODUCT, { name: 'string' }), { modelClient: client, recipeStore: store, learning: 'await' });
    expect(out.status).toBe('complete');
    expect(out.warnings).toEqual(expect.arrayContaining(['recipe_store_unavailable:Error', 'recipe_learning_failed:Error']));
  });
});

describe('extractStructured: robustness', () => {
  it('stops at the deadline even when the model hangs', async () => {
    const { client } = fakeClient(async (_c, req) => {
      await delay(5_000, req.signal);
      return fakeResponse('{"records":[]}');
    });
    const t0 = Date.now();
    const out = await extractStructured(request(PLAIN_PRODUCT, { name: 'string' }, { deadlineMs: Date.now() + 300 }), { modelClient: client, recipeStore: null });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(out.status).toBe('failed');
    expect(out.warnings.some((w) => /^llm_failed:(timeout|budget_exhausted)$/.test(w))).toBe(true);
    expect(out.llm.attempts.length).toBeGreaterThanOrEqual(1);
    expect(out.llm.attempts.every((a) => !a.ok)).toBe(true);
  });

  it('only checks the first record of an object answer', async () => {
    const titleId = blockId(PLAIN_PRODUCT, 'Acme Turbo Widget');
    const many = Array.from({ length: 50 }, (_, i) => ({ name: [i === 0 ? 'Acme Turbo Widget' : `Invented ${i}`, titleId] as [string, string] }));
    const { client } = fakeClient(scripted(fakeResponse(envelope(many))));
    const out = await extractStructured(request(PLAIN_PRODUCT, { type: 'object', properties: { name: { type: 'string' } } }), { modelClient: client, recipeStore: null });
    expect(out.data).toEqual({ name: 'Acme Turbo Widget' });
    expect(out.warnings).toContain('llm_response:expected one record for an object schema, got 50');
    expect(out.warnings.some((w) => w.startsWith('ungrounded_values_rejected'))).toBe(false);
  });

  it('handles values of the wrong JSON type', async () => {
    const priceId = blockId(PLAIN_PRODUCT, '$1,299.00');
    const skuId = blockId(PLAIN_PRODUCT, 'SKU: AC-1001');
    const { client } = fakeClient(scripted(fakeResponse(JSON.stringify({ records: [{ price: { v: 1299, b: priceId }, sku: { v: { code: 'AC-1001' }, b: skuId }, name: { v: ['Acme Turbo Widget'], b: 'b1' } }] }))));
    const out = await extractStructured(request(PLAIN_PRODUCT, PRODUCT_SCHEMA), { modelClient: client, recipeStore: null });
    expect(out.data).toMatchObject({ price: 1299, sku: null });
    expect(out.missing.find((m) => m.path === '/sku')).toMatchObject({ reason: 'unparseable', detail: expect.stringMatching(/type_mismatch/) });
    // An array for a string field is a mismatch, not silently joined.
    expect(out.missing.find((m) => m.path === '/name')).toMatchObject({ reason: 'unparseable', detail: expect.stringMatching(/type_mismatch/) });
    expect(out.status).toBe('partial');
  });

  it('caps missing entries and repeated warnings but keeps the list-level entry', async () => {
    const list = items(1_100);
    const html = listing(list);
    const titlesOnly: FakeHandler = (caps, req, i) => {
      const res = listingModel(caps, req, i) as { text: string };
      const body = JSON.parse(res.text) as { records: Array<Record<string, { v: unknown; b: string | null }>> };
      body.records.forEach((r, n) => {
        r.price = { v: null, b: null };
        // Half cite an unrelated block: the title is elsewhere on the page, so each gets a citation warning.
        if (n % 2 === 0) r.title.b = 'b0';
      });
      return { ...(res as object), text: JSON.stringify(body) } as never;
    };
    const { client } = fakeClient(titlesOnly, { contextTokens: 1_000_000, maxOutputTokens: 100_000 });
    const out = await extractStructured(request(html, LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null });
    expect((out.data as { items: unknown[] }).items).toHaveLength(1_100);
    expect(out.missing).toHaveLength(1_000);
    expect(out.warnings).toContain('missing_entries_capped:100');
    expect(out.warnings.filter((w) => w.startsWith('citation_mismatch:/items/'))).toHaveLength(20);
    expect(out.warnings).toContain('citation_mismatch:+530 more');
  });

  it('keeps non-Latin pages within the model context', async () => {
    const text = '這是一個關於產品的很長的描述，包含許多細節和規格。'.repeat(20);
    const html = page(`<h1>雙層保溫杯</h1><p>¥2,980</p>${Array.from({ length: 60 }, () => `<p>${text}</p>`).join('')}`);
    let estimated = 0;
    const { client } = fakeClient(
      (_c, req) => {
        estimated = estimateTokens(req.system) + estimateTokens(req.user);
        return fakeResponse(envelope([{ name: ['雙層保溫杯', blockId(html, '雙層保溫杯')] }]));
      },
      { contextTokens: 4_000, maxOutputTokens: 1_024 },
    );
    const out = await extractStructured(request(html, { name: 'string' }), { modelClient: client, recipeStore: null });
    expect(out.data).toEqual({ name: '雙層保溫杯' });
    expect(out.scope.truncated).toBe(true);
    expect(estimated + 1_024).toBeLessThanOrEqual(4_000);
  });
});
