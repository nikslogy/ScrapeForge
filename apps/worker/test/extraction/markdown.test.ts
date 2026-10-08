// The markdown converter in pipeline-impl.ts is a port of turndown's
// conversion loop with a linear join and an explicit stack. These tests hold
// it to stock turndown's output (same options and custom rule) on random
// markup, on every golden page's Readability article, and on hand-picked
// constructs; then check that the inputs that were quadratic or overflowed
// the stack now finish.
import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { describe, expect, it } from 'vitest';
import {
  cleanMarkdown,
  markdownFromHtml,
  markdownFromNode,
  stripJavascriptLinks,
  type MdNode,
} from '../../src/extraction/pipeline-impl.js';
import { seededRandom } from '../../../../tests/latency/lib/fixtures.js';
import { goldenCases } from './golden/cases.js';
import { randomHtml } from './random-html.js';

function stockTurndown(): TurndownService {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  td.addRule('skip-placeholder-images', {
    filter: (node) => {
      if (node.nodeName !== 'IMG') return false;
      const src = node.getAttribute('src') || '';
      return src.startsWith('data:image') && src.length < 200;
    },
    replacement: () => '',
  });
  return td;
}

const stock = stockTurndown();

/** A linkedom element holding `html`, inside a full document. */
function linkedomRoot(html: string): MdNode {
  const { document } = parseHTML(`<!doctype html><html><head></head><body><div id="root">${html}</div></body></html>`);
  document.normalize();
  return document.getElementById('root') as unknown as MdNode;
}

/** stock first: markdownFromNode converts in place. */
function bothOnNode(node: MdNode): [string, string] {
  const expected = stock.turndown(node as unknown as HTMLElement);
  return [markdownFromNode(node), expected];
}

const CONSTRUCTS: Record<string, string> = {
  'ordered list with start': '<ol start="7"><li>a</li><li>b</li><li><p>para</p><ul><li>nested</li></ul></li></ol>',
  'ordered list without start, text between items': '<ol>\n<li>one</li>\n text \n<li>two</li></ol>',
  'list inside list item as last child': '<ul><li>top<ul><li>inner</li></ul></li><li>next</li></ul>',
  'fenced code containing a fence': '<pre><code class="language-md">```\ninside\n````\n</code></pre>',
  'pre without code': '<pre>  keep   spaces\n\nand lines  </pre>',
  'inline code with backticks': '<p>Use <code>a`b</code> here</p>',
  'blockquote with paragraphs': '<blockquote><p>one</p><p>two</p></blockquote><p>after</p>',
  'blank elements': '<p></p><div> </div><span>  </span><p><a href="/x"></a></p><td></td><p><img src="x.png"></p>',
  'flanking whitespace': '<p>a<em> b </em>c<strong> d</strong> <b>e </b>f</p>',
  'non-ascii flanking whitespace': '<p>a<em> b </em>c <i>  d</i></p>',
  'whitespace-only inline element': '<p>x<em> </em>y<span> </span>z</p>',
  'links with titles and odd destinations': '<p><a href="https://e.com/a b" title="T &quot;q&quot;">x</a> <a href="(p)">y</a> <a>no href</a></p>',
  'images': '<p><img src="https://e.com/i.png" alt="alt [x]" title="t\n\nt"><img src="data:image/png;base64,AAAA" alt=""><img alt="no src"></p>',
  'escapes at text node starts': '<p>&gt; q</p><p>- d</p><p>+ p</p><p>1. n</p><p># h</p><p>=== e</p><p>~~~ t</p><p>a&gt;b</p>',
  'line breaks': '<p>a<br>b<br><br>c</p><br><p>d</p>',
  'headings and rules': '<h1>One</h1><hr><h2>Two <em>em</em></h2><h6>Six</h6>',
  'table without plugin': '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
  'comments and cdata-like text': '<p>a<!-- c -->b</p><!-- top --><p>&lt;![CDATA[x]]&gt;</p>',
  'deep inline nesting': '<p><span><span><em><strong>deep</strong></em></span></span> tail</p>',
  'text directly in root': 'plain <b>bold</b> text\n\n with newlines',
  'empty input': '',
};

