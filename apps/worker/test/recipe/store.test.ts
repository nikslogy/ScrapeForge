import { describe, expect, it } from 'vitest';
import { type RecipeKv, RecipeStore } from '../../src/extract/recipe/store.js';
import type { ExtractionRecipe, RecipeKey } from '../../src/extract/types.js';

class MemoryKv implements RecipeKv {
  readonly data = new Map<string, { value: string; ttl: number }>();
  readonly ops: string[] = [];

  async get(k: string): Promise<string | null> {
    this.ops.push(`get ${k}`);
    return this.data.get(k)?.value ?? null;
  }

  async set(k: string, v: string, mode: 'EX', ttl: number): Promise<unknown> {
    this.ops.push(`set ${k} ${mode} ${ttl}`);
    this.data.set(k, { value: v, ttl });
    return 'OK';
  }

  async del(k: string): Promise<unknown> {
    this.ops.push(`del ${k}`);
    return this.data.delete(k) ? 1 : 0;
  }
}

const RECIPE: ExtractionRecipe = {
  version: 1,
  shape: 'array',
  recordSelector: 'article.product_pod',
  fields: { title: { selector: 'h3 a', attr: 'title' }, price: { selector: 'p.price_color' } },
};
const OTHER: ExtractionRecipe = { ...RECIPE, fields: { title: { selector: 'h3' }, price: { selector: '.price' } } };

const KEY: RecipeKey = { tenantId: 'tenant-a', host: 'Books.Example.com', templateSignature: 'tpl123', schemaHash: 'abcdef0123456789' };

function setup(opts = {}): { kv: MemoryKv; store: RecipeStore } {
  const kv = new MemoryKv();
  return { kv, store: new RecipeStore(kv, opts) };
}

