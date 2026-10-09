// Hostile nesting in the shared parse. parse5's tree builder scans its stack
// of open elements for most tokens (scope checks, end tags without a
// matching element, foreign content) and the list of active formatting
// elements for each one it opens, so a deep stack made parsing quadratic:
// 50,000 nested <div>s took 19 s, 30,000 distinct open <b>s five minutes,
// all far under the element budget. parseHtml keeps the stack, the run of
// SVG/MathML elements and the formatting list bounded, closing the current
// element before a start tag as its end tag would.
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { extractContent, internals } from '../../src/extraction/pipeline-impl.js';
import { seededRandom } from '../../../../tests/latency/lib/fixtures.js';
import { randomDocument } from './random-html.js';

interface Node { type: string; data?: string; children?: Node[] }

function depthOf(root: Node): number {
  let deepest = 0;
  const stack: Array<[Node, number]> = [[root, 0]];
  while (stack.length > 0) {
    const [node, level] = stack.pop()!;
    deepest = Math.max(deepest, level);
    for (const child of node.children ?? []) stack.push([child, level + 1]);
  }
  return deepest;
}

/** All text in document order (template content included). */
function textIn(root: Node): string {
  let out = '';
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'text') out += node.data;
    for (let i = (node.children?.length ?? 0) - 1; i >= 0; i--) stack.push(node.children![i]!);
  }
  return out;
}

const parse = (html: string) => internals.parseHtml(html).document as unknown as Node;
const words = (text: string) => text.split(/\s+/).filter(Boolean).sort();
const LOREM = 'Tide pools are rocky depressions along the shore that hold seawater when the tide recedes. '.repeat(3);

// Openers that nest without limit, in HTML and foreign content, closable or
// not, with numbered text and end tags between them.
const OPENERS = [
  '<div>', '<span>', '<p>', '<li>', '<b>', '<b x=1>', '<b x=2>', '<i x=3>', '<a href=x>', '<font color=red>', '<nobr>', '<em>',
  '<button>', '<object>', '<marquee>', '<h2>', '<ul>', '<dl><dd>', '<section>', '<pre>', '<form>', '<select><option>', '<optgroup>',
  '<template>', '<svg>', '<g>', '<math><mi>', '<foreignObject>', '<desc>',
];
const TABLES = ['<table><tr><td>', '<table>', '<caption>'];
const OTHERS = ['text ', 'word ', '</div>', '</span>', '</b>', '</p>', '</x>', '</li>', '<br>', '<img>', '</template>', '</svg>', '</a>'];

function deepHtml(seed: number, openers: string[], others: string[]): string {
  const rand = seededRandom(seed);
  const parts: string[] = [];
  for (let i = 0; i < 3_000; i++) {
    const r = rand();
    parts.push(r < 0.8 ? openers[Math.floor(rand() * openers.length)]! : others[Math.floor(rand() * others.length)]!);
    if (rand() < 0.2) parts.push(`t${i} `);
  }
  return parts.join('');
}

