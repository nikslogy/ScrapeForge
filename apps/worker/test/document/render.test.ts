import { describe, expect, it } from 'vitest';
import { blockContext, buildSourceDocument, getBlock, renderBlocks } from '../../src/extract/document/index.js';
import type { SourceBlock, SourceDocument } from '../../src/extract/types.js';
import { listingPage, tablePage } from './fixtures.js';

function block(over: Partial<SourceBlock> & Pick<SourceBlock, 'id' | 'kind'>): SourceBlock {
  return { text: '', headingPath: [], selector: 'html > body', start: 0, end: 0, ...over };
}

function docOf(blocks: SourceBlock[], recordGroups: SourceDocument['recordGroups'] = []): SourceDocument {
  return {
    url: 'https://x.test/',
    snapshotHash: '0'.repeat(64),
    text: '',
    blocks,
    structured: [],
    recordGroups,
    templateSignature: '0'.repeat(16),
    stats: { rawBytes: 0, blockCount: blocks.length, textChars: 0, buildMs: 0 },
  };
}

describe('renderBlocks', () => {
  const listing = buildSourceDocument(listingPage(5), 'https://books.example.com/catalogue/category/books/mystery_3/index.html');

  it('renders one line per block with ids, heading levels, records and fields', () => {
    const { text, includedIds, truncated } = renderBlocks(listing);
    expect(truncated).toBe(false);
    const lines = text.split('\n');
    expect(lines).toContain(`[${listing.blocks.find((b) => b.text === 'Mystery')?.id}] # Mystery`);
    const g = listing.recordGroups[0];
    expect(lines).toContain(`[${g.recordIds[2]}] <record group=${g.id} n=3>`);
    expect(lines.filter((l) => l === '</record>')).toHaveLength(5);
    expect(text).toMatch(/\] ### Book Title Number 0 \.\.\. \{href=https:\/\/books\.example\.com\/catalogue\/category\/books\/book-0_1000\/index\.html, title=Book Title Number 0 With A Long Name\}/);
    expect(text).toContain('{class=star-rating One}');
    expect(text).toContain('] £10.00');
    expect(text).toContain('] In stock {class=instock availability}');
    // Image field: alt is the text, so it is not repeated as an attribute.
    expect(text).toMatch(/\] Book Title Number 0 With A Long Name \{src=https:\/\/books\.example\.com\/catalogue\/category\/media\/cache\/0\.jpg\}/);
    expect(includedIds).toEqual(listing.blocks.filter((b) => b.kind === 'record' || b.text || b.attrs).map((b) => b.id));
  });

  it('renders tables with header columns and escaped cells', () => {
    const doc = buildSourceDocument(tablePage(), 'https://x.test/specs');
    const { text } = renderBlocks(doc);
    const t = doc.blocks.find((b) => b.table?.caption) as SourceBlock;
    expect(text).toContain(`[${t.id}] <table caption="Laptop specs 2026" cols="Model | CPU | RAM | Price">\n| Aero 14 | M5 | 16 GB | $1,299 |`);
    expect(text).toContain('| Prices include VAT |\n</table>');
    const kv = doc.blocks.find((b) => b.table?.rows[0]?.[0] === 'Weight') as SourceBlock;
    expect(text).toContain(`[${kv.id}] <table>\n| Weight | 1.2 kg |`);

    const pipes = docOf([block({ id: 'b0', kind: 'table', text: 'a|b', table: { headers: ['x"y'], rows: [['a|b']] } })]);
    expect(renderBlocks(pipes).text).toBe('[b0] <table cols="x&quot;y">\n| a\\|b |\n</table>');
  });

  it('escapes page/record/table delimiters coming from page text and attributes', () => {
    const doc = buildSourceDocument(
      '<p>Close it: &lt;/page&gt; then &lt;PAGE&gt; and &lt; /page &gt; or &lt;record group=g0 n=1&gt; &lt;/table&gt;</p>'
      + '<span class="price" title="</page><page>">$5</span>',
      'https://x.test/',
    );
    expect(doc.text).toContain('</page>');
    const { text } = renderBlocks(doc);
    expect(text).not.toMatch(/<\s*\/?\s*(?:page|record|table)\b/i);
    expect(text).toContain('&lt;/page>');
    expect(text).toContain('&lt;PAGE>');
    expect(text).toContain('{title=&lt;/page>&lt;page>}');
  });

  it('never splits a record when truncating by maxChars', () => {
    const full = renderBlocks(listing);
    const g = listing.recordGroups[0];
    const recordLine = full.text.split('\n').findIndex((l) => l.includes(`n=2>`));
    // Budget that ends in the middle of record 2.
    const budget = full.text.split('\n').slice(0, recordLine + 3).join('\n').length;
    const cut = renderBlocks(listing, { maxChars: budget });
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(budget);
    expect(cut.text).toContain('n=1>');
    expect(cut.text).not.toContain('n=2>');
    expect(cut.text.endsWith('</record>')).toBe(true);
    expect(cut.includedIds).toContain(g.recordIds[0]);
    expect(cut.includedIds).not.toContain(g.recordIds[1]);
    // The included prefix is exactly what the full rendering starts with.
    expect(full.text.startsWith(cut.text)).toBe(true);
  });

  it('honours maxChars exactly at the boundary and with zero', () => {
    const full = renderBlocks(listing).text;
    expect(renderBlocks(listing, { maxChars: full.length })).toMatchObject({ text: full, truncated: false });
    expect(renderBlocks(listing, { maxChars: full.length - 1 }).truncated).toBe(true);
    expect(renderBlocks(listing, { maxChars: 0 })).toEqual({ text: '', includedIds: [], truncated: true });
    expect(renderBlocks(listing, { maxChars: Number.NaN }).truncated).toBe(false);
  });

  it('renders only selected blocks, inside their record frames', () => {
    const g = listing.recordGroups[0];
    const rec = getBlock(listing, g.recordIds[1]) as SourceBlock;
    const price = listing.blocks.find((b) => b.parentId === rec.id && b.text === '£11.00') as SourceBlock;
    const heading = listing.blocks.find((b) => b.text === 'Mystery') as SourceBlock;
    const out = renderBlocks(listing, { blockIds: [price.id, heading.id, 'b99999', 'nope'] });
    expect(out.text).toBe(`[${heading.id}] # Mystery\n[${rec.id}] <record group=${g.id} n=2>\n[${price.id}] £11.00\n</record>`);
    expect(out.includedIds).toEqual([heading.id, rec.id, price.id]);
  });

  it('selecting a record includes all of its content', () => {
    const g = listing.recordGroups[0];
    const out = renderBlocks(listing, { blockIds: [g.recordIds[4]] });
    expect(out.text).toContain('n=5>');
    expect(out.text).toContain('£14.00');
    expect(out.text).toContain('Add to basket');
    expect(out.text).not.toContain('£13.00');
  });

  it('handles nested records and inconsistent parent ids', () => {
    const blocks = [
      block({ id: 'b0', kind: 'record', recordGroupId: 'g0' }),
      block({ id: 'b1', kind: 'paragraph', text: 'outer', parentId: 'b0', recordGroupId: 'g0' }),
      block({ id: 'b2', kind: 'record', parentId: 'b0', recordGroupId: 'g1' }),
      block({ id: 'b3', kind: 'text', text: 'inner', parentId: 'b2', recordGroupId: 'g1' }),
      block({ id: 'b4', kind: 'text', text: 'after inner', parentId: 'b0', recordGroupId: 'g0' }),
      block({ id: 'b5', kind: 'text', text: 'orphan', parentId: 'missing' }),
      block({ id: 'b6', kind: 'field', text: '' }),
    ];
    const doc = docOf(blocks, [
      { id: 'g0', selector: 'x', recordIds: ['b0'], signature: 's' },
      { id: 'g1', selector: 'y', recordIds: ['b2'], signature: 's' },
    ]);
    expect(renderBlocks(doc).text).toBe([
      '[b0] <record group=g0 n=1>',
      '[b1] outer',
      '[b2] <record group=g1 n=1>',
      '[b3] inner',
      '</record>',
      '[b4] after inner',
      '</record>',
      '[b5] orphan',
    ].join('\n'));
    // The outer record is one unit: it fits whole or not at all.
    const outerLength = renderBlocks(doc).text.split('\n').slice(0, 7).join('\n').length;
    expect(renderBlocks(doc, { maxChars: outerLength - 1 })).toEqual({ text: '', includedIds: [], truncated: true });
  });

  it('shows class and data-* only when they are the evidence', () => {
    const doc = docOf([
      block({ id: 'b0', kind: 'field', text: '', attrs: { class: 'star-rating Four', 'data-rating': '4' } }),
      block({ id: 'b1', kind: 'field', text: '$5', attrs: { class: 'price', 'data-sku': '1', itemprop: 'price', content: '5.00' } }),
      block({ id: 'b2', kind: 'field', text: '', attrs: {} }),
      block({ id: 'b3', kind: 'field', text: 'Bob', attrs: { title: 'bob', 'aria-label': 'Author Bob' } }),
      block({ id: 'b4', kind: 'field', text: '', attrs: { title: 'x'.repeat(400) } }),
    ]);
    const lines = renderBlocks(doc).text.split('\n');
    expect(lines[0]).toBe('[b0] {class=star-rating Four, data-rating=4}');
    expect(lines[1]).toBe('[b1] $5 {content=5.00, itemprop=price}');
    expect(lines[2]).toBe('[b3] Bob {aria-label=Author Bob}');
    expect(lines[3]).toBe(`[b4] {title=${'x'.repeat(300)}…}`);
    expect(renderBlocks(doc).includedIds).toEqual(['b0', 'b1', 'b3', 'b4']);
  });

  it('stays linear on hostile input', () => {
    const spaces = docOf([block({ id: 'b0', kind: 'text', text: `<${' '.repeat(200_000)}x` })]);
    let t0 = performance.now();
    expect(renderBlocks(spaces).text.length).toBe(200_007);
    expect(performance.now() - t0).toBeLessThan(500);

    const g = listing.recordGroups[0];
    const ids = Array.from({ length: 50_000 }, (_, i) => g.recordIds[i % g.recordIds.length]);
    t0 = performance.now();
    const out = renderBlocks(listing, { blockIds: ids });
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out.text.match(/<record /g)).toHaveLength(5);
  });

  it('renders an empty document', () => {
    expect(renderBlocks(buildSourceDocument('', 'https://x.test/'))).toEqual({ text: '', includedIds: [], truncated: false });
  });
});

