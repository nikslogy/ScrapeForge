// The whole-document lookups on the shared tree (meta tags, title, JSON-LD
// scripts, noise removal). cheerio's `$(selector)` searches with domutils'
// find, whose Array#shift/unshift stack makes every query cost elements x
// depth: over a second per query at 20,000 levels, and the pipeline made
// eight of them. The linear walks must select exactly what `$(selector)`
// selects.
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { internals } from '../../src/extraction/pipeline-impl.js';
import { seededRandom } from '../../../../tests/latency/lib/fixtures.js';
import { randomDocument } from './random-html.js';

// ── The selector-based originals (commit a51098e), kept as references ──

function oldMetaTags($: cheerio.CheerioAPI) {
  const get = (selectors: string[]): string => {
    for (const sel of selectors) {
      const val = $(sel).attr('content')?.trim();
      if (val && val.length > 5) return val;
    }
    return '';
  };
  const title = get(['meta[property="og:title"]', 'meta[name="twitter:title"]']) || $('title').text().trim();
  const description = get(['meta[property="og:description"]', 'meta[name="description"]', 'meta[name="twitter:description"]']);
  if (!title && !description) return null;
  return { title, description };
}

function oldRemoveNoise($: cheerio.CheerioAPI): void {
  $(internals.NOISE_SELECTOR).remove();
}

const SELECTORS: Array<[string, string | undefined]> = [
  ['meta', 'meta'],
  ['meta[property="og:title"]', 'meta'],
  ['meta[name="twitter:title"]', 'meta'],
  ['meta[property="og:description"]', 'meta'],
  ['meta[name="description"]', 'meta'],
  ['meta[name="twitter:description"]', 'meta'],
  ['script[type="application/ld+json"]', 'script'],
  [internals.NOISE_SELECTOR, undefined],
];

// Markup around what the lookups match: attribute case and spacing,
// foreign content, template content, nesting, duplicates, noise inside
// noise, and the elements parse5 moves (head content in body, tables).
const FRAGMENTS = [
  '<meta property="og:title" content="Open Graph title">', '<meta PROPERTY="og:title" content="Upper attribute name">',
  '<meta property="OG:TITLE" content="Upper value">', '<meta property="og:title" content=" short ">', '<meta property="og:title">',
  '<meta name="twitter:title" content="Twitter card title">', '<meta name="description" content="A page description">',
  '<meta name="DESCRIPTION" content="Upper-case name value">', '<meta property="og:description" content="  OG description  ">',
  '<meta name="twitter:description" content="Twitter description">', '<META NAME="description" CONTENT="Upper tag">',
  '<svg><meta property="og:title" content="SVG meta title"></svg>', '<template><meta name="description" content="Template meta"></template>',
  '<title>Page title</title>', '<title>  Spaced\n title </title>', '<svg><title>SVG <tspan>title</tspan></title></svg>', '<title>a &amp; b</title>',
  '<template><title>Template title</title></template>', '<math><mi><title>Math title</title></mi></math>',
  '<script type="application/ld+json">{"@type":"Article"}</script>', '<script type="APPLICATION/LD+JSON">{"a":1}</script>',
  '<script type=" application/ld+json">[1]</script>', '<script type="application/ld+json ">{}</script>', '<script>var a = 1;</script>',
  '<svg><script type="application/ld+json">{"svg":true}</script></svg>', '<template><script type="application/ld+json">{"t":1}</script></template>',
  '<nav>', '</nav>', '<footer>x</footer>', '<header><nav>n</nav></header>', '<aside>', '</aside>', '<div class="ad">', '<div class="ads x">',
  '<div class="advertisement">', '<div class="Cookie-bar">', '<div class="cookie-bar">', '<div id="banner-1">', '<div ID="popup">',
  '<span class="my-modal">', '<p aria-hidden="true">', '<p aria-hidden="TRUE">', '<iframe>', '</iframe>', '<noscript>', '</noscript>',
  '<style>a{}</style>', '<svg><nav>svg nav</nav></svg>', '<template><aside>t</aside></template>', '<body class="banner-page">', '<head>',
  '<div>', '</div>', '<p>', '</p>', '<span>', '</span>', 'text', ' ', '<table><tr><td>', '<b>', '</b>', '<!-- c -->', '<frameset>',
];

