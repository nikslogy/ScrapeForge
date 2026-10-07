import { describe, expect, it } from 'vitest';
import {
  checkGrounding,
  clearPreparedTextCache,
  normalizeForMatch,
  prepareText,
  PreparedText,
} from '../../src/extract/validate/grounding.js';

const grounded = (raw: unknown, text: string) => checkGrounding(raw, { blockText: text }).grounded;

describe('normalizeForMatch', () => {
  it('applies NFKC, lowercase, quote/dash unification and whitespace collapse', () => {
    expect(normalizeForMatch('  IT’S\u00a0a “Test” — Ｆｕｌｌ\u200bwidth\n\tﬁne ')).toBe('it\'s a "test" - fullwidth fine');
    expect(normalizeForMatch('a\u0001b\u0000c')).toBe('a b c');
    expect(normalizeForMatch('co\u00adop')).toBe('coop');
  });
});

describe('checkGrounding: short strings', () => {
  it('finds a substring in the cited block', () => {
    expect(checkGrounding('A Light in the Attic', { blockText: 'A Light in the Attic' })).toEqual({ grounded: true, where: 'block', score: 1 });
  });

  it('ignores case, whitespace, quotes, dashes and NBSP differences', () => {
    expect(grounded("It's a — Test", 'IT’S\u00a0\u00a0A – TEST, sir')).toBe(true);
    expect(grounded('“Quoted”', 'he said "quoted" twice')).toBe(true);
    expect(grounded('Ｗｉｄｅ', 'wide text')).toBe(true);
  });

  it('requires word boundaries', () => {
    expect(grounded('Red', 'Bored to death')).toBe(false);
    expect(grounded('cat', 'category')).toBe(false);
    expect(grounded('Red', 'Colours: red, blue')).toBe(true);
    expect(grounded('in stock', 'In stock (22 available)')).toBe(true);
    expect(grounded('stock', 'In stock')).toBe(true);
    expect(grounded('Model 3', 'Model 3.5 Turbo')).toBe(false);
    expect(grounded('Model 3', 'Model 3, Model Y')).toBe(true);
    expect(grounded('(new)', 'brand(new)')).toBe(true);
  });

  it('matches inside unspaced scripts', () => {
    expect(grounded('苹果', '新鲜苹果汁')).toBe(true);
    expect(grounded('東京', '東京都渋谷区')).toBe(true);
    expect(grounded('라면', '맛있는 라면')).toBe(true);
  });

  it('does not ground absent values', () => {
    expect(checkGrounding('Invented title', { blockText: 'A Light in the Attic', recordText: 'A Light in the Attic £51.77', documentText: 'Books to Scrape' })).toEqual({
      grounded: false,
      where: 'none',
      score: 0,
    });
  });
});

describe('checkGrounding: numbers', () => {
  it('does not ground a price of 1 from 10, 2021, 1.5, 1,000 or A1', () => {
    for (const raw of [1, '1', '£1', '$1.00']) {
      expect(grounded(raw, 'Only 10 left — © 2021 — 1.5 kg — 1,000 sold — model A1')).toBe(false);
    }
    expect(grounded('1', 'Rated 1 out of 5')).toBe(true);
    expect(grounded(1, 'qty: 1')).toBe(true);
  });

  it.each([
    ['£51.77', 'Price: £51.77'],
    ['£51.77', '51.77 GBP'],
    ['£51.77', 'GBP 51.77'],
    ['£51.77', '£ 51.77'],
    ['£51.77', 'GBP51.77'],
    ['$12', 'USD 12'],
    ['USD 12', 'Price $12.00'],
    ['12 EUR', '€12'],
    ['US$ 9.99', '$9.99'],
    ['¥1,200', '1200円'],
    ['₹1,23,456', 'Rs. 123456'],
    ['12,99 €', '€12.99'],
    ['1.299,00 €', '$1,299'],
    ['15%', 'Save 15 %'],
    ['-20%', '20% off'],
    ['1.2K', '1,200 ratings'],
    ['1,200', '1.2k ratings'],
    ['5000000', '5 Mio. Aufrufe'],
  ])('%j is grounded by %j', (raw, text) => {
    expect(grounded(raw, text)).toBe(true);
  });

  it.each([
    [1299, '1.299,00 €'],
    [1299, '$1,299.00'],
    [1024, '(1,024 reviews)'],
    [1024, '1.024 Bewertungen'],
    [51.77, '£51.77'],
    [0.5, '0,5 l'],
    [-3, 'change: −3'],
    [3, 'change: −3'],
  ])('number %d is grounded by %j', (raw, text) => {
    expect(grounded(raw, text)).toBe(true);
  });

  it.each([
    [12.99, '1,299'],
    [2.5, '2,500 sold'],
    [1, '1,000 sold'],
    [1, '1.000 verkauft'],
    [5, 'Size 15'],
    [5, '4.5 stars'],
    [100, '1000'],
  ])('number %d is not grounded by %j', (raw, text) => {
    expect(grounded(raw, text)).toBe(false);
  });

  it('accepts a digit-sequence match with a lower score', () => {
    // Superscript cents: NFKC turns "12⁹⁹" into "1299".
    expect(checkGrounding(12.99, { blockText: '$12⁹⁹' })).toEqual({ grounded: true, where: 'block', score: 0.8 });
    expect(checkGrounding('$12.99', { blockText: '$1299' })).toEqual({ grounded: true, where: 'block', score: 0.8 });
    expect(grounded(0.1, 'January 01')).toBe(false);
    expect(grounded(1.5, 'item 15')).toBe(false);
  });

  it('indexes the parts of malformed and space-grouped numbers', () => {
    expect(grounded(20, 'Sizes 10,20,30')).toBe(true);
    expect(grounded(100, 'Qty 2 100')).toBe(true);
    expect(grounded(2100, 'Qty 2 100')).toBe(true);
  });

  it('treats text that merely contains numbers as text', () => {
    expect(grounded('4.5 out of 5', '4.5 out of 5 stars')).toBe(true);
    expect(grounded('4.5 out of 5', '14.5 out of 50')).toBe(false);
    expect(grounded('(1,024 reviews)', '1,024 ratings')).toBe(false);
  });

  it('does not ground non-finite numbers or booleans', () => {
    expect(grounded(Number.NaN, 'NaN')).toBe(false);
    expect(grounded(Number.POSITIVE_INFINITY, 'Infinity')).toBe(false);
    expect(grounded(true, 'true yes in stock')).toBe(false);
  });
});