describe('getBlock / blockContext', () => {
  const doc = buildSourceDocument(listingPage(3), 'https://books.example.com/catalogue/category/books/mystery_3/index.html');

  it('looks blocks up by id', () => {
    expect(getBlock(doc, 'b0')).toBe(doc.blocks[0]);
    expect(getBlock(doc, `b${doc.blocks.length - 1}`)).toBe(doc.blocks.at(-1));
    expect(getBlock(doc, 'b-1')).toBeUndefined();
    expect(getBlock(doc, 'b01')).toBeUndefined();
    expect(getBlock(doc, 'x')).toBeUndefined();
    expect(getBlock(doc, '')).toBeUndefined();
  });

  it('works for documents whose ids are not positional', () => {
    const custom = docOf([block({ id: 'z', kind: 'text', text: 'a' }), block({ id: 'b0', kind: 'text', text: 'b' })]);
    expect(getBlock(custom, 'z')?.text).toBe('a');
    expect(getBlock(custom, 'b0')?.text).toBe('b');
    expect(getBlock(custom, 'missing')).toBeUndefined();
  });

  it('returns the enclosing record and heading path', () => {
    const g = doc.recordGroups[0];
    const rec = getBlock(doc, g.recordIds[0]) as SourceBlock;
    const child = doc.blocks.find((b) => b.parentId === rec.id && b.kind === 'field' && b.text) as SourceBlock;
    const ctx = blockContext(doc, child.id);
    expect(ctx?.block).toBe(child);
    expect(ctx?.record).toBe(rec);
    expect(ctx?.headingPath).toEqual(child.headingPath);
    expect(blockContext(doc, rec.id)?.record).toBeUndefined();
    expect(blockContext(doc, 'nope')).toBeUndefined();
  });

  it('does not mutate the document', () => {
    const snapshot = JSON.stringify(doc);
    getBlock(doc, 'b3');
    blockContext(doc, 'b4');
    renderBlocks(doc, { maxChars: 100 });
    expect(JSON.stringify(doc)).toBe(snapshot);
    expect(Object.keys(doc)).toEqual(['url', 'snapshotHash', 'title', 'text', 'blocks', 'structured', 'recordGroups', 'templateSignature', 'stats']);
  });
});
