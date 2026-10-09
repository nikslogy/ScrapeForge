// EXTRACTION_MAX_INPUT_ELEMENTS. parse5 counts the elements it creates and
// stops at the budget, so the limit holds whatever the markup: comment
// forms, quoted attributes, foreign content and the insertion modes that
// ignore raw-text start tags, and the tree builder's own elements (implied,
// `</p>`, reconstructed formatting elements). The linkedom copy Readability
// works on is bounded by the same tree.
import * as cheerio from 'cheerio';
import { parseHTML } from 'linkedom';
import { parse } from 'parse5';
import { adapter, type Htmlparser2TreeAdapterMap } from 'parse5-htmlparser2-tree-adapter';
import { describe, expect, it } from 'vitest';
import { extractContent, internals } from '../../src/extraction/pipeline-impl.js';
import { seededRandom } from '../../../../tests/latency/lib/fixtures.js';
import { goldenCases } from './golden/cases.js';
import { randomDocument } from './random-html.js';

/** Elements parse5 creates for `html` as cheerio.load runs it (public API, independent of the code under test). */
function createdElements(html: string): number {
  let n = 0;
  parse<Htmlparser2TreeAdapterMap>(html, {
    scriptingEnabled: true,
    treeAdapter: { ...adapter, createElement: (...args: Parameters<typeof adapter.createElement>) => (n++, adapter.createElement(...args)) },
  });
  return n;
}

interface Node { type: string; children?: Node[] }

function elementsIn(root: Node): number {
  let n = 0;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'tag' || node.type === 'script' || node.type === 'style') n++;
    if (node.children) stack.push(...node.children);
  }
  return n;
}

const cheerioElements = (html: string) => elementsIn(cheerio.load(html).root()[0] as unknown as Node);
interface LkNode { nodeType: number; firstChild: LkNode | null; nextSibling: LkNode | null }

/** Elements linkedom builds, template children included (querySelectorAll skips those). */
function linkedomElements(html: string): number {
  let n = 0;
  const stack = [parseHTML(html).document as unknown as LkNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.nodeType === 1) n++;
    for (let c = node.firstChild; c !== null; c = c.nextSibling) stack.push(c);
  }
  return n;
}
const lessThans = (s: string) => s.split('<').length - 1;

// Tokens where the tokenizer and the tree builder interact: comment forms,
// quotes in attributes, raw-text elements (and things that look like their
// end tags), script escapes, foreign content, the insertion modes that
// ignore raw-text start tags (select, frameset, template columns), and
// formatting elements the tree builder reconstructs.
const FRAGMENTS = [
  '<b>', '</b>', '<i x=1>', '<p>', '</p>', '<div class="a">', '</div>', '<span>', 'text', ' ', '\n', '\t', '<a href=x>', '<br/>', '</br>',
  '<!-->', '<!--->', '<!---->', '<!-- c -->', '<!-- c --!>', '<!--', '-->', '--!>', '<!-- <!-- -->', '<!---!>', '--', '-', '!', '>',
  '<p title="', '"', "'", '=', '<p title=\'<b>\'>', '<p title="<script>">', '<p title="<!--">', '<p a"b=<i>>', '<p =\'x>', '<p x=a<b>',
  '<p a=\'"\' b="\'">', '<p/a="<b>">', '<p a =\n"<i>">', '<p a= x>', '<img src="a>b">',
  '<script>', '</script>', '</script x>', '</scriptx>', '</script/>', '<!--<script>', '<script type="x">', '<SCRIPT>', '</SCRIPT >',
  '<style>', '</style>', '<style/>', '<textarea>', '</textarea>', '<title>', '</title>', '</title\n>',
  '<xmp>', '</xmp>', '<iframe>', '</iframe>', '<noembed>', '</noembed>', '<noframes>', '</noframes>', '<noscript>', '</noscript>', '<plaintext>',
  '<svg>', '</svg>', '<svg/>', '<math>', '</math>', '<foreignObject>', '</foreignObject>', '<desc>', '<![CDATA[', ']]>', '<mi>', '<mtext>',
  '<select>', '</select>', '<option>', '<template>', '</template>', '<col>', '<colgroup>', '<table>', '<tr>', '<td>', '</table>', '<frameset>', '<frame>',
  '</p title=">">', '</ x>', '</>', '</', '<?x>', '<!x>', '<!doctype html>', '<!DOCTYPE "a>b">', '<', '<>', '<1>', '<é>',
  '<b x=1>', '<b x=2>', '<b x=3>', '<a x=4>', '<font color=red>', '<nobr>', '</a>', '</nobr>',
];

