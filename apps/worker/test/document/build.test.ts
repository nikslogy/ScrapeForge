import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_LIMITS,
  blockContext,
  buildSourceDocument,
  documentBuildInfo,
  getBlock,
} from '../../src/extract/document/index.js';
import type { SourceBlock, SourceDocument } from '../../src/extract/types.js';
import {
  INJECTION,
  articlePage,
  gridPage,
  listingPage,
  productPage,
  tablePage,
  uniqueTokenPage,
} from './fixtures.js';
import { assertDocumentInvariants } from './invariants.js';

const PRODUCT_URL = 'https://books.example.com/catalogue/a-light-in-the-attic_1000/index.html';
const LISTING_URL = 'https://books.example.com/catalogue/category/books/mystery_3/index.html';

function byText(doc: SourceDocument, text: string): SourceBlock {
  const b = doc.blocks.find((x) => x.text === text);
  if (!b) throw new Error(`no block with text ${JSON.stringify(text)}`);
  return b;
}

describe('buildSourceDocument: product page', () => {
  const html = productPage();
  const doc = buildSourceDocument(html, PRODUCT_URL);

  it('satisfies the structural invariants', () => {
    assertDocumentInvariants(doc, html);
  });

  it('hashes the raw snapshot and reports stats', () => {
    expect(doc.url).toBe(PRODUCT_URL);
    expect(doc.stats.rawBytes).toBe(Buffer.byteLength(html));
    expect(doc.stats.buildMs).toBeGreaterThan(0);
    expect(buildSourceDocument(html, PRODUCT_URL).snapshotHash).toBe(doc.snapshotHash);
    expect(buildSourceDocument(`${html} `, PRODUCT_URL).snapshotHash).not.toBe(doc.snapshotHash);
  });

  it('takes the title from <title>', () => {
    expect(doc.title).toBe('A Light in the Attic | Books to Scrape - Sandbox');
  });

  it('never lets hidden or non-rendered text into blocks', () => {
    expect(html).toContain(INJECTION);
    expect(doc.text).not.toContain('IGNORE ALL PREVIOUS');
    expect(doc.text).not.toContain('dataLayer');
    expect(doc.text).not.toContain('display: none');
    for (const b of doc.blocks) {
      expect(JSON.stringify(b)).not.toContain('IGNORE ALL PREVIOUS');
    }
  });

  it('flattens JSON-LD @graph into separate items, first', () => {
    const ld = doc.structured.filter((s) => s.source === 'json-ld');
    expect(ld.map((s) => s.type)).toEqual(['Product', 'BreadcrumbList']);
    expect(doc.structured[0].source).toBe('json-ld');
    const product = ld[0].data as Record<string, unknown>;
    expect(product.sku).toBe('a897fe39b1053632');
    expect((product.offers as Record<string, unknown>).price).toBe('51.77');
    doc.structured.forEach((s, i) => expect(s.id).toBe(`sd${i}`));
  });

  it('reads microdata into nested objects', () => {
    const md = doc.structured.filter((s) => s.source === 'microdata');
    expect(md).toHaveLength(1);
    expect(md[0].type).toBe('Product');
    expect(md[0].data).toEqual({
      '@type': 'Product',
      name: 'A Light in the Attic',
      offers: { '@type': 'Offer', price: '51.77', priceCurrency: 'GBP' },
      sku: 'a897fe39b1053632',
    });
  });

  it('collects OpenGraph (first value wins) and standard meta', () => {
    const og = doc.structured.find((s) => s.source === 'opengraph');
    expect(og?.type).toBe('product');
    expect(og?.data).toEqual({
      'og:title': 'A Light in the Attic',
      'og:type': 'product',
      'og:image': 'https://books.example.com/media/cover-1.jpg',
      'product:price:amount': '51.77',
      'product:price:currency': 'GBP',
    });
    const meta = doc.structured.find((s) => s.source === 'meta');
    expect(meta?.data).toEqual({
      description: "It's hard to imagine a world without A Light in the Attic.",
      author: 'Shel Silverstein',
      keywords: 'poetry, children',
      canonical: 'https://books.example.com/catalogue/a-light-in-the-attic_1000/index.html',
    });
  });

  it('emits fields with evidence attributes', () => {
    const price = byText(doc, '£51.77');
    expect(price.kind).toBe('field');
    expect(price.attrs).toMatchObject({ itemprop: 'price', content: '51.77' });

    const stock = byText(doc, 'In stock (22 available)');
    expect(stock.kind).toBe('field');
    expect(stock.attrs?.class).toBe('instock availability');

    // No text, but the class is the rating evidence.
    const rating = doc.blocks.find((b) => b.attrs?.class === 'star-rating Three');
    expect(rating).toMatchObject({ kind: 'field', text: '' });

    const img = doc.blocks.find((b) => b.attrs?.src?.endsWith('fe72f0532301ec28892ae79a629a293c.jpg'));
    expect(img).toMatchObject({ kind: 'field', text: 'A Light in the Attic' });
    expect(img?.attrs?.src).toBe('https://books.example.com/media/cache/fe/72/fe72f0532301ec28892ae79a629a293c.jpg');

    const h1 = doc.blocks.find((b) => b.kind === 'heading' && b.text === 'A Light in the Attic');
    expect(h1?.attrs?.itemprop).toBe('name');
    expect(h1?.selector).toMatch(/ > h1:nth-child\(1\)$/);
  });

  it('tracks heading paths', () => {
    const desc = doc.blocks.find((b) => b.text.startsWith("It's hard to imagine"));
    expect(desc?.kind).toBe('paragraph');
    expect(desc?.headingPath).toEqual(['A Light in the Attic', 'Product Description']);
    const breadcrumb = byText(doc, 'Home');
    expect(breadcrumb.kind).toBe('list-item');
    expect(breadcrumb.headingPath).toEqual([]);
  });

  it('extracts a row-header table without inventing column headers', () => {
    const table = doc.blocks.find((b) => b.kind === 'table');
    expect(table?.table?.headers).toEqual([]);
    expect(table?.table?.rows[0]).toEqual(['UPC', 'a897fe39b1053632']);
    expect(table?.table?.rows).toHaveLength(5);
    expect(table?.headingPath).toEqual(['A Light in the Attic', 'Product Information']);
  });

  it('detects no record groups on a single product page', () => {
    expect(doc.recordGroups).toEqual([]);
  });
});