describe('checkGrounding: locations', () => {
  const ctx = {
    blockText: 'A Light in the Attic',
    attrs: { class: 'star-rating Three', href: '../../a-light-in-the-attic_1000/index.html', 'data-price': '51.77' },
    recordText: 'A Light in the Attic £51.77 In stock',
    documentText: 'Books to Scrape. A Light in the Attic £51.77 In stock. Tipping the Velvet £53.74',
  };

  it('searches block → attrs → record → document', () => {
    expect(checkGrounding('A Light in the Attic', ctx).where).toBe('block');
    expect(checkGrounding('Three', ctx).where).toBe('attrs');
    expect(checkGrounding('../../a-light-in-the-attic_1000/index.html', ctx).where).toBe('attrs');
    expect(checkGrounding(51.77, ctx).where).toBe('attrs');
    expect(checkGrounding('In stock', ctx).where).toBe('record');
    expect(checkGrounding('£53.74', ctx)).toEqual({ grounded: true, where: 'document', score: 1 });
    expect(checkGrounding('Books to Scrape', ctx).where).toBe('document');
  });

  it('never matches across two attribute values', () => {
    expect(checkGrounding('Three ../../a', { attrs: { class: 'star-rating Three', href: '../../a' } }).grounded).toBe(false);
  });

  it('works with any subset of locations', () => {
    expect(checkGrounding('x', {})).toEqual({ grounded: false, where: 'none', score: 0 });
    expect(checkGrounding('x', { documentText: 'x' }).where).toBe('document');
    expect(checkGrounding('x', { attrs: {} }).grounded).toBe(false);
  });
});

describe('checkGrounding: long text', () => {
  const paragraph =
    'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife. ' +
    'However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed ' +
    'in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.';

  it('grounds verbatim text with score 1', () => {
    expect(paragraph.length).toBeGreaterThan(120);
    expect(checkGrounding(paragraph, { blockText: paragraph.toUpperCase().replace(/ /g, '  ') })).toEqual({ grounded: true, where: 'block', score: 1 });
  });

  it('grounds lightly edited text by bigram overlap and reports the ratio', () => {
    const edited = paragraph.replace('single man', 'single gentleman').replace('daughters', 'girls').replace(', that he', '; he');
    const result = checkGrounding(edited, { blockText: paragraph });
    expect(result.grounded).toBe(true);
    expect(result.where).toBe('block');
    expect(result.score).toBeGreaterThanOrEqual(0.6);
    expect(result.score).toBeLessThan(1);
  });

  it('does not ground a fabricated paragraph that reuses the page vocabulary', () => {
    const words = paragraph.toLowerCase().match(/[a-z]+/g)!;
    const shuffled = [...words].reverse().join(' ');
    const result = checkGrounding(shuffled, { documentText: `${paragraph} ${paragraph}` });
    expect(result.grounded).toBe(false);
    expect(result.where).toBe('none');
    expect(result.score).toBeLessThan(0.6);
  });

  it('reports the best ratio when nothing reaches the threshold', () => {
    const invented = Array.from({ length: 40 }, (_, i) => `invented${i}`).join(' ');
    const half = `${paragraph.slice(0, 150)} ${invented}`;
    const result = checkGrounding(half, { blockText: paragraph });
    expect(result.grounded).toBe(false);
    expect(result.score).toBeGreaterThan(0.2);
    expect(result.score).toBeLessThan(0.6);
  });

  it('falls back to the record when the block holds only part of the text', () => {
    const result = checkGrounding(paragraph, { blockText: paragraph.slice(0, 100), recordText: `Intro. ${paragraph} Outro.` });
    expect(result).toEqual({ grounded: true, where: 'record', score: 1 });
  });
});