describe('nesting in the shared parse', () => {
  it('stays linear on deep stacks of open elements', () => {
    const distinctB = Array.from({ length: 30_000 }, (_, i) => `<b x=${i}>`).join('');
    for (const [name, html] of [
      ['50,000 nested <div>s', `${'<div>'.repeat(50_000)}x`], // 19 s before
      ['30,000 distinct open <b>s', `${distinctB}x`], // 294 s before
      ['20,000 <span>s, then 100,000 unmatched end tags', `${'<span>'.repeat(20_000)}${'</x>'.repeat(100_000)}`], // 25 s before
      ['20,000 <span>s, then 40,000 <p></p>', `${'<span>'.repeat(20_000)}${'<p></p>'.repeat(40_000)}`], // 13 s before
      ['20,000 nested SVG <g>s, then 50,000 unmatched end tags', `<svg>${'<g>'.repeat(20_000)}${'</x>'.repeat(50_000)}`], // 35 s before
      ['20,000 <div>s in a <button>, each scanning to it', `<p><button>${'<div>'.repeat(20_000)}x`],
      ['30,000 nested templates (parse5 recursed once per template at the end)', `${'<template>'.repeat(30_000)}x`],
    ]) {
      const t0 = performance.now();
      const { document, truncated } = internals.parseHtml(html, 100_000);
      expect(performance.now() - t0, name).toBeLessThan(3_000);
      expect(truncated, name).toBe(false);
      // The template's content fragment adds one level per template.
      expect(depthOf(document as unknown as Node), name).toBeLessThanOrEqual(2 * internals.MAX_OPEN_ELEMENTS + 2);
    }
  });

  it('stays linear where elements it does not close nest', () => {
    // Table parts and framesets nest past the limit; the scans stop at them.
    for (const [name, html] of [
      ['20,000 nested table cells', `${'<table><tr><td>'.repeat(20_000)}${'<b></b></x>'.repeat(10_000)}`],
      ['50,000 nested framesets', `${'<frameset>'.repeat(50_000)}${'</x>'.repeat(10_000)}`],
      ['30,000 <object>s with <b>s', `${'<object><b>'.repeat(30_000)}${'</b>'.repeat(10_000)}`],
    ]) {
      const t0 = performance.now();
      internals.parseHtml(html, 100_000);
      expect(performance.now() - t0, name).toBeLessThan(3_000);
    }
  });

  it('builds what cheerio.load builds below the limits', () => {
    const cases: Array<[string, string, number]> = [
      ['<div>', '</div>', internals.MAX_OPEN_ELEMENTS - 3],
      ['<span class="a">', '</span>', internals.MAX_OPEN_ELEMENTS - 3],
      ['<b>', '', internals.MAX_OPEN_ELEMENTS - 3],
      ['<g>', '', internals.MAX_FOREIGN_RUN - 2],
    ];
    for (const [open, close, depth] of cases) {
      const html = `<html><body>${open === '<g>' ? '<svg>' : ''}${open.repeat(depth)}<p>${LOREM}</p>${close.repeat(depth)}</body></html>`;
      expect(cheerio.load(parse(html) as never).html(), `${open} x ${depth}`).toBe(cheerio.load(html).html());
    }
    const formatting = `<p>${Array.from({ length: internals.MAX_FORMATTING_ENTRIES }, (_, i) => `<b x=${i}>`).join('')}a<p>b`;
    expect(cheerio.load(parse(formatting) as never).html()).toBe(cheerio.load(formatting).html());
    for (let seed = 1; seed <= 300; seed++) {
      const html = randomDocument(seed);
      expect(cheerio.load(parse(html) as never).html()).toBe(cheerio.load(html).html());
    }
  });

  it('keeps all text, in order, when it closes elements past the limits', () => {
    let deep = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const html = deepHtml(seed, OPENERS, OTHERS);
      const theirs = cheerio.load(html).root()[0] as unknown as Node;
      if (depthOf(theirs) > internals.MAX_OPEN_ELEMENTS + 1) deep++;
      expect({ seed, text: textIn(parse(html)) }).toEqual({ seed, text: textIn(theirs) });
    }
    expect(deep).toBeGreaterThan(100);
  });

  it('keeps all text with tables, where foster parenting can move it', () => {
    // Text in a table goes before it unless an element is open in the
    // table, so closing one can move text (as browsers flatten, too).
    for (let seed = 1; seed <= 200; seed++) {
      const html = deepHtml(seed, [...OPENERS, ...TABLES], [...OTHERS, '</table>']);
      let theirs: Node;
      try {
        theirs = cheerio.load(html).root()[0] as unknown as Node;
      } catch {
        continue; // parse5 itself fails on a few of these (see the next test)
      }
      expect({ seed, words: words(textIn(parse(html))) }).toEqual({ seed, words: words(textIn(theirs)) });
    }
  });

  it('keeps what it parsed when parse5 fails', async () => {
    // _resetInsertionMode reads tag IDs without namespaces: the SVG <select>
    // passes for an HTML one, `</table>` then pops every open element and
    // the next text throws (in cheerio.load as well).
    const broken = '<table><svg><select><foreignObject><template></template></table>TAIL';
    expect(() => cheerio.load(broken)).toThrow(TypeError);
    const html = `<html><head><title>Broken</title></head><body><article><p>${LOREM}</p><p>${LOREM}</p>${broken}</article></body></html>`;
    expect(internals.parseHtml(html).truncated).toBe(true);
    const r = await extractContent(html, 'https://example.com/', ['markdown', 'text', 'html']);
    expect(r.truncated).toBe(true);
    expect(r.markdown).toContain('Tide pools');
    expect(r.html).toContain('Tide pools');
  });

  it('extracts a deep page whole', async () => {
    const html = `<html><head><title>Deep</title></head><body>${'<div>'.repeat(60_000)}<p>${LOREM}</p><p>${LOREM}</p>${'</div>'.repeat(60_000)}</body></html>`;
    const t0 = performance.now();
    const r = await extractContent(html, 'https://example.com/', ['markdown', 'text', 'html']);
    expect(performance.now() - t0).toBeLessThan(6_000); // minutes before (parse and every selector query)
    expect(r.truncated).toBeUndefined();
    expect(r.text).toContain('Tide pools');
    expect(r.markdown).toContain('Tide pools');
    expect(cheerio.load(r.html!)('p').length).toBe(2);
  });
});