describe('buildSourceDocument: listing page', () => {
  const html = listingPage(20);
  const doc = buildSourceDocument(html, LISTING_URL);

  it('satisfies the structural invariants', () => {
    assertDocumentInvariants(doc, html);
  });

  it('detects exactly the 20 product cards as one record group', () => {
    expect(doc.recordGroups).toHaveLength(1);
    const g = doc.recordGroups[0];
    expect(g.recordIds).toHaveLength(20);
    expect(g.selector).toMatch(/article\.product_pod$/);
    expect(g.signature).toMatch(/^[0-9a-f]{16}$/);
    const $ = cheerio.load(html);
    expect($(g.selector).length).toBe(20);
    expect($(g.selector).first().hasClass('product_pod')).toBe(true);
  });

  it('parents card content to its record', () => {
    const g = doc.recordGroups[0];
    const rec = getBlock(doc, g.recordIds[3]) as SourceBlock;
    expect(rec.kind).toBe('record');
    expect(rec.recordGroupId).toBe(g.id);
    expect(rec.text).toContain('£13.00');
    expect(rec.text).toContain('Book Title Number 3 With A Long Name');
    const children = doc.blocks.filter((b) => b.parentId === rec.id);
    expect(children.length).toBeGreaterThanOrEqual(6);
    for (const c of children) expect(c.recordGroupId).toBe(g.id);

    const heading = children.find((c) => c.kind === 'heading');
    expect(heading?.text).toBe('Book Title Number 3 ...');
    expect(heading?.attrs).toEqual({
      href: 'https://books.example.com/catalogue/category/books/book-3_1003/index.html',
      title: 'Book Title Number 3 With A Long Name',
    });
    const price = children.find((c) => c.text === '£13.00');
    expect(price?.kind).toBe('field');
    const rating = children.find((c) => c.attrs?.class?.startsWith('star-rating'));
    expect(rating?.attrs?.class).toBe('star-rating Four');
    // The image link becomes an empty-text field carrying the href.
    expect(children.some((c) => c.kind === 'field' && c.text === '' && c.attrs?.href?.endsWith('book-3_1003/index.html'))).toBe(true);
    expect(blockContext(doc, (price as SourceBlock).id)?.record?.id).toBe(rec.id);
  });

  it('scopes card headings to their record', () => {
    const g = doc.recordGroups[0];
    const second = getBlock(doc, g.recordIds[1]) as SourceBlock;
    expect(second.headingPath).toEqual(['Mystery']);
    const pager = byText(doc, 'Page 1 of 2');
    expect(pager.headingPath).toEqual(['Mystery']);
  });

  it('does not treat nav menus, sidebars or footer link columns as records', () => {
    const recordIds = new Set(doc.recordGroups.flatMap((g) => g.recordIds));
    const navItem = byText(doc, 'Travel and adventure books');
    expect(navItem.parentId).toBeUndefined();
    expect(recordIds.has(navItem.id)).toBe(false);
    expect(byText(doc, 'About us and our story').parentId).toBeUndefined();
    expect(doc.blocks.find((b) => b.text.startsWith('Travel (11)'))?.parentId).toBeUndefined();
  });

  it('respects <base href> when resolving URLs', () => {
    const img = doc.blocks.find((b) => b.kind === 'field' && b.attrs?.src);
    expect(img?.attrs?.src).toBe('https://books.example.com/catalogue/category/media/cache/0.jpg');
  });

  it('still hides injected hidden text', () => {
    expect(doc.text).not.toContain('IGNORE ALL PREVIOUS');
  });
});