describe('markdown converter vs stock turndown', () => {
  it.each(Object.entries(CONSTRUCTS))('%s (string input)', (_name, html) => {
    expect(markdownFromHtml(html)).toBe(stock.turndown(html));
  });

  it.each(Object.entries(CONSTRUCTS).filter(([, html]) => html !== ''))('%s (linkedom node)', (_name, html) => {
    const [actual, expected] = bothOnNode(linkedomRoot(html));
    expect(actual).toBe(expected);
  });

  it('matches on 600 random fragments (string input)', () => {
    for (let seed = 1; seed <= 600; seed++) {
      const html = randomHtml(seed);
      const actual = markdownFromHtml(html);
      const expected = stock.turndown(html);
      if (actual !== expected) expect({ seed, html, actual }).toEqual({ seed, html, actual: expected });
    }
  });

  it('matches on 600 random fragments (linkedom node)', () => {
    for (let seed = 1001; seed <= 1600; seed++) {
      const html = randomHtml(seed);
      const [actual, expected] = bothOnNode(linkedomRoot(html));
      if (actual !== expected) expect({ seed, html, actual }).toEqual({ seed, html, actual: expected });
    }
  });

  it("matches on every golden page's Readability article", () => {
    for (const c of goldenCases()) {
      const { document } = parseHTML(cheerio.load(c.html).html());
      document.normalize();
      const article = new Readability<unknown>(document as unknown as Document, { serializer: (el) => el }).parse();
      if (!article) continue;
      const [actual, expected] = bothOnNode(article.content as MdNode);
      expect(actual, c.id).toBe(expected);
    }
  });
});

