// Pages larger than one model call, answered as one object: the blocks most
// relevant to the requested fields are sent (BM25 over text, headings and
// attributes, plus the top of the page), not the first N characters.

import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../../../tests/fixtures/extraction/load.js';
import { oracleHandler } from '../../../../tests/engine/oracle.js';
import { scoreExtraction } from '../../../../tests/engine/scoring.js';
import { buildSourceDocument, queryTerms, scoreBlocks, selectBlocks } from '../../src/extract/document/index.js';
import { normalizeSchema } from '../../src/extract/schema/index.js';
import { extractStructured } from '../../src/extract/index.js';
import { fakeClient } from './helpers.js';

const fixture = loadFixture('value-at-end');
// Small enough that the article does not fit: version and license sit in its last 1%.
const SMALL = { contextTokens: 6_000, maxOutputTokens: 1_024 };

async function run(disable?: Array<'select'>) {
  const { client, provider } = fakeClient(oracleHandler(fixture), SMALL);
  const outcome = await extractStructured(
    { html: fixture.html, url: fixture.url, schema: fixture.schema, tenantId: 't', deadlineMs: Date.now() + 60_000, includeEvidence: true, ...(disable ? { disable } : {}) },
    { modelClient: client, recipeStore: null, learning: 'off' },
  );
  return { outcome, provider };
}

describe('targeted selection', () => {
  it('finds values at the end of a page that does not fit, in one call', async () => {
    const { outcome, provider } = await run();
    expect(provider.calls).toHaveLength(1);
    expect(outcome.scope.strategy).toBe('selected');
    expect(outcome.scope.blocksSentToModel).toBeLessThan(outcome.scope.blocksTotal);
    expect(outcome.data).toMatchObject({ version: '3.14.2', license: 'Apache-2.0' });
    const score = scoreExtraction(fixture, outcome.data);
    expect(score.valuePrecision).toBe(1);
    expect(score.valueRecall).toBe(1);
    expect(outcome.status).toBe('complete');
    expect(outcome.scope.truncated).toBe(false);
    expect(outcome.warnings.some((w) => w.startsWith('input_selected:'))).toBe(true);
  });

  it('without selection the same page is cut from the end and reported partial', async () => {
    const { outcome } = await run(['select']);
    expect(outcome.scope.strategy).toBe('single');
    expect(outcome.scope.truncated).toBe(true);
    expect(outcome.status).toBe('partial');
    expect(outcome.missing.find((m) => m.path === '/version')?.reason).toBe('not_processed');
  });

  it('a field the selection did not find is not_processed (it may be in the rest), never not_found', async () => {
    const schema = { ...(fixture.schema as Record<string, unknown>) };
    const props = { ...(schema.properties as Record<string, unknown>), isbn: { type: ['string', 'null'], description: 'ISBN of the printed edition' } };
    const { client } = fakeClient(oracleHandler({ ...fixture, gold: { ...(fixture.gold as object), isbn: null } }), SMALL);
    const outcome = await extractStructured(
      { html: fixture.html, url: fixture.url, schema: { ...schema, properties: props }, tenantId: 't', deadlineMs: Date.now() + 60_000 },
      { modelClient: client, recipeStore: null, learning: 'off' },
    );
    expect(outcome.scope.strategy).toBe('selected');
    expect(outcome.missing.find((m) => m.path === '/isbn')).toMatchObject({ reason: 'not_processed', detail: expect.stringContaining('most relevant') });
    expect(outcome.status).toBe('partial');
    expect(outcome.scope.truncated).toBe(true);
  });

  it('scores the release block above the body for version/license', () => {
    const doc = buildSourceDocument(fixture.html, fixture.url);
    const fields = normalizeSchema(fixture.schema).fields;
    const scores = scoreBlocks(doc, queryTerms(fields));
    const release = doc.blocks.findIndex((b) => b.text.includes('3.14.2'));
    expect(release).toBeGreaterThan(doc.blocks.length * 0.8);
    const rank = [...scores].filter((s) => s > scores[release]).length;
    expect(rank).toBeLessThan(10);
  });

  it('keeps the top of the page and stays within the budget, in document order', () => {
    const doc = buildSourceDocument(fixture.html, fixture.url);
    const fields = normalizeSchema(fixture.schema).fields;
    const { blockIds } = selectBlocks(doc, fields, 4_000);
    expect(blockIds[0]).toBe(doc.blocks[0].id);
    const order = blockIds.map((id) => doc.blocks.findIndex((b) => b.id === id));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const chars = blockIds.reduce((n, id) => n + doc.blocks.find((b) => b.id === id)!.text.length, 0);
    expect(chars).toBeLessThanOrEqual(4_000);
  });

  it('has no effect on pages that fit', async () => {
    const small = loadFixture('book-pdp-plain');
    const { client, provider } = fakeClient(oracleHandler(small));
    const outcome = await extractStructured(
      { html: small.html, url: small.url, schema: small.schema, tenantId: 't', deadlineMs: Date.now() + 60_000, disable: ['structured'] },
      { modelClient: client, recipeStore: null, learning: 'off' },
    );
    expect(provider.calls).toHaveLength(1);
    expect(outcome.scope.strategy).toBe('single');
    expect(outcome.warnings.some((w) => w.startsWith('input_selected'))).toBe(false);
  });
});