function hostileHtml(seed: number): string {
  const rand = seededRandom(seed);
  const parts: string[] = [];
  const length = 1 + Math.floor(rand() * 60);
  for (let i = 0; i < length; i++) parts.push(FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]!);
  return parts.join('');
}

const LOREM = 'Tide pools are rocky depressions along the shore that hold seawater when the tide recedes. '.repeat(3);
const ARTICLE = `<p>${LOREM}</p><p>${LOREM}</p>`;
const URL = 'https://example.com/';

describe('element budget', () => {
  // The review's bypasses: each prefix made the old start-tag scan stop
  // counting, so the whole input reached parse5.
  it.each([
    ['<!-->', 'an empty comment'],
    ['<!--->', 'an empty comment with a dash'],
    ['<!-- a --!>', 'a comment closed by --!>'],
    ['<p title="<script>">', 'a raw-text tag name in an attribute value'],
    ['<p title="<!--">', 'a comment opener in an attribute value'],
    ['<svg><title>', 'SVG <title> (markup in foreign content)'],
    ['<svg><style>', 'SVG <style>'],
    ['<math><mi><xmp></xmp></mi><style>', 'MathML <style>'],
    ['<select><style></select>', 'a <style> start tag that <select> ignores'],
    ['<template><col><style></template>', 'a <style> start tag that a template column group ignores'],
  ])('stops after %s (%s)', async (prefix) => {
    const html = `${prefix}${'<b>x</b>'.repeat(5_000)}`;
    expect(createdElements(html)).toBeGreaterThan(5_000);
    const r = await extractContent(html, URL, ['html', 'markdown'], { maxElements: 100 });
    expect(r.truncated).toBe(true);
    expect(cheerioElements(r.html!)).toBeLessThanOrEqual(101);
    // The <b> that crossed the budget is the last element.
    expect(elementsIn(internals.parseHtml(html, 100).document as unknown as Node)).toBe(101);
  });

  it('stops exactly when parse5 creates more elements than the budget, and never earlier', () => {
    let maxOvershoot = 0;
    let truncations = 0;
    for (let seed = 1; seed <= 3_000; seed++) {
      const html = seed % 6 === 0 ? randomDocument(seed) : hostileHtml(seed);
      const created = createdElements(html);
      const full = cheerio.load(html);
      expect(elementsIn(full.root()[0] as unknown as Node)).toBeLessThanOrEqual(created);
      for (const budget of new Set([0, 1, 3, Math.floor(created / 2), created - 1, created])) {
        if (budget < 0) continue;
        const { document, truncated } = internals.parseHtml(html, budget);
        expect({ html, budget, truncated }).toEqual({ html, budget, truncated: created > budget });
        if (truncated) {
          truncations++;
          // The token that crosses the budget finishes: it can reconstruct
          // every open formatting element, each of them counted before.
          const kept = elementsIn(document as unknown as Node);
          maxOvershoot = Math.max(maxOvershoot, kept - budget);
          expect(kept).toBeLessThanOrEqual(2 * budget + 64);
        } else {
          // Not cut: the tree cheerio.load builds.
          expect(cheerio.load(document as never).html()).toBe(full.html());
        }
      }
    }
    expect(truncations).toBeGreaterThan(5_000);
    expect(maxOvershoot).toBeLessThan(16);
  });

  it('is linear on adversarial input', () => {
    // parse5 tokenizes inputs that create few elements to the end, at a few
    // MB/s on these; anything quadratic would take minutes.
    for (const html of [
      '<a'.repeat(1_000_000),
      `<script>${'</'.repeat(1_000_000)}`,
      `<script><!--${'<script>-'.repeat(250_000)}`,
      `<script><!--<script>${'</script'.repeat(250_000)}`,
      `<!--${'<a>'.repeat(500_000)}`,
      `<!--${'-'.repeat(2_000_000)}`,
      `<p${' a="b"'.repeat(500_000)}`,
      `<p${' a=b'.repeat(500_000)}>`,
      `<${'a'.repeat(2_000_000)}`,
      `<style>${'</styl'.repeat(500_000)}`,
      '<<<<'.repeat(500_000),
      `<svg>${'<a'.repeat(1_000_000)}`,
      '<b>'.repeat(1_000_000),
      '</p>'.repeat(1_000_000),
    ]) {
      const t0 = performance.now();
      internals.parseHtml(html, 10);
      expect(performance.now() - t0, html.slice(0, 20)).toBeLessThan(2_000);
    }
  });

  it('stops parse5 when it rebuilds formatting elements at every text run', async () => {
    // 400 distinct open <b>s, closed by </div> but still active: each later
    // "<div>x</div>" makes parse5 rebuild them all (360,000 elements from
    // 1,300 start tags). The parse keeps the newest MAX_FORMATTING_ENTRIES
    // active (nesting.test.ts), which still rebuild at every run.
    const amplified = `<html><body><article>${ARTICLE}<div>${Array.from({ length: 400 }, (_, i) => `<b x=${i}>`).join('')}</div>${'<div>x</div>'.repeat(900)}</article></body></html>`;
    expect(createdElements(amplified)).toBeGreaterThan(350_000);
    expect(900 * internals.MAX_FORMATTING_ENTRIES).toBeGreaterThan(20_000);
    const t0 = performance.now();
    const r = await extractContent(amplified, URL, ['markdown', 'text', 'html'], { maxElements: 10_000 });
    expect(performance.now() - t0).toBeLessThan(8_000); // 34 s before
    expect(r.truncated).toBe(true);
    expect(r.markdown).toContain('Tide pools');
    expect(cheerioElements(r.html!)).toBeLessThanOrEqual(10_000 + 400 + 16);
  });

  it('stops parse5 on end tags that create elements', async () => {
    for (const tag of ['</p>', '</br>']) {
      const html = `<html><body><article>${ARTICLE}${tag.repeat(50_000)}</article></body></html>`;
      const r = await extractContent(html, URL, ['markdown', 'html'], { maxElements: 1_000 });
      expect(r.truncated).toBe(true);
      expect(cheerioElements(r.html!)).toBeLessThanOrEqual(1_000 + 16);
    }
  });

  it('counts every element, implied ones included, and cuts only above the budget', async () => {
    const html = `<html><head><title>T</title></head><body><article>${ARTICLE}<table><tr><td>a</td></tr></table></article></body></html>`;
    const n = cheerioElements(html);
    expect((await extractContent(html, URL, ['markdown', 'html'], { maxElements: n })).truncated).toBeUndefined();
    const cut = await extractContent(html, URL, ['markdown', 'html'], { maxElements: n - 1 });
    expect(cut.truncated).toBe(true);
    expect(cut.markdown).toContain('Tide pools');
  });

  it('gives linkedom no markup parse5 read as text', async () => {
    // parse5 reads raw-text element content and script text after
    // "<!--<script>" as text; linkedom (htmlparser2) parses it as markup.
    const tags = '<b></b>'.repeat(60_000);
    for (const [wrap, readability] of [
      [`<noembed>${tags}</noembed>`, true],
      [`<iframe>${tags}</iframe>`, true],
      [`<noframes>${tags}</noframes>`, true],
      [`<template><noembed>${tags}</noembed></template>`, true],
      [`<script><!--<script></script>${tags}</script>`, true],
      [`<plaintext>${tags}`, false], // the article is all text then: no Readability content blocks
      // JSDOM read <noscript> as markup (scripting disabled), and linkedom
      // still does: Readability is skipped when that is over the budget.
      [`<noscript>${tags}</noscript>`, false],
    ] as const) {
      const html = `<html><head><title>T</title></head><body><article>${ARTICLE}${wrap}</article></body></html>`;
      expect(createdElements(html), wrap.slice(0, 20)).toBeLessThan(20);
      expect(linkedomElements(html), wrap.slice(0, 20)).toBeGreaterThan(60_000);
      const source = internals.readabilityInput(html, 10_000);
      if (source !== null) expect(linkedomElements(source), wrap.slice(0, 20)).toBeLessThan(40);
      const t0 = performance.now();
      const r = await extractContent(html, URL, ['markdown', 'text', 'html'], { maxElements: 10_000 });
      expect(performance.now() - t0, wrap.slice(0, 20)).toBeLessThan(3_000);
      expect(r.markdown).toContain('Tide pools');
      if (readability) expect(r.extractionMethod, wrap.slice(0, 20)).toBe('readability');
    }
  });

  it('bounds the linkedom copy by the parse5 tree and the <noscript> markup', () => {
    for (let seed = 1; seed <= 1_500; seed++) {
      const html = seed % 4 === 0 ? randomDocument(seed) : hostileHtml(seed);
      const source = internals.readabilityInput(html, Infinity);
      if (source === null) continue;
      const $ = cheerio.load(html);
      const noscript = $('noscript').toArray().reduce((n, el) => n + lessThans($(el).text()), 0);
      const bound = 2 * cheerioElements(html) + noscript;
      const n = linkedomElements(source);
      if (n > bound) expect({ html, source, n }).toEqual({ html, source, n: bound });
    }
  });

  it('serializes deep trees without re-parsing the input', async () => {
    // parse5's recursive serializer overflows on 20,000 levels; the `html`
    // format used to re-parse the raw input with linkedom then, which read
    // the <noembed> content as 300,000 elements. Table cells nest past the
    // parse's nesting limit (nesting.test.ts), so the tree stays this deep.
    const html = `<html><body>${'<table><tr><td>'.repeat(5_000)}<p>${LOREM}</p>${'</td></tr></table>'.repeat(5_000)}<noembed>${'<b></b>'.repeat(300_000)}</noembed></body></html>`;
    const t0 = performance.now();
    const r = await extractContent(html, URL, ['html', 'markdown'], { maxElements: 100_000 });
    expect(performance.now() - t0).toBeLessThan(8_000);
    expect(r.truncated).toBeUndefined();
    expect(r.markdown).toContain('Tide pools');
    // What parse5 builds (and would serialize, given the stack): html/head/body, the <noembed> holding text.
    expect(r.html!.startsWith(`<html><head></head><body>${'<table><tbody><tr><td>'.repeat(5_000)}<p>Tide pools`)).toBe(true);
    expect(r.html!.endsWith(`${'</td></tr></tbody></table>'.repeat(5_000)}<noembed>${'<b></b>'.repeat(300_000)}</noembed></body></html>`)).toBe(true);
  });
});

describe('serializeHtml (the iterative serializer for deep trees and Readability\'s input)', () => {
  const NAMESPACED = [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a" xml:lang="en"/><a xlink:title="t&quot;\u00a0"></a></svg>',
    '<math definitionURL="x" xmlns:foo="bar"><mi>x</mi><annotation-xml encoding="text/html"><p>p</p></annotation-xml></math>',
    '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN"><template><p>a & b</p><template><i>x</i></template></template><br><img src="a&b">',
    '<!DOCTYPE><p title=\'a"b\u00a0&amp;\'>\u00a0&lt;x&gt; &amp;</p><noscript><b>&amp;</b></noscript><plaintext><b>&amp;',
  ];

  it('writes what parse5\'s serializer writes', () => {
    const inputs = [
      ...NAMESPACED,
      ...goldenCases().map((c) => c.html),
      ...Array.from({ length: 1_500 }, (_, i) => (i % 3 === 0 ? randomDocument(i + 1) : hostileHtml(i + 1))),
    ];
    for (const html of inputs) {
      const $ = cheerio.load(html);
      const ours = internals.serializeHtml($.root()[0] as never);
      if (ours !== $.html()) expect({ html, ours }).toEqual({ html, ours: $.html() });
    }
  });
});
