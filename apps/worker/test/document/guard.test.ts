import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { guardHtmlNesting } from '../../src/extract/document/guard.js';
import {
  buildSourceDocument,
  documentBuildInfo,
  DOCUMENT_LIMITS,
  HTML_REWRITTEN_WARNING,
} from '../../src/extract/document/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '../../../../tests/fixtures/extraction');
const LIMIT = DOCUMENT_LIMITS.maxHtmlNesting;

const nested = (n: number, tag = 'div') => `<${tag}>`.repeat(n) + 'deep text' + `</${tag}>`.repeat(n);

describe('guardHtmlNesting', () => {
  it('returns ordinary documents unchanged (same string instance)', () => {
    const html = '<!doctype html><html><head><title>T</title></head><body><div><p>Hi <b>there</b></p></div></body></html>';
    const r = guardHtmlNesting(html, LIMIT);
    expect(r.rewritten).toBe(false);
    expect(r.html).toBe(html);
    expect(r.droppedTags).toBe(0);
  });

  it('never rewrites any page in the extraction fixture corpus', () => {
    const ids = readdirSync(fixturesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(ids.length).toBeGreaterThanOrEqual(15);
    for (const id of ids) {
      const html = readFileSync(resolve(fixturesDir, id, 'page.html'), 'utf8');
      const r = guardHtmlNesting(html, LIMIT);
      expect(r.rewritten, id).toBe(false);
      expect(r.maxDepth, id).toBeLessThan(80);
    }
  });

  it('does not count implied end tags as nesting (unclosed li, p, td, option, dt/dd)', () => {
    const lis = '<ul>' + '<li>item'.repeat(5_000) + '</ul>';
    const ps = '<div>' + '<p>para'.repeat(5_000) + '</div>';
    const table = '<table><tbody>' + '<tr><td>a<td>b'.repeat(3_000) + '</tbody></table>';
    const select = '<select>' + '<option>o'.repeat(3_000) + '</select>';
    const dl = '<dl>' + '<dt>t<dd>d'.repeat(3_000) + '</dl>';
    for (const body of [lis, ps, table, select, dl]) {
      const r = guardHtmlNesting(`<html><body>${body}</body></html>`, LIMIT);
      expect(r.rewritten).toBe(false);
      expect(r.maxDepth).toBeLessThan(10);
    }
  });

  it('treats void elements and self-closing SVG/MathML children as non-nesting', () => {
    const voids = '<div>' + '<br><img src=x><input>'.repeat(5_000) + '</div>';
    const svg = '<svg>' + '<path d="M0 0"/>'.repeat(5_000) + '<g><circle r="1"/></g></svg>';
    for (const body of [voids, svg]) {
      const r = guardHtmlNesting(`<html><body>${body}</body></html>`, LIMIT);
      expect(r.rewritten).toBe(false);
      expect(r.maxDepth).toBeLessThan(10);
    }
  });

  it('ignores tag-like text inside scripts, styles, comments and attribute values', () => {
    const fake = '<div>'.repeat(5_000);
    const html =
      `<html><head><script>var s = "${fake}";</script><style>/* ${fake} */</style></head>` +
      `<body><!-- ${fake} --><div title="a > b ${fake}">ok</div><textarea>${fake}</textarea></body></html>`;
    const r = guardHtmlNesting(html, LIMIT);
    expect(r.rewritten).toBe(false);
    expect(r.html).toBe(html);
  });

  it('flattens adversarial nesting beyond the limit while keeping all text', () => {
    const html = `<html><body>${nested(20_000)}<p>tail paragraph</p></body></html>`;
    const r = guardHtmlNesting(html, LIMIT);
    expect(r.rewritten).toBe(true);
    expect(r.droppedTags).toBeGreaterThan(0);
    const $ = cheerio.load(r.html);
    expect($('body').text()).toContain('deep text');
    expect($('p').text()).toBe('tail paragraph');
    // Re-scanning the rewritten HTML stays within the limit.
    expect(guardHtmlNesting(r.html, LIMIT).maxDepth).toBeLessThanOrEqual(LIMIT);
  });

  it('only drops the end tags that match dropped opening tags', () => {
    const html = `<html><body><section>${nested(LIMIT + 50)}</section><footer>f</footer></body></html>`;
    const r = guardHtmlNesting(html, LIMIT);
    expect(r.rewritten).toBe(true);
    const $ = cheerio.load(r.html);
    // The structure after the deep subtree is intact: footer is a body child.
    expect($('body > footer').text()).toBe('f');
    expect($('body > section').length).toBe(1);
  });

  it('stays linear on hostile input (deep nesting, unmatched end tags, unterminated tags)', () => {
    const cases = [
      `<body>${nested(200_000)}</body>`,
      `<body>${'<div>'.repeat(50_000)}${'</span>'.repeat(50_000)}</body>`,
      `<body>${'<div a="'.repeat(1)}${'x'.repeat(500_000)}`,
      `<body>${'<'.repeat(500_000)}</body>`,
    ];
    for (const html of cases) {
      const t = performance.now();
      guardHtmlNesting(html, LIMIT);
      expect(performance.now() - t).toBeLessThan(500);
    }
  });
});

describe('buildSourceDocument with the nesting guard', () => {
  it('builds a 20,000-deep page quickly, keeps its text, and flags the rewrite', () => {
    const html = `<html><body>${nested(20_000)}<p>tail paragraph</p></body></html>`;
    const t = performance.now();
    const doc = buildSourceDocument(html, 'https://example.test/deep');
    const ms = performance.now() - t;
    expect(ms).toBeLessThan(500);
    expect(doc.text).toContain('deep text');
    expect(doc.text).toContain('tail paragraph');
    const info = documentBuildInfo(doc);
    expect(info.warnings.some((w) => w.startsWith(HTML_REWRITTEN_WARNING))).toBe(true);
    // The snapshot hash still identifies the raw HTML the caller supplied.
    expect(doc.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not flag ordinary pages', () => {
    const html = readFileSync(resolve(fixturesDir, 'books-listing', 'page.html'), 'utf8');
    const doc = buildSourceDocument(html, 'https://books.toscrape.com/catalogue/category/books/mystery_3/index.html');
    expect(documentBuildInfo(doc).warnings.some((w) => w.startsWith(HTML_REWRITTEN_WARNING))).toBe(false);
  });
});
