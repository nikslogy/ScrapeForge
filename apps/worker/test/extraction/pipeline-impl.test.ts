// pipeline-impl.ts on the main thread: the single-parse strategies against
// the cheerio code they replaced, Readability-over-linkedom details (hidden
// text, base URLs), and inputs that used to throw or take seconds.
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { extractContent, internals } from '../../src/extraction/pipeline-impl.js';
import { largePage } from '../../../../tests/latency/lib/fixtures.js';
import { randomDocument } from './random-html.js';
import { syntheticCases } from './golden/synthetic.js';

// ── The pre-rewrite implementations (commit a15ea6c), kept as references ──

function oldRemoveNoise($: cheerio.CheerioAPI): void {
  $(
    'script, style, noscript, iframe, svg, nav, footer, header, aside, ' +
    '.ad, .ads, .advertisement, [class*="cookie"], [class*="banner"], ' +
    '[class*="popup"], [class*="modal"], [id*="cookie"], [id*="banner"], ' +
    '[id*="popup"], [id*="modal"], [aria-hidden="true"]',
  ).remove();
}

function oldParagraphDensity(html: string) {
  const $ = cheerio.load(html);
  oldRemoveNoise($);
  let bestHtml = '';
  let bestText = '';
  let bestScore = 0;
  $('div, section, article, main, [role="main"]').each((_, el) => {
    const $el = $(el);
    const paragraphs = $el.find('p');
    if (paragraphs.length < 2) return;
    let pTextLen = 0;
    paragraphs.each((__, p) => {
      pTextLen += $(p).text().trim().length;
    });
    const childCount = $el.children().length || 1;
    const density = pTextLen / childCount;
    const score = density * Math.log2(paragraphs.length + 1);
    if (score > bestScore) {
      bestScore = score;
      bestHtml = $el.html() || '';
      bestText = $el.text().replace(/\s+/g, ' ').trim();
    }
  });
  if (bestScore < 50) return null;
  return { text: bestText, html: bestHtml, method: 'paragraph-density' };
}

function oldLargestBlock(html: string) {
  const $ = cheerio.load(html);
  oldRemoveNoise($);
  let bestHtml = '';
  let bestLen = 0;
  const selectors = [
    'article', '[role="main"]', 'main',
    '.post-content', '.article-body', '.entry-content',
    '.story-body', '#article-body', '.content-body',
    '[data-shadow-flattened]',
  ];
  $(selectors.join(', ')).each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length > bestLen) {
      bestLen = text.length;
      bestHtml = $(el).html() || '';
    }
  });
  if (bestLen < 100) {
    $('div, section').each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length > bestLen) {
        bestLen = text.length;
        bestHtml = $(el).html() || '';
      }
    });
  }
  if (bestLen < 100) return null;
  return {
    text: cheerio.load(bestHtml).text().replace(/\s+/g, ' ').trim(),
    html: bestHtml,
    method: 'largest-block',
  };
}

function oldPlainText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

function newStrategies(html: string) {
  const $ = cheerio.load(html);
  internals.removeNoise($);
  return internals.cleanedPageStrategies($);
}