describe('RecipeStore keys', () => {
  it('builds the documented key and lower-cases the host', () => {
    const { store } = setup();
    expect(store.key(KEY)).toBe('recipe:v1:tenant-a:books.example.com:tpl123:abcdef0123456789');
  });

  it('escapes ":" and other characters so parts cannot alias each other', () => {
    const { store } = setup();
    const a = store.key({ ...KEY, tenantId: 'a', host: 'b:c' });
    const b = store.key({ ...KEY, tenantId: 'a:b', host: 'c' });
    expect(a).not.toBe(b);
    expect(a.split(':')).toHaveLength(6);
    expect(b.split(':')).toHaveLength(6);
    expect(store.key({ ...KEY, tenantId: '%003a' })).not.toBe(store.key({ ...KEY, tenantId: ':' }));
    expect(store.key({ ...KEY, host: 'example.com:8080' })).toContain('example.com%003a8080');
    expect(store.key({ ...KEY, tenantId: 'a\ud800b' })).toContain('a%d800b');
  });

  it('hashes very long parts and rejects empty ones', () => {
    const { store } = setup();
    const long = store.key({ ...KEY, templateSignature: 'x'.repeat(500) });
    expect(long.length).toBeLessThan(150);
    expect(long).toMatch(/:#[0-9a-f]{32}:/);
    expect(store.key({ ...KEY, templateSignature: 'y'.repeat(500) })).not.toBe(long);
    expect(() => store.key({ ...KEY, tenantId: '' })).toThrow(/tenantId/);
    expect(() => store.key({ ...KEY, schemaHash: undefined as unknown as string })).toThrow(/schemaHash/);
  });
});

describe('RecipeStore lifecycle', () => {
  it('candidate → active after agreeing on 2 more distinct snapshots', async () => {
    const { kv, store } = setup();
    const saved = await store.saveCandidate(KEY, RECIPE, { snapshotHash: 's1', requiredFields: ['title', 'price'], recordCount: 20 });
    expect(saved.saved).toBe(true);
    expect((await store.get(KEY))?.state).toBe('candidate');
    expect([...kv.data.values()][0].ttl).toBe(14 * 24 * 3600);

    // Same snapshot again is not a new agreement.
    expect((await store.recordAgreement(KEY, 's1'))?.validatedOn).toEqual(['s1']);
    expect((await store.recordAgreement(KEY, 's2', { recordCount: 18 }))?.state).toBe('candidate');
    const active = await store.recordAgreement(KEY, 's3', { recordCount: 24 });
    expect(active).toMatchObject({ state: 'active', validatedOn: ['s1', 's2', 's3'], recordCount: { min: 18, max: 24 }, failures: 0, uses: 0 });
    expect((await store.get(KEY))?.recipe).toEqual(RECIPE);
  });

  it('saving the same recipe again counts as agreement; a different one replaces a candidate', async () => {
    const { store } = setup();
    await store.saveCandidate(KEY, RECIPE, { snapshotHash: 's1', requiredFields: ['title'] });
    const reordered: ExtractionRecipe = { fields: { price: RECIPE.fields.price, title: RECIPE.fields.title }, recordSelector: RECIPE.recordSelector, shape: 'array', version: 1 };
    const again = await store.saveCandidate(KEY, reordered, { snapshotHash: 's2', requiredFields: ['title'] });
    expect(again.saved && again.stored.validatedOn).toEqual(['s1', 's2']);
    const replaced = await store.saveCandidate(KEY, OTHER, { snapshotHash: 's9', requiredFields: ['price'] });
    expect(replaced.saved && replaced.stored).toMatchObject({ validatedOn: ['s9'], state: 'candidate', requiredFields: ['price'] });
    expect((await store.get(KEY))?.recipe).toEqual(OTHER);
  });

  it('never overwrites an active recipe', async () => {
    const { store } = setup({ promoteAfter: 0 });
    const first = await store.saveCandidate(KEY, RECIPE, { snapshotHash: 's1', requiredFields: [] });
    expect(first.saved && first.stored.state).toBe('active');
    expect(await store.saveCandidate(KEY, OTHER, { snapshotHash: 's2', requiredFields: [] })).toEqual({ saved: false, reason: 'active-exists' });
    expect((await store.get(KEY))?.recipe).toEqual(RECIPE);
  });

  it('rejects invalid recipes and required fields that are not in the recipe', async () => {
    const { kv, store } = setup();
    const bad = { ...RECIPE, fields: { title: { selector: 'h3:contains(x)' } } } as ExtractionRecipe;
    expect(await store.saveCandidate(KEY, bad, { snapshotHash: 's1', requiredFields: [] })).toMatchObject({ saved: false, reason: 'invalid' });
    expect(await store.saveCandidate(KEY, RECIPE, { snapshotHash: 's1', requiredFields: ['nope'] })).toMatchObject({ saved: false, reason: 'invalid' });
    expect(await store.saveCandidate(KEY, RECIPE, { snapshotHash: '', requiredFields: [] })).toMatchObject({ saved: false, reason: 'invalid' });
    expect(kv.data.size).toBe(0);
  });

  it('a disagreement deletes a candidate and counts as a failure for an active recipe', async () => {
    const { kv, store } = setup();
    await store.saveCandidate(KEY, RECIPE, { snapshotHash: 's1', requiredFields: [] });
    expect(await store.recordDisagreement(KEY)).toBeNull();
    expect(kv.data.size).toBe(0);

    const { store: s2 } = setup({ promoteAfter: 0 });
    await s2.saveCandidate(KEY, RECIPE, { snapshotHash: 's1', requiredFields: [] });
    expect((await s2.recordDisagreement(KEY))?.failures).toBe(1);
    expect(await s2.recordDisagreement(KEY)).toBeNull();
    expect(await s2.get(KEY)).toBeNull();
  });

  it('drift invalidation: consecutive failed uses delete an active recipe; a success resets the count', async () => {
    const { store } = setup({ promoteAfter: 0, maxConsecutiveFailures: 2 });
    await store.saveCandidate(KEY, RECIPE, { snapshotHash: 's1', requiredFields: [] });
    expect(await store.recordUse(KEY, true)).toMatchObject({ uses: 1, failures: 0 });
    expect(await store.recordUse(KEY, false)).toMatchObject({ uses: 2, failures: 1 });
    expect(await store.recordUse(KEY, true)).toMatchObject({ uses: 3, failures: 0 });
    expect(await store.recordUse(KEY, false)).toMatchObject({ failures: 1 });
    expect(await store.recordUse(KEY, false)).toBeNull();
    expect(await store.get(KEY)).toBeNull();
    expect(await store.recordUse(KEY, true)).toBeNull();
  });

  it('a failed use of a candidate deletes it', async () => {
    const { store } = setup();
    await store.saveCandidate(KEY, RECIPE, { snapshotHash: 's1', requiredFields: [] });
    expect(await store.recordUse(KEY, false)).toBeNull();
  });

  it('operations on missing keys are no-ops', async () => {
    const { kv, store } = setup();
    expect(await store.get(KEY)).toBeNull();
    expect(await store.recordAgreement(KEY, 's1')).toBeNull();
    expect(await store.recordDisagreement(KEY)).toBeNull();
    expect(await store.recordUse(KEY, true)).toBeNull();
    expect(kv.data.size).toBe(0);
  });

  it('remembers at most 20 snapshots', async () => {
    const { store } = setup({ promoteAfter: 100 });
    await store.saveCandidate(KEY, RECIPE, { snapshotHash: 's0', requiredFields: [] });
    for (let i = 1; i < 30; i++) await store.recordAgreement(KEY, `s${i}`);
    const stored = await store.get(KEY);
    expect(stored?.validatedOn).toHaveLength(20);
    expect(stored?.validatedOn.at(-1)).toBe('s29');
  });

  it('falls back to defaults for invalid options', async () => {
    const { kv, store } = setup({ ttlSec: -5, promoteAfter: 1.5, maxConsecutiveFailures: 0 });
    await store.saveCandidate(KEY, RECIPE, { snapshotHash: 's1', requiredFields: [] });
    expect([...kv.data.values()][0].ttl).toBe(14 * 24 * 3600);
    await store.recordAgreement(KEY, 's2');
    expect((await store.get(KEY))?.state).toBe('candidate');
  });
});

describe('RecipeStore isolation and corruption', () => {
  it('a recipe saved for tenant A is never returned for tenant B', async () => {
    const { store } = setup({ promoteAfter: 0 });
    await store.saveCandidate(KEY, RECIPE, { snapshotHash: 's1', requiredFields: [] });
    expect(await store.get(KEY)).not.toBeNull();
    expect(await store.get({ ...KEY, tenantId: 'tenant-b' })).toBeNull();
    expect(await store.get({ ...KEY, tenantId: 'tenant-a ' })).toBeNull();
    expect(await store.get({ ...KEY, tenantId: 'TENANT-A' })).toBeNull();
    expect(await store.get({ ...KEY, schemaHash: 'other' })).toBeNull();
    expect(await store.get({ ...KEY, templateSignature: 'other' })).toBeNull();
    expect(await store.get({ ...KEY, host: 'books.example.com' })).not.toBeNull();
    // Usage signals from tenant B never touch tenant A's recipe.
    expect(await store.recordUse({ ...KEY, tenantId: 'tenant-b' }, false)).toBeNull();
    expect(await store.recordDisagreement({ ...KEY, tenantId: 'tenant-b' })).toBeNull();
    expect((await store.get(KEY))?.failures).toBe(0);
  });

  it.each([
    ['not json', '{oops'],
    ['wrong type', '[1,2]'],
    ['null', 'null'],
    ['invalid recipe', JSON.stringify({ recipe: { version: 1, shape: 'object', fields: { a: { transforms: [{ regex: '(a+)+' }] } } }, state: 'active', createdAt: 'x', validatedOn: ['s'], uses: 0, failures: 0, requiredFields: [] })],
    ['unknown state', JSON.stringify({ recipe: RECIPE, state: 'trusted', createdAt: 'x', validatedOn: ['s'], uses: 0, failures: 0, requiredFields: [] })],
    ['bad counters', JSON.stringify({ recipe: RECIPE, state: 'active', createdAt: 'x', validatedOn: ['s'], uses: -1, failures: 0, requiredFields: [] })],
    ['empty validatedOn', JSON.stringify({ recipe: RECIPE, state: 'active', createdAt: 'x', validatedOn: [], uses: 0, failures: 0, requiredFields: [] })],
    ['unknown required field', JSON.stringify({ recipe: RECIPE, state: 'active', createdAt: 'x', validatedOn: ['s'], uses: 0, failures: 0, requiredFields: ['zzz'] })],
    ['bad record count', JSON.stringify({ recipe: RECIPE, state: 'active', createdAt: 'x', validatedOn: ['s'], uses: 0, failures: 0, requiredFields: [], recordCount: { min: 5, max: 2 } })],
    ['too large', `{"pad":"${'x'.repeat(1_000_001)}"}`],
  ])('corrupt entry (%s) is treated as missing and deleted', async (_name, raw) => {
    const { kv, store } = setup();
    kv.data.set(store.key(KEY), { value: raw, ttl: 1 });
    expect(await store.get(KEY)).toBeNull();
    expect(kv.data.has(store.key(KEY))).toBe(false);
    expect(kv.ops).toContain(`del ${store.key(KEY)}`);
  });

  it('a corrupt entry does not block saving a new candidate', async () => {
    const { kv, store } = setup();
    kv.data.set(store.key(KEY), { value: '{"state":"active"}', ttl: 1 });
    const r = await store.saveCandidate(KEY, RECIPE, { snapshotHash: 's1', requiredFields: [] });
    expect(r.saved).toBe(true);
  });

  it('stored recipes come back validated and frozen', async () => {
    const { store } = setup();
    await store.saveCandidate(KEY, RECIPE, { snapshotHash: 's1', requiredFields: ['title'] });
    const stored = await store.get(KEY);
    expect(Object.isFrozen(stored?.recipe)).toBe(true);
  });
});
