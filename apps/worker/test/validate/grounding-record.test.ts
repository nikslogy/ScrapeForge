// Grounding against the attributes of a record's blocks (recordAttrs): a value
// printed only in an attribute (class="star-rating Four", an href) is verified
// when the model cites another block of the same product card, never from a
// different card, and numbers are not "found" in class names or URLs.

import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../../../tests/fixtures/extraction/load.js';
import { scoreExtraction } from '../../../../tests/engine/scoring.js';
import { blockContext, buildSourceDocument } from '../../src/extract/document/index.js';
import { extractStructured } from '../../src/extract/engine.js';
import { CircuitBreaker, FakeProvider, fakeCaps, ModelClient, type FakeHandler } from '../../src/extract/llm/index.js';
import type { SourceDocument } from '../../src/extract/types.js';
import { checkGrounding } from '../../src/extract/validate/grounding.js';

const card = [{ class: 'product_pod' }, { href: 'https://books.example.com/b/1' }, { class: 'star-rating Three' }, { class: 'price_color col-4' }];

describe('checkGrounding: record attributes', () => {
  it('an attribute-only value of a sibling block is grounded as "record"', () => {
    expect(checkGrounding('Three', { blockText: '£51.77', recordText: 'A Light in the Attic £51.77', recordAttrs: card })).toEqual({ grounded: true, where: 'record', score: 1 });
    expect(checkGrounding('https://books.example.com/b/1', { blockText: '£51.77', recordAttrs: card }).where).toBe('record');
    // Without the record's attributes it is not.
    expect(checkGrounding('Three', { blockText: '£51.77', recordText: 'A Light in the Attic £51.77' }).grounded).toBe(false);
  });

  it('keeps the closer locations first', () => {
    expect(checkGrounding('£51.77', { blockText: '£51.77', recordAttrs: [{ 'data-price': '51.77' }] }).where).toBe('block');
    expect(checkGrounding('Three', { blockText: 'x', attrs: { class: 'star-rating Three' }, recordAttrs: card }).where).toBe('attrs');
    expect(checkGrounding('A Light', { blockText: 'x', recordText: 'A Light in the Attic', recordAttrs: [{ title: 'A Light' }] }).where).toBe('record');
    expect(checkGrounding('Elsewhere', { blockText: 'x', recordAttrs: card, documentText: 'Elsewhere on the page' }).where).toBe('document');
  });

  it('numbers come only from value attributes, never from class names or URLs', () => {
    for (const raw of [4, '4', 1, '1']) {
      expect(checkGrounding(raw, { blockText: 'x', recordAttrs: card }).grounded, String(raw)).toBe(false);
    }
    expect(checkGrounding(4, { blockText: 'x', recordAttrs: [{ 'aria-label': 'Rated 4 out of 5' }] }).where).toBe('record');
    expect(checkGrounding('4.5', { blockText: 'x', recordAttrs: [{ 'data-rating': '4.5' }] }).where).toBe('record');
    expect(checkGrounding(1299, { blockText: 'x', recordAttrs: [{ content: '1,299.00' }] }).where).toBe('record');
    expect(checkGrounding(3, { blockText: 'x', recordAttrs: [{ href: '/p/3' }, { class: 'col-3' }, { src: '/img/3.jpg' }] }).grounded).toBe(false);
  });

  it('matches never span two attribute values', () => {
    expect(checkGrounding('Three Four', { blockText: 'x', recordAttrs: [{ class: 'star-rating Three' }, { class: 'Four' }] }).grounded).toBe(false);
  });

  it('tolerates junk', () => {
    const junk = [null, 5, { a: 7 as unknown as string }, { b: '' }] as unknown as Array<Record<string, string>>;
    expect(checkGrounding('x', { blockText: 'y', recordAttrs: junk }).grounded).toBe(false);
    expect(checkGrounding('x', { blockText: 'y', recordAttrs: 'class' as unknown as Array<Record<string, string>> }).grounded).toBe(false);
    expect(checkGrounding('Three', { blockText: 'y', recordAttrs: [] }).grounded).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// Engine: a model citing the price block for every field of a card
// ─────────────────────────────────────────────────────────────

const books = loadFixture('books-listing');
const doc = buildSourceDocument(books.html, books.url);
const gold = books.gold as Array<{ title: string; price: number; rating: number; inStock: boolean; url: string }>;
const RATING_WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five'];

/** Card blocks of every product: the record and its price block. */
function cards(d: SourceDocument): Array<{ record: string; price: string; other?: string }> {
  const group = d.recordGroups[0];
  return group.recordIds.map((record) => {
    const inside = d.blocks.filter((b) => b.parentId === record);
    return { record, price: inside.find((b) => /^£/.test(b.text))!.id };
  });
}

function respond(records: unknown[]): ReturnType<FakeHandler> {
  return { text: JSON.stringify({ records }), finishReason: 'stop', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 };
}

async function run(handler: FakeHandler) {
  const provider = new FakeProvider(handler);
  const client = new ModelClient({ models: [fakeCaps()], providers: { fake: provider }, breaker: new CircuitBreaker() });
  return extractStructured(
    { html: books.html, url: books.url, schema: books.schema, tenantId: 't', deadlineMs: Date.now() + 60_000, includeEvidence: true },
    { modelClient: client, recipeStore: null, learning: 'off' },
  );
}

describe('engine: attribute-only values cited from a sibling block', () => {
  const blocks = cards(doc);

  it('books-listing: rating ("Four" in a class) and url (an href) cited from the price block are accepted', async () => {
    expect(blocks).toHaveLength(gold.length);
    expect(blockContext(doc, blocks[0].price)?.recordAttrs).toContainEqual({ class: 'star-rating Four' });
    const outcome = await run(() =>
      respond(
        gold.map((g, i) => {
          const b = blocks[i].price;
          return {
            title: { v: g.title, b },
            price: { v: `£${g.price.toFixed(2)}`, b },
            rating: { v: RATING_WORDS[g.rating], b },
            inStock: { v: g.inStock ? 'In stock' : 'Out of stock', b },
            url: { v: g.url, b },
          };
        }),
      ),
    );
    const score = scoreExtraction(books, outcome.data);
    expect(score.valuePrecision).toBe(1);
    expect(score.valueRecall).toBe(1);
    expect(outcome.missing).toEqual([]);
    expect(outcome.status).toBe('complete');
    expect(outcome.warnings.filter((w) => w.startsWith('citation_mismatch') || w.startsWith('ungrounded'))).toEqual([]);
    const rating = outcome.evidence.find((e) => e.path === '/books/0/rating');
    expect(rating).toMatchObject({ grounded: true, blockId: blocks[0].price, raw: 'Four' });
  });

  it('a value from another card is still rejected (precision does not drop)', async () => {
    const outcome = await run(() =>
      respond(
        gold.map((g, i) => {
          // Cite card i but report card i+1's attribute-only values.
          const next = gold[(i + 1) % gold.length];
          const b = blocks[i].price;
          return {
            title: { v: g.title, b },
            price: { v: `£${g.price.toFixed(2)}`, b },
            rating: { v: RATING_WORDS[next.rating], b },
            inStock: { v: g.inStock ? 'In stock' : 'Out of stock', b },
            url: { v: next.url, b },
          };
        }),
      ),
    );
    const score = scoreExtraction(books, outcome.data);
    expect(score.valuePrecision, JSON.stringify(score.mismatches.slice(0, 5))).toBe(1);
    const urls = (outcome.data as { books: Array<{ url: string | null }> }).books.map((r) => r.url);
    // Every url belongs to another card: none may be accepted as this card's.
    expect(urls.every((u) => u === null)).toBe(true);
    expect(outcome.missing.filter((m) => m.path.endsWith('/url')).every((m) => m.reason === 'rejected_ungrounded')).toBe(true);
    // A rating word of another card is accepted only when this card's classes contain it too.
    const ratings = (outcome.data as { books: Array<{ rating: number | null }> }).books.map((r) => r.rating);
    ratings.forEach((r, i) => {
      if (r !== null) expect(r).toBe(gold[i].rating);
    });
  });
});