describe('cleaned-page strategies (one parse, linear) vs the cheerio originals', () => {
  it('pick the same block with the same text and HTML on 400 random pages', () => {
    let densityHits = 0;
    let largestHits = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const html = randomDocument(seed);
      const { density, largest } = newStrategies(html);
      const oldDensity = oldParagraphDensity(html);
      const oldLargest = oldLargestBlock(html);
      if (oldDensity) densityHits++;
      if (oldLargest) largestHits++;
      expect({ seed, density }).toEqual({ seed, density: oldDensity });
      expect({ seed, largest }).toEqual({ seed, largest: oldLargest });
    }
    // The generator must actually exercise both strategies.
    expect(densityHits).toBeGreaterThan(40);
    expect(largestHits).toBeGreaterThan(100);
  });

  it('agree on the synthetic golden pages', () => {
    for (const c of syntheticCases()) {
      const { density, largest } = newStrategies(c.html);
      expect(density, c.id).toEqual(oldParagraphDensity(c.html));
      const old = oldLargestBlock(c.html);
      if (c.id === 'plaintext-tail') {
        // The old text came from re-parsing the block's HTML, where the
        // serialized </plaintext> end tag is itself plaintext.
        expect(old!.text.endsWith('<b>PLAIN</b> &amp; <i>text</plaintext>')).toBe(true);
        expect(largest, c.id).toEqual({ ...old, text: old!.text.slice(0, -'</plaintext>'.length) });
        continue;
      }
      expect(largest, c.id).toEqual(old);
    }
  });

  it('plain body text matches the old script/style/noscript-stripped text', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const html = randomDocument(seed);
      expect(internals.plainBodyText(cheerio.load(html))).toBe(oldPlainText(html));
    }
  });

  it('handle 5,000 levels of nesting (the originals overflowed the stack)', () => {
    const html = `<html><body>${'<div>'.repeat(5_000)}<p>${'word '.repeat(60)}</p><p>${'more '.repeat(60)}</p>${'</div>'.repeat(5_000)}</body></html>`;
    expect(() => oldParagraphDensity(html)).toThrow(RangeError);
    const { density } = newStrategies(html);
    expect(density?.text).toBe(`${'word '.repeat(60)}${'more '.repeat(60)}`.trim().replace(/\s+/g, ' '));
  });
});

describe('isWhitespaceCode', () => {
  it('is /\\s/ for every UTF-16 code unit', () => {
    for (let c = 0; c <= 0xffff; c++) {
      const expected = /\s/.test(String.fromCharCode(c));
      if (internals.isWhitespaceCode(c) !== expected) expect({ c, ws: internals.isWhitespaceCode(c) }).toEqual({ c, ws: expected });
    }
  });
});