describe('markdown converter on pathological input', () => {
  // Recursive converters overflow at a few thousand levels on the main thread.
  // Depths are limited by turndown's own semantics, not the walk: every
  // wrapping block adds two newlines (and every <em> two underscores) to a
  // content string the rules see, so very deep wrappers are quadratic in the
  // output they build. Inputs are parsed with linkedom: domino's parser is
  // itself quadratic in depth.
  it('converts 30,000 levels of inline nesting without overflowing the stack', () => {
    const depth = 30_000;
    const root = linkedomRoot(`${'<span>'.repeat(depth)}deep text${'</span>'.repeat(depth)}`);
    const t0 = performance.now();
    expect(markdownFromNode(root)).toBe('deep text');
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it('matches stock turndown on block nesting as deep as stock can go', () => {
    const html = `${'<div><em>'.repeat(400)}deep text${'</em></div>'.repeat(400)}`;
    const [actual, expected] = bothOnNode(linkedomRoot(html));
    expect(actual).toBe(expected);
  });

  it('converts 8,000 levels of block nesting, where stock turndown overflows the stack', () => {
    const html = `${'<div><em>'.repeat(4_000)}deep text${'</em></div>'.repeat(4_000)}`;
    expect(() => stock.turndown(linkedomRoot(html) as unknown as HTMLElement)).toThrow(RangeError);
    const md = markdownFromNode(linkedomRoot(html));
    expect(md.replace(/[_\n]/g, '')).toBe('deep text');
  });

  it('matches stock turndown on wrappers without a rule around block and inline content', () => {
    const inner = '<p>One <span> two </span></p>\n<div>\n</div><span>tail</span><p></p>three';
    for (const wrapper of ['div', 'section', 'span', 'article', 'small']) {
      for (const depth of [1, 2, 7, 60]) {
        const html = `${`<${wrapper}>`.repeat(depth)}${inner}${`</${wrapper}>`.repeat(depth)}<p>after</p>`;
        expect(markdownFromHtml(html), `${wrapper} x${depth}`).toBe(stock.turndown(html));
        const [actual, expected] = bothOnNode(linkedomRoot(html));
        expect(actual, `${wrapper} x${depth} (node)`).toBe(expected);
      }
    }
  });

  it('converts 2,000 nested wrappers around 1 MB of text without copying it per level', () => {
    // Each wrapper used to rebuild the whole content string ('\n\n' + content
    // + '\n\n'), so this cost depth x size: ~7 s for 500 levels around 2 MB.
    const paragraphs = '<p>Tide pools are rocky depressions along the shore.</p>'.repeat(20_000);
    const root = linkedomRoot(`${'<div><section>'.repeat(1_000)}${paragraphs}${'</section></div>'.repeat(1_000)}`);
    const t0 = performance.now();
    const md = markdownFromNode(root);
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(md.split('\n\n')).toHaveLength(20_000);
    expect(md.startsWith('Tide pools')).toBe(true);
  });

  it('converts a 20,000-item ordered list in linear time', () => {
    const items = Array.from({ length: 20_000 }, (_, i) => `<li>item ${i}</li>`).join('');
    const t0 = performance.now();
    const md = markdownFromHtml(`<ol start="3">${items}</ol>`);
    const ms = performance.now() - t0;
    expect(md.startsWith('3.  item 0\n4.  item 1\n')).toBe(true);
    expect(md.endsWith('20002.  item 19999')).toBe(true);
    expect(ms).toBeLessThan(5_000); // stock turndown: ~9 s (indexOf per item)
  });

  it('converts an element with 30,000 children in linear time', () => {
    const paragraphs = Array.from({ length: 30_000 }, (_, i) => `<p>Paragraph ${i} with some words in it.</p>`).join('');
    const t0 = performance.now();
    const md = markdownFromHtml(paragraphs);
    const ms = performance.now() - t0;
    expect(md.split('\n\n')).toHaveLength(30_000);
    expect(ms).toBeLessThan(5_000); // stock turndown flattens the output once per child
  });

  it('trims long trailing whitespace runs without a quadratic regex scan', () => {
    const html = `<pre>${'x\n'.repeat(5)}${' \n'.repeat(200_000)}</pre><p>${' '.repeat(100_000)}</p>`;
    const t0 = performance.now();
    const md = markdownFromHtml(html);
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(md).toBe(stock.turndown(`<pre>${'x\n'.repeat(5)}</pre>`));
  });
});

const OLD_CLEAN = (md: string) =>
  md
    .replace(/!\[\]\(data:image[^)]{0,200}\)/g, '')
    .replace(/\[([^\]]*)\]\(javascript:[^)]*\)/g, '$1')
    .replace(/^[\s;]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

describe('stripJavascriptLinks / cleanMarkdown', () => {
  const PIECES = ['[', ']', '(', ')', '(javascript:', 'javascript:', '](javascript:', 'a', 'b c', '\n', ' ', ';', '![](data:image/png;base64,x)', '[x]', '\\['];

  it('matches the regex it replaces on 5,000 random strings', () => {
    const rand = seededRandom(99);
    for (let i = 0; i < 5_000; i++) {
      const s = Array.from({ length: Math.floor(rand() * 30) }, () => PIECES[Math.floor(rand() * PIECES.length)]).join('');
      const expected = s.replace(/\[([^\]]*)\]\(javascript:[^)]*\)/g, '$1');
      if (stripJavascriptLinks(s) !== expected) expect({ s, got: stripJavascriptLinks(s) }).toEqual({ s, got: expected });
      if (cleanMarkdown(s) !== OLD_CLEAN(s)) expect({ s, got: cleanMarkdown(s) }).toEqual({ s, got: OLD_CLEAN(s) });
    }
  });

  it('handles the documented cases', () => {
    expect(stripJavascriptLinks('[click](javascript:void(0)) and [keep](https://x)')).toBe('click) and [keep](https://x)');
    expect(stripJavascriptLinks('a [b [c](javascript:x) d')).toBe('a b [c d');
    expect(stripJavascriptLinks('no links')).toBe('no links');
  });

  it('runs in linear time on text with many unmatched brackets', () => {
    const md = `${'[ '.repeat(100_000)}](javascript:x) ${'[ '.repeat(100_000)}`;
    const t0 = performance.now();
    const out = stripJavascriptLinks(md);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(out.length).toBe(md.length - '[](javascript:x)'.length);
  });
});
