import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../../../tests/fixtures/extraction/load.js';
import { blockContext, buildSourceDocument, RECORD_ATTR_LIMITS } from '../../src/extract/document/index.js';
import type { SourceBlock, SourceDocument } from '../../src/extract/types.js';
import { listingPage } from './fixtures.js';

function block(over: Partial<SourceBlock> & Pick<SourceBlock, 'id' | 'kind'>): SourceBlock {
  return { text: '', headingPath: [], selector: 'html > body', start: 0, end: 0, ...over };
}

function docOf(blocks: SourceBlock[]): SourceDocument {
  return {
    url: 'https://x.test/',
    snapshotHash: '0'.repeat(64),
    text: '',
    blocks,
    structured: [],
    recordGroups: [],
    templateSignature: '0'.repeat(16),
    stats: { rawBytes: 0, blockCount: blocks.length, textChars: 0, buildMs: 0 },
  };
}

describe('blockContext: record attributes', () => {
  it('books-listing: every block of a card sees the attributes of the whole card', () => {
    const f = loadFixture('books-listing');
    const doc = buildSourceDocument(f.html, f.url);
    const record = doc.blocks.find((b) => b.id === doc.recordGroups[0].recordIds[0]) as SourceBlock;
    const inside = doc.blocks.filter((b) => b.parentId === record.id);
    const price = inside.find((b) => b.text.startsWith('£')) as SourceBlock;
    const ctx = blockContext(doc, price.id);
    expect(ctx?.record).toBe(record);
    expect(ctx?.recordAttrs).toContainEqual({ class: 'star-rating Four' });
    expect(ctx?.recordAttrs).toContainEqual(expect.objectContaining({ href: 'https://books.toscrape.com/catalogue/sharp-objects_997/index.html' }));
    // One array per record: callers can cache work on it.
    for (const b of [record, ...inside]) expect(blockContext(doc, b.id)?.recordAttrs).toBe(ctx?.recordAttrs);
    expect(Object.isFrozen(ctx?.recordAttrs)).toBe(true);
    // The next card has its own.
    const second = doc.blocks.find((b) => b.id === doc.recordGroups[0].recordIds[1]) as SourceBlock;
    expect(blockContext(doc, second.id)?.recordAttrs).not.toContainEqual({ class: 'star-rating Four' });
  });

  it('blocks outside records have none', () => {
    const doc = buildSourceDocument(listingPage(3), 'https://books.example.com/c/index.html');
    const outside = doc.blocks.find((b) => b.parentId === undefined && b.kind !== 'record') as SourceBlock;
    expect(blockContext(doc, outside.id)?.recordAttrs).toBeUndefined();
  });

  it('nested records: the nearest record and everything inside it, nothing after it', () => {
    const doc = docOf([
      block({ id: 'b0', kind: 'record', attrs: { class: 'outer' } }),
      block({ id: 'b1', kind: 'field', parentId: 'b0', attrs: { href: '/a' } }),
      block({ id: 'b2', kind: 'record', parentId: 'b0', attrs: { class: 'inner' } }),
      block({ id: 'b3', kind: 'field', parentId: 'b2', attrs: { class: 'star-rating Two' } }),
      block({ id: 'b4', kind: 'field', parentId: 'b0', attrs: { 'data-sku': 'X1' } }),
      block({ id: 'b5', kind: 'field', attrs: { class: 'after' } }),
    ]);
    expect(blockContext(doc, 'b3')?.recordAttrs).toEqual([{ class: 'inner' }, { class: 'star-rating Two' }]);
    expect(blockContext(doc, 'b1')?.recordAttrs).toEqual([{ class: 'outer' }, { href: '/a' }, { class: 'inner' }, { class: 'star-rating Two' }, { 'data-sku': 'X1' }]);
    expect(blockContext(doc, 'b0')?.recordAttrs).toBe(blockContext(doc, 'b1')?.recordAttrs);
    expect(blockContext(doc, 'b5')?.recordAttrs).toBeUndefined();
  });

  it('a record without attributes anywhere has none', () => {
    const doc = docOf([block({ id: 'b0', kind: 'record' }), block({ id: 'b1', kind: 'field', parentId: 'b0', text: 'x' }), block({ id: 'b2', kind: 'field', parentId: 'b0', attrs: {} })]);
    expect(blockContext(doc, 'b1')?.recordAttrs).toBeUndefined();
  });

  it('is bounded on huge records', () => {
    const blocks = [block({ id: 'b0', kind: 'record' })];
    for (let i = 1; i <= 5_000; i++) blocks.push(block({ id: `b${i}`, kind: 'field', parentId: 'b0', attrs: { 'data-x': 'v'.repeat(100) } }));
    const doc = docOf(blocks);
    const t0 = performance.now();
    const attrs = blockContext(doc, 'b4000')?.recordAttrs ?? [];
    expect(performance.now() - t0).toBeLessThan(50);
    expect(attrs.length).toBeLessThanOrEqual(RECORD_ATTR_LIMITS.maxAttrMaps);
    expect(attrs.reduce((n, a) => n + Object.values(a).join('').length, 0)).toBeLessThanOrEqual(RECORD_ATTR_LIMITS.maxChars);
    // Cached: a second card lookup does not rescan.
    const t1 = performance.now();
    for (let i = 1; i < 2_000; i++) blockContext(doc, `b${i}`);
    expect(performance.now() - t1).toBeLessThan(100);
  });

  it('does not mutate the document', () => {
    const doc = buildSourceDocument(listingPage(3), 'https://books.example.com/c/index.html');
    const snapshot = JSON.stringify(doc);
    for (const b of doc.blocks) blockContext(doc, b.id);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});
