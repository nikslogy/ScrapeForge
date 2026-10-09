// An expired request deadline is not recipe drift: the local recipe still
// answers (it needs no model), and the stored recipe is not penalized.

import { afterEach, describe, expect, it } from 'vitest';
import { buildSourceDocument } from '../../src/extract/document/index.js';
import { extractStructured, flushRecipeLearning } from '../../src/extract/engine.js';
import { normalizeSchema } from '../../src/extract/schema/index.js';
import { fakeClient, items, listing, LISTING_SCHEMA, LISTING_URL, listingModel, memoryStore, request } from './helpers.js';

afterEach(async () => {
  await flushRecipeLearning();
});

describe('active recipe and an expired request deadline', () => {
  it('serves the recipe and does not count a drift failure', async () => {
    const snapshots = [0, 20, 40, 60, 80, 100].map((o) => listing(items(20, o)));
    const key = {
      tenantId: 'tenant-1',
      host: new URL(LISTING_URL).hostname,
      templateSignature: buildSourceDocument(snapshots[0], LISTING_URL).templateSignature,
      schemaHash: normalizeSchema(LISTING_SCHEMA).hash,
    };
    const { store } = memoryStore();
    const { client, provider } = fakeClient(listingModel);
    const run = (html: string, deadlineMs = Date.now() + 30_000) =>
      extractStructured(request(html, LISTING_SCHEMA, { url: LISTING_URL, deadlineMs }), { modelClient: client, recipeStore: store, learning: 'await' });

    for (const html of snapshots.slice(0, 3)) await run(html);
    expect((await store.get(key))?.state).toBe('active');
    const callsBefore = provider.calls.length;

    // Two late requests (the fetch used up the timeout).
    for (const html of snapshots.slice(3, 5)) {
      const out = await run(html, Date.now() - 1);
      expect(out.method).toBe('recipe');
      expect(out.status).toBe('complete');
      expect((out.data as { items: unknown[] }).items).toHaveLength(20);
      expect(out.warnings.some((w) => w.startsWith('recipe_rejected'))).toBe(false);
      expect(await store.get(key)).toMatchObject({ state: 'active', failures: 0 });
    }
    expect(provider.calls.length).toBe(callsBefore);

    const next = await run(snapshots[5]);
    expect(next.method).toBe('recipe');
  });
});