describe('buildSourceDocument: record detection edge cases', () => {
  it('picks cards (not grid rows) in a bootstrap grid', () => {
    const html = gridPage(3);
    const doc = buildSourceDocument(html, 'https://shop.example.com/gadgets');
    assertDocumentInvariants(doc, html);
    expect(doc.recordGroups).toHaveLength(1);
    const g = doc.recordGroups[0];
    expect(g.recordIds).toHaveLength(9);
    const $ = cheerio.load(html);
    expect($(g.selector).toArray().every((el) => $(el).hasClass('card'))).toBe(true);
  });

  it('does not turn article paragraphs or plain bullet lists into records', () => {
    const html = articlePage();
    const doc = buildSourceDocument(html, 'https://blog.example.com/2026/10/essay');
    assertDocumentInvariants(doc, html);
    expect(doc.recordGroups).toEqual([]);
  });

  it('ignores nav-named wrappers that hold most of the page', () => {
    const items = Array.from({ length: 4 }, (_, i) => `<div class="result"><a href="/r/${i}">Result title ${i}</a><span class="snippet">Snippet text for result ${i}</span></div>`).join('');
    const facets = Array.from({ length: 4 }, (_, i) => `<div class="facet"><a href="/f/${i}">Facet ${i} name</a><span>(${i})</span></div>`).join('');
    const html = `<html><body class="has-sidebar"><div class="content-with-sidebar"><div class="results">${items}</div><div class="sidebar">${facets}</div></div></body></html>`;
    const doc = buildSourceDocument(html, 'https://x.test/');
    assertDocumentInvariants(doc, html);
    expect(doc.recordGroups).toHaveLength(1);
    expect(doc.recordGroups[0].selector).toMatch(/div\.result$/);
  });

  it('needs at least three similar records', () => {
    const two = '<html><body><div class="list"><div class="item"><b>First product</b><i>$1</i></div><div class="item"><b>Second product</b><i>$2</i></div></div></body></html>';
    expect(buildSourceDocument(two, 'https://x.test/').recordGroups).toEqual([]);
  });

  it('excludes hidden siblings from the group selector', () => {
    const items = [0, 1, 2, 3].map((i) => `<li class="product"><h3>Product name ${i}</h3><span class="price">$${i}.00</span></li>`);
    items.splice(2, 0, '<li class="product" style="display:none"><h3>Hidden product</h3><span class="price">$9.99</span></li>');
    const html = `<html><body><ul class="products">${items.join('')}</ul></body></html>`;
    const doc = buildSourceDocument(html, 'https://x.test/');
    assertDocumentInvariants(doc, html);
    expect(doc.recordGroups).toHaveLength(1);
    expect(doc.recordGroups[0].recordIds).toHaveLength(4);
    expect(doc.recordGroups[0].selector).toContain(':not(:nth-child(3))');
    expect(doc.text).not.toContain('Hidden product');
  });

  it('keeps large inner repetition as nested records and parents it correctly', () => {
    const section = (s: number): string => `<section class="shelf"><h2>Shelf ${s}</h2><div class="items">${
      Array.from({ length: 6 }, (_, i) => `<div class="item"><span class="name">Item ${s}-${i} name</span><span class="price">$${i}.50</span></div>`).join('')
    }</div><p>Shelf ${s} footer note</p></section>`;
    const html = `<html><body><main>${section(1)}${section(2)}${section(3)}</main></body></html>`;
    const doc = buildSourceDocument(html, 'https://x.test/');
    assertDocumentInvariants(doc, html);
    const outer = doc.recordGroups.find((g) => g.recordIds.length === 3);
    const inner = doc.recordGroups.filter((g) => g.recordIds.length === 6);
    expect(outer).toBeDefined();
    expect(inner).toHaveLength(3);
    const innerRecord = getBlock(doc, inner[0].recordIds[0]) as SourceBlock;
    expect(innerRecord.parentId).toBe(outer?.recordIds[0]);
  });

  it('drops small inner repetition inside records', () => {
    const cardHtml = (i: number): string => `<div class="card"><h3>Laptop ${i} title</h3><ul class="specs"><li class="spec"><b>CPU</b> <i>fast chip</i></li><li class="spec"><b>RAM</b> <i>16 gigabytes</i></li><li class="spec"><b>SSD</b> <i>1 terabyte</i></li></ul><span class="price">$${i}99</span></div>`;
    const html = `<html><body><div class="grid">${[1, 2, 3, 4].map(cardHtml).join('')}</div></body></html>`;
    const doc = buildSourceDocument(html, 'https://x.test/');
    assertDocumentInvariants(doc, html);
    expect(doc.recordGroups).toHaveLength(1);
    expect(doc.recordGroups[0].recordIds).toHaveLength(4);
  });
});