describe('checkGrounding: arrays, objects, empties, derived', () => {
  const ctx = { blockText: 'Tags: fiction, poetry', recordText: 'Tags: fiction, poetry. Author: Shel Silverstein', documentText: 'Also: humor' };

  it('grounds arrays when every item is grounded, at the farthest location', () => {
    expect(checkGrounding(['fiction', 'poetry'], ctx)).toEqual({ grounded: true, where: 'block', score: 1 });
    expect(checkGrounding(['fiction', 'Shel Silverstein'], ctx)).toEqual({ grounded: true, where: 'record', score: 1 });
    expect(checkGrounding(['fiction', 'humor'], ctx)).toEqual({ grounded: true, where: 'document', score: 1 });
  });

  it('reports the grounded fraction when some items are missing', () => {
    expect(checkGrounding(['fiction', 'poetry', 'horror', 'romance'], ctx)).toEqual({ grounded: false, where: 'none', score: 0.5 });
  });

  it('skips empty items and handles nested values', () => {
    expect(checkGrounding(['fiction', null, ''], ctx)).toEqual({ grounded: true, where: 'block', score: 1 });
    expect(checkGrounding({ name: 'Shel Silverstein', tags: ['poetry'] }, ctx)).toEqual({ grounded: true, where: 'record', score: 1 });
    let deep: unknown = 'fiction';
    for (let i = 0; i < 20; i++) deep = [deep];
    expect(checkGrounding(deep, ctx).grounded).toBe(false);
  });

  it('treats nothing-to-check as vacuously grounded', () => {
    for (const raw of [null, undefined, '', '   ', [], ['  ', '\n'], {}]) {
      expect(checkGrounding(raw, ctx)).toEqual({ grounded: true, where: 'none', score: 1 });
    }
  });

  it('does not check derived values', () => {
    expect(checkGrounding('fiction', ctx, { derived: true })).toEqual({ grounded: false, where: 'none', score: 0 });
  });

  it('does not ground non-plain objects', () => {
    expect(checkGrounding(new Date(), ctx).grounded).toBe(false);
    expect(checkGrounding(new Map([['a', 'fiction']]), ctx).grounded).toBe(false);
  });

  it('returns fresh result objects', () => {
    const a = checkGrounding('nope', ctx);
    a.score = 99;
    expect(checkGrounding('nope', ctx).score).toBe(0);
  });
});

describe('prepareText', () => {
  it('normalizes once and caches by string', () => {
    clearPreparedTextCache();
    const text = `Some Page ${'x'.repeat(10)}`;
    const a = prepareText(text);
    expect(a).toBeInstanceOf(PreparedText);
    expect(a.text).toBe('some page xxxxxxxxxx');
    expect(prepareText(text)).toBe(a);
    expect(prepareText(a)).toBe(a);
  });

  it('keeps one text that is too large for the LRU', () => {
    clearPreparedTextCache();
    const huge = 'lorem ipsum '.repeat(400_000);
    const first = prepareText(huge);
    expect(prepareText(huge)).toBe(first);
    prepareText('small text');
    expect(prepareText(huge)).toBe(first);
    clearPreparedTextCache();
    expect(prepareText(huge)).not.toBe(first);
  });

  it('accepts prepared text in the context', () => {
    const doc = prepareText('Catalogue: Tipping the Velvet £53.74');
    expect(checkGrounding('Tipping the Velvet', { documentText: doc }).where).toBe('document');
    expect(checkGrounding(53.74, { documentText: doc }).grounded).toBe(true);
  });

  it('keeps grounding fast on a large document', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => `Product number ${i} costs £${(i * 1.37).toFixed(2)} and ships in ${i % 9} days.`);
    const documentText = rows.join('\n');
    expect(documentText.length).toBeGreaterThan(1_000_000);
    const t0 = performance.now();
    let hits = 0;
    for (let i = 0; i < 2_000; i++) {
      // Misses force a document-level search; hits come from the block.
      if (checkGrounding(`Fabricated value ${i}`, { blockText: rows[i], documentText }).grounded) hits++;
      if (checkGrounding(`£${(i * 1.37).toFixed(2)}`, { blockText: rows[i], documentText }).grounded) hits++;
      if (checkGrounding(999_999 + i, { blockText: rows[i], documentText }).grounded) hits++;
    }
    const elapsed = performance.now() - t0;
    expect(hits).toBe(2_000);
    expect(elapsed).toBeLessThan(3_000);
  });

  it('keeps long-text checks fast on a large document', () => {
    const documentText = Array.from({ length: 30_000 }, (_, i) => `word${i % 5000} filler${i % 777} text`).join(' ');
    const needle = Array.from({ length: 60 }, (_, i) => `novel${i}`).join(' ');
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) checkGrounding(`${needle} ${i}`, { documentText });
    expect(performance.now() - t0).toBeLessThan(3_000);
  });
});
