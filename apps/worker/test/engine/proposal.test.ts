// Model-proposed recipes: used only when deterministic induction finds no
// recipe, so induction is stubbed out for this file.

import { describe, expect, it, vi } from 'vitest';
import { buildSourceDocument } from '../../src/extract/document/index.js';
import { extractStructured, flushRecipeLearning } from '../../src/extract/engine.js';
import type { FakeHandler } from '../../src/extract/llm/index.js';
import { normalizeSchema } from '../../src/extract/schema/index.js';
import type { ExtractionRecipe, RecipeKey } from '../../src/extract/types.js';
import { fakeClient, items, listing, LISTING_SCHEMA, LISTING_URL, listingModel, memoryStore, request } from './helpers.js';

vi.mock('../../src/extract/recipe/induce.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/extract/recipe/induce.js')>();
  return { ...actual, induceRecipe: () => ({ recipe: null, coverage: 0, notes: ['stubbed for this test file'] }) };
});

const HTML = listing(items(20));
const KEY: RecipeKey = {
  tenantId: 'tenant-1',
  host: 'gadgets.example.com',
  templateSignature: buildSourceDocument(HTML, LISTING_URL).templateSignature,
  schemaHash: normalizeSchema(LISTING_SCHEMA).hash,
};

const PROPOSAL: ExtractionRecipe = {
  version: 1,
  shape: 'array',
  recordSelector: 'article.product',
  fields: { title: { selector: 'h3 a' }, price: { selector: 'p.price' } },
};

function proposingModel(reply: unknown): FakeHandler {
  return (caps, req, i) => {
    if (req.system.includes('declarative extraction recipes')) {
      const text = typeof reply === 'string' ? reply : JSON.stringify(reply);
      return { text, finishReason: 'stop', inputTokens: 300, outputTokens: 60, costUsd: 0.0005, latencyMs: 1 };
    }
    return listingModel(caps, req, i);
  };
}

function run(handler: FakeHandler, opts: { proposeRecipes?: boolean; learning?: 'await' | 'background'; maxCostUsd?: number } = {}) {
  const { store } = memoryStore();
  const { client, provider } = fakeClient(handler);
  const outcome = extractStructured(request(HTML, LISTING_SCHEMA, { url: LISTING_URL, ...(opts.maxCostUsd !== undefined ? { maxCostUsd: opts.maxCostUsd } : {}) }), {
    modelClient: client,
    recipeStore: store,
    learning: opts.learning ?? 'await',
    ...(opts.proposeRecipes !== undefined ? { proposeRecipes: opts.proposeRecipes } : {}),
  });
  return { outcome, store, provider };
}

describe('model-proposed recipes', () => {
  it('are off unless enabled (EXTRACT_RECIPE_PROPOSE=1 or deps.proposeRecipes)', async () => {
    const prev = process.env.EXTRACT_RECIPE_PROPOSE;
    delete process.env.EXTRACT_RECIPE_PROPOSE;
    try {
      const { outcome, store, provider } = run(proposingModel(PROPOSAL));
      await outcome;
      expect(provider.calls).toHaveLength(1);
      expect(await store.get(KEY)).toBeNull();
    } finally {
      if (prev !== undefined) process.env.EXTRACT_RECIPE_PROPOSE = prev;
    }
  });

  it('honours EXTRACT_RECIPE_PROPOSE=1', async () => {
    const prev = process.env.EXTRACT_RECIPE_PROPOSE;
    process.env.EXTRACT_RECIPE_PROPOSE = '1';
    try {
      const { outcome, store, provider } = run(proposingModel(PROPOSAL));
      await outcome;
      expect(provider.calls).toHaveLength(2);
      expect((await store.get(KEY))?.state).toBe('candidate');
    } finally {
      if (prev === undefined) delete process.env.EXTRACT_RECIPE_PROPOSE;
      else process.env.EXTRACT_RECIPE_PROPOSE = prev;
    }
  });

  it('saves a proposal that reproduces the grounded result and reports its cost', async () => {
    const { outcome, store, provider } = run(proposingModel(PROPOSAL), { proposeRecipes: true });
    const out = await outcome;
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].req.user).toContain('Expected values for the first records');
    expect(out.llm.attempts.map((a) => a.purpose)).toEqual(['extract', 'recipe']);
    expect(out.llm.calls).toBe(2);
    expect(out.llm.costUsd).toBeCloseTo(0.0015);
    const stored = await store.get(KEY);
    expect(stored).toMatchObject({ state: 'candidate', recipe: PROPOSAL, requiredFields: ['title', 'price'] });
  });

  it.each([
    ['a recipe that disagrees', { ...PROPOSAL, fields: { title: { selector: 'h3 a' }, price: { selector: 'button' } } }],
    ['a recipe missing a field', { ...PROPOSAL, fields: { title: { selector: 'h3 a' } } }],
    ['an object recipe for a listing', { version: 1, shape: 'object', fields: { title: { selector: 'h3 a' }, price: { selector: 'p.price' } } }],
    ['script instead of data', 'function extract(doc) { return doc.querySelectorAll("h3") }'],
    ['an invalid selector', { ...PROPOSAL, recordSelector: 'article:contains("x")' }],
  ])('rejects %s', async (_label, reply) => {
    const { outcome, store, provider } = run(proposingModel(reply), { proposeRecipes: true });
    const out = await outcome;
    expect(provider.calls).toHaveLength(2);
    expect(out.status).toBe('complete');
    expect(await store.get(KEY)).toBeNull();
  });

  it('is bounded by the request spend cap', async () => {
    const { outcome, provider } = run(
      (caps, req, i) => ({ ...(listingModel(caps, req, i) as object), costUsd: 0.01 }) as never,
      { proposeRecipes: true, maxCostUsd: 0.01 },
    );
    await outcome;
    expect(provider.calls).toHaveLength(1);
  });

  it('runs after the answer in background mode', async () => {
    const { outcome, store, provider } = run(proposingModel(PROPOSAL), { proposeRecipes: true, learning: 'background' });
    const out = await outcome;
    expect(out.llm.calls).toBe(1);
    await flushRecipeLearning();
    expect(provider.calls).toHaveLength(2);
    expect((await store.get(KEY))?.recipe).toEqual(PROPOSAL);
  });
});