describe('buildSourceDocument: text partition', () => {
  const html = uniqueTokenPage();
  const doc = buildSourceDocument(html, 'https://x.test/tokens');

  it('satisfies the structural invariants', () => {
    assertDocumentInvariants(doc, html);
  });

  it('keeps every visible text exactly once, in document order', () => {
    const tokens = Array.from({ length: 46 }, (_, i) => `tok${String(i).padStart(2, '0')}`);
    let last = -1;
    for (const t of tokens) {
      const first = doc.text.indexOf(t);
      expect(first, t).toBeGreaterThan(-1);
      expect(doc.text.indexOf(t, first + 1), `${t} duplicated`).toBe(-1);
      expect(first, `${t} out of order`).toBeGreaterThan(last);
      last = first;
    }
  });

  it('splits paragraphs around inline fields without losing order', () => {
    const texts = doc.blocks.map((b) => b.text);
    const i = texts.indexOf('tok05 tok06');
    expect(i).toBeGreaterThan(-1);
    expect(doc.blocks[i + 1]).toMatchObject({ kind: 'field', text: 'tok07' });
    expect(doc.blocks[i + 2]).toMatchObject({ kind: 'paragraph', text: 'tok08', selector: doc.blocks[i].selector });
  });

  it('separates block-level boundaries but not inline ones', () => {
    expect(doc.blocks.some((b) => b.text === 'tok00 tok01')).toBe(true);
    expect(doc.blocks.some((b) => b.text === 'tok30 tok31')).toBe(true);
    expect(doc.blocks.some((b) => b.text === 'tok32 tok33' && b.kind === 'text')).toBe(true);
    expect(doc.blocks.some((b) => b.text === 'tok34 tok35')).toBe(true);
  });

  it('splits nested lists but absorbs paragraphs inside list items and quotes', () => {
    const kinds = Object.fromEntries(doc.blocks.map((b) => [b.text, b.kind]));
    expect(kinds.tok10).toBe('list-item');
    expect(kinds.tok11).toBe('list-item');
    expect(kinds['tok12 tok13']).toBe('list-item');
    expect(kinds.tok14).toBe('list-item');
    expect(kinds['tok15 tok16 tok17']).toBe('paragraph');
    expect(kinds.tok18).toBe('paragraph');
    expect(kinds['tok19 tok20']).toBe('paragraph');
    expect(kinds['tok21 tok22']).toBe('heading');
    expect(kinds.tok23).toBe('field');
    expect(kinds.tok24).toBe('paragraph');
  });

  it('points leftover text blocks at their container', () => {
    const $ = cheerio.load(html);
    const b = byText(doc, 'tok02');
    expect(b.kind).toBe('text');
    expect($(b.selector).text()).toContain('tok03');
    expect(byText(doc, 'tok04').selector).toBe(b.selector);
  });
});