describe('inline style parsing (Readability visibility)', () => {
  it.each([
    ['display:none', 'none'],
    ['display: none !important', 'none'],
    ['DISPLAY: none', 'none'],
    ['display:none ! IMPORTANT ', 'none'],
    ['display: NONE', 'NONE'],
    ['color: red; display: none; ', 'none'],
    ['display:none; display:block', 'block'],
    ['display: block; /* display:none */', 'block'],
    ["background: url('a;display:none')", undefined],
    ['background: url(a;display:none)', undefined],
    ['content: "x;display:none"', undefined],
    ['nonsense', undefined],
    ['', undefined],
    // Comments as the CSS tokenizer reads them: not inside strings, and an
    // unterminated one runs to the end of the input.
    ['content: "/*"; display:none', 'none'],
    ['content: "/* "; display: none; content: " */"', 'none'],
    ["content: '\\'/*'; display:none", 'none'],
    ['display:none; /* display:block', 'none'],
    ['display:none /* unterminated', 'none'],
    ['/* a */ dis/**/play: no/* b */ne', 'none'],
  ])('%j → display %j', (style, display) => {
    expect(internals.inlineStyle(style).get('display')).toBe(display);
  });

  it('reads comments and strings like a tokenizer-order regex on random styles', () => {
    // Strings (escapes, possibly unterminated) are kept; comments outside them go.
    const reference = (s: string) =>
      s.replace(/("(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?)|\/\*[\s\S]*?(?:\*\/|$)/g, (m, str: string | undefined) => str ?? '');
    const alphabet = ['/', '*', '"', "'", '\\', 'a', ';', ':', 'display:none', ' '];
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let n = 0; n < 3_000; n++) {
      const style = Array.from({ length: Math.floor(rand() * 24) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
      const expected = new Map<string, string>();
      // Declarations parsed from the reference's comment-free text by the same splitter.
      for (const [k, v] of internals.inlineStyle(reference(style).replace(/\/\*/g, '\u0000'))) expected.set(k.replace(/\u0000/g, '/*'), v.replace(/\u0000/g, '/*'));
      expect({ style, decls: [...internals.inlineStyle(style)] }).toEqual({ style, decls: [...expected] });
    }
  });

  it('strips comments in linear time (a lazy regex was quadratic on unterminated "/*")', () => {
    for (const style of ['/* '.repeat(200_000), `display:none;${'"/*'.repeat(100_000)}`, '/**/'.repeat(200_000)]) {
      const t0 = performance.now();
      internals.inlineStyle(style);
      expect(performance.now() - t0).toBeLessThan(500); // 200,000 "/* " took ~60 s
    }
  });
});

const PAGE_URL = 'https://site.example.com/a/b/page.html';
const LOREM = 'Tide pools are rocky depressions along the shore that hold seawater when the tide recedes. '.repeat(3);

describe("markdown from Readability's article", () => {
  const page = (inner: string) =>
    `<html><head><title>T</title></head><body><article><p>${LOREM}</p>${inner}<p>${LOREM}</p></article></body></html>`;

  // Readability wraps the inline element in a new <p>; read back, the <p>
  // closes at the inner block and the formatting repeats in each paragraph.
  it.each([
    ["<div><em><p>Editor's note: this story was updated.</p><p>Corrections appear below.</p></em></div>", "_Editor's note: this story was updated._\n\n_Corrections appear below._"],
    ['<div><font face="Arial"><b><p>Bold paragraph from a WYSIWYG editor.</p></b></font></div>', '**Bold paragraph from a WYSIWYG editor.**'],
    ['<div>Before upgrading: <strong><p>Back up the database.</p><p>Version 2 changes the config.</p></strong></div>', 'Before upgrading:\n\n**Back up the database.**\n\n**Version 2 changes the config.**'],
    ['<div>Steps <span><ul><li>one</li><li>two</li></ul></span></div>', 'Steps\n\n*   one\n*   two'],
  ])('repeats inline formatting in each block it wraps: %s', async (inner, expected) => {
    const r = await extractContent(page(inner), PAGE_URL, ['markdown']);
    expect(r.extractionMethod).toBe('readability');
    expect(r.markdown).toContain(expected);
    expect(r.markdown).not.toMatch(/^\s*(\*\*|_)\s*$/m);
  });

  it('reads raw-text elements back as text', async () => {
    const r = await extractContent(page('<div>Note: <em><p>Wrapped.</p></em><xmp><b>XMP</b> &amp; raw</xmp></div>'), PAGE_URL, ['markdown']);
    expect(r.markdown).toContain('_Wrapped._');
    expect(r.markdown).toContain('<b>XMP</b> &amp; raw');
  });

  it('matches turndown converting the article HTML on random pages', () => {
    let compared = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = internals.readabilityMarkdown(randomDocument(seed), PAGE_URL);
      if (!r) continue;
      compared++;
      if (r.markdown !== r.reference) expect({ seed, markdown: r.markdown }).toEqual({ seed, markdown: r.reference });
    }
    expect(compared).toBeGreaterThan(300);
  });
});

describe('extractContent', () => {
  it('keeps hidden text out of markdown and text', async () => {
    const page = syntheticCases().find((c) => c.id === 'hidden-styles')!;
    const r = await extractContent(page.html, page.url, ['markdown', 'text']);
    for (const marker of ['IMPORTANT-HIDDEN', 'UPPERCASE-HIDDEN', 'VISIBILITY-HIDDEN', 'ATTRIBUTE-HIDDEN']) {
      expect(r.markdown).not.toContain(marker);
      expect(r.text).not.toContain(marker);
    }
    expect(r.markdown).toContain('OVERRIDDEN-STYLE visible text');
    expect(r.markdown).toContain('URL-STYLE visible text');
  });

  it('resolves links against <base href> and the page URL like JSDOM did', async () => {
    const html = `<!doctype html><html><head><title>t</title><base href="/assets/"></head><body><article>
<p><a href="f.html">file</a> <a href="#s">hash</a> <a href="https://other.example/x">abs</a> ${LOREM}</p><p>${LOREM}</p></article></body></html>`;
    const r = await extractContent(html, PAGE_URL, ['markdown']);
    expect(r.markdown).toContain('[file](https://site.example.com/assets/f.html)');
    expect(r.markdown).toContain('[hash](https://site.example.com/assets/#s)');
    expect(r.markdown).toContain('[abs](https://other.example/x)');
    const noBase = await extractContent(html.replace('<base href="/assets/">', ''), PAGE_URL, ['markdown']);
    expect(noBase.markdown).toContain('[file](https://site.example.com/a/b/f.html)');
    expect(noBase.markdown).toContain('[hash](#s)');
  });

  it('ignores <base> and <title> inside <template> content, like the DOM', async () => {
    const html = `<!doctype html><html><head><template><title>Template title</title><base href="https://evil.example/"></template>
<title>Real title</title></head><body><article><p><a href="f.html">file</a> ${LOREM}</p><p>${LOREM}</p></article></body></html>`;
    const r = await extractContent(html, PAGE_URL, ['markdown']);
    expect(r.title).toBe('Real title');
    expect(r.markdown).toContain('[file](https://site.example.com/a/b/f.html)');
  });

  it('runs Readability for a page URL that does not parse (JSDOM refused it)', async () => {
    const html = `<!doctype html><html><head><title>t</title></head><body><article><h2>Heading</h2><p><a href="/x">rel</a> ${LOREM}</p><p>${LOREM}</p></article></body></html>`;
    const r = await extractContent(html, 'not a url', ['markdown']);
    expect(r.extractionMethod).toBe('readability');
    expect(r.markdown).toContain('[rel](/x)');
  });

  it('builds html/head/body for documents that omit them', async () => {
    const html = `<title>Omitted</title><h1>Omitted</h1><p>${LOREM}</p><p>${LOREM}</p>`;
    const r = await extractContent(html, PAGE_URL, ['markdown', 'html']);
    expect(r.extractionMethod).toBe('readability');
    expect(r.markdown).toContain('Tide pools are rocky');
    expect(r.html).toMatch(/^<html><head><title>Omitted<\/title><\/head><body>/);
  });

  it('puts the requested formats first (worker.ts streams the first key)', async () => {
    const html = `<html><head><title>T</title></head><body><article><p>${LOREM}</p><p>${LOREM}</p></article></body></html>`;
    expect(Object.keys(await extractContent(html, PAGE_URL, ['markdown']))[0]).toBe('markdown');
    expect(Object.keys(await extractContent(html, PAGE_URL, ['text', 'markdown']))[0]).toBe('markdown');
    expect(Object.keys(await extractContent(html, PAGE_URL, ['html', 'markdown']))[0]).toBe('html');
    expect(Object.keys(await extractContent(html, PAGE_URL, ['text']))[0]).toBe('text');
  });

  describe('never throws on hostile input', () => {
    const jsonLd = (value: unknown) =>
      `<html><head><title>T</title><script type="application/ld+json">${JSON.stringify(value)}</script></head><body><p>short body</p></body></html>`;
    const longBody = 'Body sentence that is long enough. '.repeat(10);

    const cases: Array<[string, string, (r: Awaited<ReturnType<typeof extractContent>>) => void]> = [
      ['@graph that is an object (spread used to throw)', jsonLd({ '@graph': { '@type': 'Article', articleBody: longBody, headline: 'G' } }), (r) => {
        expect(r.extractionMethod).toBe('json-ld');
        expect(r.markdown).toContain('# G');
      }],
      ['@graph with 300,000 entries (spread exceeded the argument limit)', jsonLd({ '@graph': Array.from({ length: 300_000 }, () => 1) }), (r) => {
        expect(r.markdown).toBeTypeOf('string');
      }],
      ['non-string articleBody and headline', jsonLd({ '@type': 'Article', articleBody: [longBody], headline: { x: 1 }, text: longBody }), (r) => {
        expect(r.extractionMethod).toBe('json-ld');
        expect(r.markdown).toContain('Body sentence');
        expect(r.markdown).not.toContain('[object Object]');
      }],
      ['5,000 nested divs', `<html><body>${'<div>'.repeat(5_000)}<p>${'word '.repeat(80)}</p><p>${'more '.repeat(80)}</p>${'</div>'.repeat(5_000)}</body></html>`, (r) => {
        expect(r.markdown).toContain('word word');
        expect(r.text).toContain('more more');
      }],
      ['20,000 nested spans', `<html><body><p>${'<span>'.repeat(20_000)}${'text '.repeat(50)}${'</span>'.repeat(20_000)}</p></body></html>`, (r) => {
        expect(r.markdown).toContain('text text');
      }],
      ['null bytes and lone surrogates', `<p>\u0000a\ud800b\udfff ${LOREM}</p>`, (r) => {
        expect(r.markdown).toBeTypeOf('string');
      }],
      ['a 2 MB attribute value', `<html><body><div data-x="${'x'.repeat(2_000_000)}"><p>${LOREM}</p><p>${LOREM}</p></div></body></html>`, (r) => {
        expect(r.markdown).toContain('Tide pools');
      }],
      ['a 400 KB style attribute of unterminated comments', `<html><body><article><div style="${'/* '.repeat(130_000)}"><p>${LOREM}</p></div><p>${LOREM}</p></article></body></html>`, (r) => {
        expect(r.extractionMethod).toBe('readability');
        expect(r.markdown).toContain('Tide pools');
      }],
    ];

    it.each(cases)('%s', async (_name, html, check) => {
      const t0 = performance.now();
      const r = await extractContent(html, PAGE_URL, ['markdown', 'text', 'html']);
      expect(performance.now() - t0).toBeLessThan(8_000);
      expect(r.html).toBeTypeOf('string');
      check(r);
    });
  });

  it('keeps template content and raw-text elements out of the article like JSDOM did', async () => {
    const html = `<!doctype html><html><head><title>t</title></head><body><article><p>${LOREM}</p>
<template><p>TEMPLATE-TEXT ${LOREM}</p></template><noembed><b>NOEMBED</b></noembed><p>${LOREM}</p></article></body></html>`;
    const r = await extractContent(html, PAGE_URL, ['markdown', 'text']);
    expect(r.extractionMethod).toBe('readability');
    expect(r.markdown).not.toContain('TEMPLATE-TEXT');
    expect(r.text).not.toContain('TEMPLATE-TEXT');
    expect(r.markdown).toContain('<b>NOEMBED</b>'); // text, as parse5 reads it, not bold markup
  });

  it('gives each raw-text element its parse5 text even where the two parsers disagree on namespaces', async () => {
    // <foreignObject> holds HTML in parse5, so its <noembed> is an HTML
    // raw-text element; linkedom puts it in the SVG namespace. The elements
    // are matched by marker attributes, not by document order, so both
    // hold their parse5 text (as in JSDOM), the template still goes, and a
    // page cannot forge a marker.
    const html = `<html><head><title>t</title></head><body><article><p>${LOREM}</p>
<svg><foreignObject><noembed><b>F</b></noembed></foreignObject></svg><noembed><b>N</b></noembed>
<template><p>TEMPLATE-TEXT</p></template><p data-scrapeforge-inert="t">FORGED-MARKER ${LOREM}</p><p>${LOREM}</p></article></body></html>`;
    const r = await extractContent(html, PAGE_URL, ['markdown', 'text']);
    expect(r.extractionMethod).toBe('readability');
    expect(r.markdown).toContain('Tide pools');
    expect(r.markdown).toContain('<b>N</b>');
    expect(r.markdown).not.toContain('**N**');
    expect(r.markdown).not.toContain('TEMPLATE-TEXT');
    expect(r.markdown).toContain('FORGED-MARKER');
  });

  it("keeps the raw-text and text-node repairs through Readability's retries", async () => {
    // Under 500 characters, Readability re-parses the body from its
    // innerHTML for each further attempt, and the attempt it returns can be
    // one of those.
    const html = `<!doctype html><html><head><title>Short</title></head><body><div class="content">
<p>Shipping rules: an order with Price &gt; 10 ships free, and orders under that pay a flat fee. Returns are accepted within thirty days of delivery when unused.</p>
<xmp><b>XMP</b> &amp; raw</xmp><noembed><i>NOEMBED</i></noembed><template><p>TEMPLATE-TEXT</p></template><p>Second paragraph &amp; the end.</p></div></body></html>`;
    const r = await extractContent(html, PAGE_URL, ['markdown', 'text']);
    expect(r.extractionMethod).toBe('readability');
    expect(r.text).toContain('<b>XMP</b> &amp; raw');
    expect(r.text).toContain('<i>NOEMBED</i>');
    expect(r.markdown).toContain('Price > 10');
    expect(r.markdown).toContain('<b>XMP</b> &amp; raw');
    for (const out of [r.text!, r.markdown!]) {
      expect(out).not.toContain('&lt;');
      expect(out).not.toContain('TEMPLATE-TEXT');
      expect(out).not.toContain('data-scrapeforge');
    }
  });

  it('extracts a frameset document (the JSDOM pipeline threw in turndown)', async () => {
    const r = await extractContent('<html><head><title>Frames</title></head><frameset><frame src="a"></frameset></html>', PAGE_URL, ['markdown', 'text', 'html']);
    expect(r).toMatchObject({ extractionMethod: 'fallback', title: 'Frames', markdown: '# Frames\n\nFrames' });
  });

  it('leaves trees deeper than browsers build (512 levels) to the linear strategies', async () => {
    const nested = (open: string, close: string, n: number) =>
      `<html><body>${open.repeat(n)}<div><p>${'word '.repeat(80)}</p><p>${'more '.repeat(80)}</p></div>${close.repeat(n)}</body></html>`;
    expect((await extractContent(nested('<div>', '</div>', 400), PAGE_URL, ['markdown'])).extractionMethod).toBe('readability');
    // The parse flattens nesting past 512 open elements (nesting.test.ts),
    // but not table cells: those keep the tree 5,000 levels deep (and the
    // elements in them flat, so no block holds both paragraphs).
    for (const [html, method] of [
      [nested('<div>', '</div>', 5_000), 'paragraph-density'],
      [nested('<table><tr><td>', '</td></tr></table>', 1_250), 'fallback'],
    ]) {
      const t0 = performance.now();
      const deep = await extractContent(html!, PAGE_URL, ['markdown', 'text']);
      expect(performance.now() - t0).toBeLessThan(5_000); // Readability alone took 9 s on 5,000 levels
      expect(deep.extractionMethod).toBe(method);
      expect(deep.text).toBe(`${'word '.repeat(80)}${'more '.repeat(80)}`.trim());
    }
  });

  it('leaves pages over Readability\'s cost limits to the linear strategies', async () => {
    const P = '<p>Tide pools are rocky depressions along the shore that hold seawater.</p>';
    const wrap = (depth: number, inner: string) =>
      `<html><head><title>t</title></head><body>${'<div>'.repeat(depth)}${inner}${'</div>'.repeat(depth)}</body></html>`;
    const cases: Array<[string, string]> = [
      ['more than 30,000 elements', wrap(1, P.repeat(31_000))],
      ['element depths summing past 1.5 million', wrap(300, P.repeat(5_200))],
      ['text length x depth past 800 million', wrap(400, `<p>${'word '.repeat(450_000)}</p>`)],
      ['inline links (Readability re-parses the page per pass)', wrap(2, '<a href="/x">link text</a> '.repeat(31_000))],
    ];
    for (const [name, html] of cases) {
      const t0 = performance.now();
      const r = await extractContent(html, PAGE_URL, ['markdown']);
      expect(r.extractionMethod, name).not.toBe('readability');
      expect(r.markdown!.length, name).toBeGreaterThan(1_000);
      expect(performance.now() - t0, name).toBeLessThan(6_000);
    }
    // Just under the limits, and a realistic large page, still use Readability.
    expect((await extractContent(wrap(1, P.repeat(29_000)), PAGE_URL, ['markdown'])).extractionMethod).toBe('readability');
    expect((await extractContent(largePage(), PAGE_URL, ['markdown'])).extractionMethod).toBe('readability');
  });

  it('stays fast on inputs that were quadratic', async () => {
    const brackets = `<html><body><article>${`<p>${'[ '.repeat(2_000)}</p>`.repeat(20)}</article></body></html>`;
    const longList = `<html><body><article><ol>${'<li>item text here number</li>'.repeat(20_000)}</ol></article></body></html>`;
    for (const html of [brackets, longList]) {
      const t0 = performance.now();
      const r = await extractContent(html, PAGE_URL, ['markdown']);
      expect(r.markdown!.length).toBeGreaterThan(1000);
      expect(performance.now() - t0).toBeLessThan(4_000); // was 2.3 s and 8.8 s
    }
  });
});

describe('element budget', () => {
  const elements = (root: unknown) => cheerio.load(root as string).root().find('*').length;

  it('counts the elements parse5 creates and stops after the token that passes the budget', () => {
    const html = '<p>a</p><p>b</p><p>c</p>'; // html, head and body are implied
    expect(internals.parseHtml(html, 6).truncated).toBe(false);
    const cut = internals.parseHtml(html, 5);
    expect(cut.truncated).toBe(true);
    expect(cheerio.load(cut.document as never).html()).toBe('<html><head></head><body><p>a</p><p>b</p><p></p></body></html>');
    expect(internals.parseHtml('no markup < 3 and a<', 3).truncated).toBe(false);
    const empty = internals.parseHtml('', 2);
    expect(empty.truncated).toBe(true);
    expect(elements(empty.document)).toBe(3); // the EOF token creates all three
    // Comments, raw text and <noscript> (scripting enabled, as in cheerio) hold no elements.
    const tags = '<b>x</b>'.repeat(5);
    for (const [inner, count] of [
      [`<!-- ${tags} -->`, 0],
      [`<script>var s = "${tags}";</script>`, 1],
      [`<textarea>${tags}</textarea><title>${tags}</title><xmp>${tags}</xmp><noscript>${tags}</noscript>`, 4],
      [`<plaintext>${tags}`, 1],
      [`<scripts>${tags}</scripts>`, 6],
    ] as const) {
      const html = `<html><head></head><body>${inner}</body></html>`;
      expect(internals.parseHtml(html, count + 3).truncated, inner).toBe(false);
      expect(internals.parseHtml(html, count + 2).truncated, inner).toBe(true);
    }
  });

  it('extractContent cuts the input and flags the result', async () => {
    const html = `<html><head><title>Budget</title></head><body><article><h1>Budget</h1>${`<p>${LOREM}</p>`.repeat(40)}<p>TAIL-MARKER</p></article></body></html>`;
    const full = await extractContent(html, PAGE_URL, ['markdown'], { maxElements: 1_000 });
    expect(full.truncated).toBeUndefined();
    expect(full.markdown).toContain('TAIL-MARKER');
    const cut = await extractContent(html, PAGE_URL, ['markdown', 'text', 'html'], { maxElements: 20 });
    expect(cut.truncated).toBe(true);
    expect(cut.markdown).toContain('Tide pools');
    expect(cut.markdown).not.toContain('TAIL-MARKER');
    expect(cut.html).not.toContain('TAIL-MARKER');
    expect(Object.keys(cut).at(-1)).toBe('truncated');
  });
});
