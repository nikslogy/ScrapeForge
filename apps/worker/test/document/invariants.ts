import * as cheerio from 'cheerio';
import { expect } from 'vitest';
import type { SourceDocument } from '../../src/extract/types.js';

/**
 * Structural guarantees every SourceDocument must satisfy:
 * - ids are b0..bN in order;
 * - doc.text.slice(start, end) === text for EVERY block (records included);
 * - document.text is exactly the non-empty leaf texts joined with "\n"
 *   (so no leaf text is duplicated or lost between blocks);
 * - record descendants follow their record and lie inside its range;
 * - each block selector re-selects exactly one element in cheerio.load(html);
 * - each record group selector matches exactly its record elements.
 */
export function assertDocumentInvariants(doc: SourceDocument, html: string, opts: { selectors?: boolean } = {}): void {
  const index = new Map<string, number>();
  doc.blocks.forEach((b, i) => {
    expect(b.id).toBe(`b${i}`);
    index.set(b.id, i);
    expect(doc.text.slice(b.start, b.end)).toBe(b.text);
    expect(b.start).toBeLessThanOrEqual(b.end);
    expect(Array.isArray(b.headingPath)).toBe(true);
    if (b.kind !== 'record' && b.kind !== 'table') expect(b.text).not.toMatch(/\s{2,}|^\s|\s$/);
  });

  const leafTexts = doc.blocks.filter((b) => b.kind !== 'record' && b.text !== '').map((b) => b.text);
  expect(doc.text).toBe(leafTexts.join('\n'));

  for (const [i, b] of doc.blocks.entries()) {
    if (b.parentId === undefined) continue;
    const pi = index.get(b.parentId);
    expect(pi, `parent of ${b.id}`).toBeDefined();
    const parent = doc.blocks[pi as number];
    expect(parent.kind).toBe('record');
    expect(pi as number).toBeLessThan(i);
    if (b.text) {
      expect(b.start).toBeGreaterThanOrEqual(parent.start);
      expect(b.end).toBeLessThanOrEqual(parent.end);
    }
    if (b.kind !== 'record') expect(b.recordGroupId).toBe(parent.recordGroupId);
  }

  expect(doc.stats.blockCount).toBe(doc.blocks.length);
  expect(doc.stats.textChars).toBe(doc.text.length);
  expect(doc.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
  expect(doc.templateSignature).toMatch(/^[0-9a-f]{16}$/);

  const groupIds = new Set(doc.recordGroups.map((g) => g.id));
  for (const b of doc.blocks) if (b.kind === 'record') expect(groupIds.has(b.recordGroupId as string)).toBe(true);

  if (opts.selectors === false) return;
  const $ = cheerio.load(html);
  for (const b of doc.blocks) {
    const matched = $(b.selector);
    expect(matched.length, `${b.id} ${b.selector}`).toBe(1);
  }
  for (const g of doc.recordGroups) {
    const matched = $(g.selector).toArray();
    const expected = g.recordIds.map((id) => $(doc.blocks[index.get(id) as number].selector)[0]);
    expect(matched.length, g.selector).toBe(expected.length);
    matched.forEach((el, k) => expect(el === expected[k], `${g.id} record ${k}`).toBe(true));
  }
}