function fragmentDocument(seed: number): string {
  const rand = seededRandom(seed);
  const parts: string[] = [];
  const length = 1 + Math.floor(rand() * 40);
  for (let i = 0; i < length; i++) parts.push(FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]!);
  return parts.join('');
}

const documents = (n: number) => Array.from({ length: n }, (_, i) => (i % 4 === 0 ? randomDocument(i + 1) : fragmentDocument(i + 1)));

describe('linear whole-document lookups', () => {
  it('select what $(selector) selects, in the same order', () => {
    let matched = 0;
    for (const html of documents(1_500)) {
      const $ = cheerio.load(html);
      for (const [selector, name] of SELECTORS) {
        const expected = $(selector).toArray();
        const ours = internals.selectAll($, selector, name).toArray();
        if (ours.length !== expected.length || ours.some((el, i) => el !== expected[i])) {
          expect({ html, selector, ours: ours.length }).toEqual({ html, selector, ours: expected.length });
        }
        matched += expected.length;
      }
    }
    expect(matched).toBeGreaterThan(5_000);
  });

  it('read the meta tags and the title as the selector version did', () => {
    let titles = 0;
    for (const html of documents(1_500)) {
      const expected = oldMetaTags(cheerio.load(html));
      if (expected?.title) titles++;
      expect({ html, meta: internals.extractMetaTags(cheerio.load(html)) }).toEqual({ html, meta: expected });
    }
    expect(titles).toBeGreaterThan(500);
  });

  it('remove the noise $(NOISE_SELECTOR).remove() removed, leaving a consistent tree', () => {
    for (const html of documents(1_500)) {
      const expected = cheerio.load(html);
      oldRemoveNoise(expected);
      const ours = cheerio.load(html);
      internals.removeNoise(ours);
      if (ours.html() !== expected.html()) expect({ html, ours: ours.html() }).toEqual({ html, ours: expected.html() });
      // Sibling and parent links agree with the children arrays.
      const stack = [ours.root()[0] as unknown as LinkedNode];
      while (stack.length > 0) {
        const node = stack.pop()!;
        const kids = node.children ?? [];
        kids.forEach((child, i) => {
          if (child.parent !== node || child.prev !== (kids[i - 1] ?? null) || child.next !== (kids[i + 1] ?? null)) {
            expect({ html, index: i, linked: false }).toEqual({ html, index: i, linked: true });
          }
          stack.push(child);
        });
      }
    }
  });

  it('take linear time on deep and wide trees', () => {
    // 60,000 nested spans: each $(selector) took ~10 s here (elements x depth).
    const deep = `<html><head><title>T</title><meta name="description" content="Deep page"></head><body>${'<span>'.repeat(60_000)}<nav>n</nav><p>x</p>${'</span>'.repeat(60_000)}</body></html>`;
    // 60,000 sibling noise elements: removing each by lookup and splice is quadratic.
    const wide = `<html><body><p>keep</p>${'<nav>n</nav><p>keep</p>'.repeat(60_000)}</body></html>`;
    for (const html of [deep, wide]) {
      const $ = cheerio.load(html);
      const t0 = performance.now();
      internals.extractMetaTags($);
      internals.extractJsonLd($);
      internals.removeNoise($);
      expect(performance.now() - t0, html.slice(0, 80)).toBeLessThan(1_500);
    }
  });
});

interface LinkedNode {
  parent: LinkedNode | null;
  prev: LinkedNode | null;
  next: LinkedNode | null;
  children?: LinkedNode[];
}