describe('buildSourceDocument: tables', () => {
  const html = tablePage();
  const doc = buildSourceDocument(html, 'https://x.test/specs');

  it('satisfies the structural invariants', () => {
    assertDocumentInvariants(doc, html);
  });

  it('expands header spans and keeps the caption', () => {
    const t = doc.blocks.find((b) => b.kind === 'table' && b.table?.caption);
    expect(t?.table?.caption).toBe('Laptop specs 2026');
    expect(t?.table?.headers).toEqual(['Model', 'CPU', 'RAM', 'Price']);
    expect(t?.table?.rows).toEqual([
      ['Aero 14', 'M5', '16 GB', '$1,299'],
      ['Blade 16', 'Ryzen 9', '32 GB', '$2,499'],
      ['Blade 18', '', '64 GB', '$3,199'],
      ['Prices include VAT'],
    ]);
    expect(t?.text.split('\n')[0]).toBe('Laptop specs 2026');
    expect(t?.text).not.toContain('IGNORE');
  });

  it('treats a headerless 2×2 grid as data and layout tables as containers', () => {
    const kv = doc.blocks.find((b) => b.kind === 'table' && b.table?.rows[0]?.[0] === 'Weight');
    expect(kv?.table).toEqual({ headers: [], rows: [['Weight', '1.2 kg'], ['Battery', '18 h']] });
    expect(doc.blocks.filter((b) => b.kind === 'table')).toHaveLength(2);
    expect(byText(doc, 'Layout cell one').kind).toBe('text');
    expect(byText(doc, 'Sidebar heading').kind).toBe('heading');
    expect(byText(doc, 'Main column text.').kind).toBe('paragraph');
  });

  it('never turns table rows into records', () => {
    expect(doc.recordGroups).toEqual([]);
    const rows = Array.from({ length: 30 }, (_, i) => `<tr class="row"><td><a href="/p/${i}">Product ${i} name</a></td><td>$${i}.99</td><td>In stock</td></tr>`).join('');
    const d = buildSourceDocument(`<html><body><table class="products">${rows}</table></body></html>`, 'https://x.test/');
    expect(d.recordGroups).toEqual([]);
    expect(d.blocks).toHaveLength(1);
    expect(d.blocks[0].table?.rows).toHaveLength(30);
  });

  it('still finds records inside layout tables', () => {
    const posts = Array.from({ length: 4 }, (_, i) => `<div class="post"><b class="author">user${i}</b><p>Post body number ${i} with some words.</p></div>`).join('');
    const html = `<html><body><table><tr><td><h2>Forum</h2><ul><li>Menu</li></ul></td><td>${posts}</td></tr></table></body></html>`;
    const d = buildSourceDocument(html, 'https://x.test/');
    assertDocumentInvariants(d, html);
    expect(d.blocks.some((b) => b.kind === 'table')).toBe(false);
    expect(d.recordGroups).toHaveLength(1);
    expect(d.recordGroups[0].recordIds).toHaveLength(4);
  });

  it('caps table rows and reports it', () => {
    const rows = Array.from({ length: DOCUMENT_LIMITS.maxTableRows + 50 }, (_, i) => `<tr><td>r${i}</td><td>${i}</td></tr>`).join('');
    const big = `<html><body><table><thead><tr><th>k</th><th>v</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
    const d = buildSourceDocument(big, 'https://x.test/');
    const t = d.blocks.find((b) => b.kind === 'table');
    expect(t?.table?.rows).toHaveLength(DOCUMENT_LIMITS.maxTableRows);
    const info = documentBuildInfo(d);
    expect(info.truncated).toBe(true);
    expect(info.warnings.some((w) => w.startsWith('table_rows_truncated'))).toBe(true);
  });

  it('bounds absurd colspan values', () => {
    const d = buildSourceDocument('<table><tr><th colspan="99999">A</th></tr><tr><td colspan="-3">x</td><td>y</td></tr></table>', 'https://x.test/');
    const t = d.blocks.find((b) => b.kind === 'table');
    expect(t?.table?.headers.length).toBe(DOCUMENT_LIMITS.maxColspan);
    expect(t?.table?.rows).toEqual([['x', 'y']]);
  });
});

describe('buildSourceDocument: headings, title and attributes', () => {
  it('maintains a heading stack', () => {
    const doc = buildSourceDocument(articlePage(), 'https://x.test/a');
    expect(byText(doc, 'Detail under the third-level heading.').headingPath)
      .toEqual(['An essay about things', 'Key points', 'Nested detail']);
    expect(byText(doc, 'First quoted paragraph. Second quoted paragraph.').headingPath)
      .toEqual(['An essay about things', 'Conclusion']);
    const byline = doc.blocks.find((b) => b.attrs?.datetime === '2026-10-01');
    expect(byline).toMatchObject({ kind: 'field', text: 'October 1, 2026' });
    expect(doc.blocks.find((b) => b.text === 'Jane Doe')?.attrs?.class).toBe('author');
  });

  it('falls back to og:title, then the first h1', () => {
    const og = buildSourceDocument('<html><head><meta property="og:title" content="OG name"></head><body><h1>H</h1></body></html>', 'https://x.test/');
    expect(og.title).toBe('OG name');
    const h1 = buildSourceDocument('<html><body><h2>Sub</h2><h1>Main  title</h1></body></html>', 'https://x.test/');
    expect(h1.title).toBe('Main title');
    const svgTitle = buildSourceDocument('<html><body><svg><title>Icon</title></svg><p>x</p></body></html>', 'https://x.test/');
    expect(svgTitle.title).toBeUndefined();
  });

  it('caps long heading text in heading paths', () => {
    const long = 'H'.repeat(1000);
    const doc = buildSourceDocument(`<h1>${long}</h1><p>after</p>`, 'https://x.test/');
    expect(byText(doc, long).kind).toBe('heading');
    expect(byText(doc, 'after').headingPath[0].length).toBe(DOCUMENT_LIMITS.maxHeadingPathChars);
  });

  it('keeps only safe, bounded evidence attributes', () => {
    const data = Array.from({ length: 15 }, (_, i) => `data-k${i}="v${i}"`).join(' ');
    const html = `<html><body><ul>${[1, 2, 3].map((i) => `<li class="item"><a class="name" href="javascript:alert(${i})">Item number ${i}</a><img src="data:image/png;base64,AAAA" alt="pic ${i}"><span class="price ${'x'.repeat(300)}" ${data} data-long="${'z'.repeat(300)}">$${i}</span></li>`).join('')}</ul></body></html>`;
    const doc = buildSourceDocument(html, 'https://x.test/');
    assertDocumentInvariants(doc, html);
    const price = byText(doc, '$1');
    expect(price.attrs?.class?.length).toBe(DOCUMENT_LIMITS.maxClassChars);
    const dataKeys = Object.keys(price.attrs ?? {}).filter((k) => k.startsWith('data-'));
    expect(dataKeys).toHaveLength(DOCUMENT_LIMITS.maxDataAttrs);
    expect(price.attrs?.['data-long']).toBeUndefined();
    expect(JSON.stringify(doc.blocks)).not.toContain('javascript:');
    expect(JSON.stringify(doc.blocks)).not.toContain('data:image');
  });

  it('removes zero-width characters and collapses whitespace', () => {
    const doc = buildSourceDocument('<p>Hel\u00adlo\u200b   wor\nld\u00a0!</p>', 'https://x.test/');
    expect(doc.text).toBe('Hello wor ld !');
  });
});

describe('buildSourceDocument: hostile and degenerate input', () => {
  it('handles empty, whitespace and non-HTML input', () => {
    for (const input of ['', '   ', 'plain text only', '<<<>>>', '<html', '\u0000\u0001']) {
      const doc = buildSourceDocument(input, 'not a url');
      assertDocumentInvariants(doc, input);
      expect(doc.url).toBe('not a url');
    }
    expect(buildSourceDocument('plain text only', '').text).toBe('plain text only');
  });

  it('tolerates non-string arguments at runtime', () => {
    const doc = buildSourceDocument(undefined as unknown as string, null as unknown as string);
    expect(doc.blocks).toEqual([]);
    expect(doc.url).toBe('');
  });

  it('handles frameset documents', () => {
    const doc = buildSourceDocument('<html><head><title>F</title></head><frameset><frame src="a.html"></frameset></html>', 'https://x.test/');
    expect(doc.title).toBe('F');
    expect(doc.blocks).toEqual([]);
  });

  it('survives 10k-deep nesting without recursion', () => {
    const depth = 10_000;
    const html = `<html><body>${'<div>x'.repeat(depth)}deepest${'</div>'.repeat(depth)}</body></html>`;
    const doc = buildSourceDocument(html, 'https://x.test/');
    expect(doc.text).toContain('deepest');
    expect(doc.text.split('x').length - 1).toBe(depth);
    // Owners stop at maxBlockDepth, so selectors stay bounded.
    for (const b of doc.blocks) expect(b.selector.split(' > ').length).toBeLessThanOrEqual(DOCUMENT_LIMITS.maxBlockDepth + 3);
    expect(() => JSON.stringify(doc)).not.toThrow();
    assertDocumentInvariants(doc, html, { selectors: false });
  });

  it('survives deep inline and list nesting', () => {
    const spans = `<p>${'<span>'.repeat(5000)}inline${'</span>'.repeat(5000)}</p>`;
    expect(buildSourceDocument(spans, 'https://x.test/').text).toBe('inline');
    const lists = `${'<ul><li>'.repeat(3000)}item${'</li></ul>'.repeat(3000)}`;
    expect(buildSourceDocument(lists, 'https://x.test/').text).toContain('item');
  });

  it('stops at the block cap and says so', () => {
    const html = `<html><body>${'<p>para</p>'.repeat(DOCUMENT_LIMITS.maxBlocks + 500)}</body></html>`;
    const doc = buildSourceDocument(html, 'https://x.test/');
    expect(doc.blocks).toHaveLength(DOCUMENT_LIMITS.maxBlocks);
    const info = documentBuildInfo(doc);
    expect(info.truncated).toBe(true);
    expect(info.warnings.some((w) => w.startsWith('blocks_truncated'))).toBe(true);
    assertDocumentInvariants(doc, html, { selectors: false });
  });

  it('keeps record ranges valid when the cap lands inside a record group', () => {
    const cards = Array.from({ length: 4000 }, (_, i) => `<div class="card"><b class="name">Name ${i}</b><span class="price">$${i}</span><p>Details ${i}</p><p>More ${i}</p><p>Even more ${i}</p></div>`).join('');
    const html = `<html><body><div class="grid">${cards}</div></body></html>`;
    const doc = buildSourceDocument(html, 'https://x.test/');
    expect(doc.blocks).toHaveLength(DOCUMENT_LIMITS.maxBlocks);
    assertDocumentInvariants(doc, html, { selectors: false });
    const g = doc.recordGroups[0];
    const $ = cheerio.load(html);
    expect($(g.selector).length).toBe(g.recordIds.length);
  });

  it('recognizes every supported hiding mechanism and nothing else', () => {
    const html = `<html><body>
      <p hidden="until-found">h1 secret</p>
      <p aria-hidden="TRUE ">h2 secret</p>
      <p style="DISPLAY : NONE !important">h3 secret</p>
      <p style="color:red;visibility:collapse">h4 secret</p>
      <dialog><p>h5 secret</p></dialog>
      <dialog open><p>open dialog shown</p></dialog>
      <p style="--x-display:none; opacity: 0.9">custom property shown</p>
      <p aria-hidden="false">aria false shown</p>
      <p class="d-none hidden sr-only">class hidden shown</p>
      <details><summary>Summary shown</summary><p>Details body shown</p></details>
    </body></html>`;
    const doc = buildSourceDocument(html, 'https://x.test/');
    assertDocumentInvariants(doc, html);
    expect(doc.text).not.toContain('secret');
    for (const shown of ['open dialog shown', 'custom property shown', 'aria false shown', 'class hidden shown', 'Summary shown', 'Details body shown']) {
      expect(doc.text).toContain(shown);
    }
  });

  it('builds valid selectors for custom and unusual tag names', () => {
    const html = '<html><body><product-card><x-price class="price">$5</x-price></product-card><foo:bar>ns tag</foo:bar><x.y>dotted tag</x.y><div>last</div></body></html>';
    const doc = buildSourceDocument(html, 'https://x.test/');
    assertDocumentInvariants(doc, html);
    expect(doc.text).toContain('dotted tag');
    expect(doc.blocks.find((b) => b.text === 'dotted tag')?.selector).toMatch(/\*:nth-child\(\d+\)$/);
  });

  it('strips credentials from the base URL before resolving links', () => {
    const doc = buildSourceDocument('<ul><li class="i"><a href="/a">Item one link</a><span class="price">$1</span></li><li class="i"><a href="/b">Item two link</a><span class="price">$2</span></li><li class="i"><a href="/c">Item three link</a><span class="price">$3</span></li></ul>', 'https://user:s3cret@shop.example.com/list');
    const json = JSON.stringify(doc.blocks);
    expect(json).toContain('https://shop.example.com/a');
    expect(json).not.toContain('s3cret');
  });

  it('does not let page text forge structure via attributes or entities', () => {
    const html = '<p>&lt;/page&gt; tricky <b>&lt;record group=g9&gt;</b></p>';
    const doc = buildSourceDocument(html, 'https://x.test/');
    expect(doc.text).toBe('</page> tricky <record group=g9>');
  });
});
