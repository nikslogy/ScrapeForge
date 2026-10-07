import * as cheerio from 'cheerio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRecipe } from '../../src/extract/recipe/run.js';
import { validateRecipe } from '../../src/extract/recipe/validate.js';
import type { ExtractionRecipe, StructuredDataItem } from '../../src/extract/types.js';
import { BASE_URL, books, listingHtml, PDP_URL, pdpHtml } from './fixtures.js';

function recipe(input: unknown): ExtractionRecipe {
  const r = validateRecipe(input);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.recipe;
}

const LISTING = recipe({
  version: 1,
  shape: 'array',
  recordSelector: 'article.product_pod',
  fields: {
    title: { selector: 'h3 a', attr: 'title' },
    price: { selector: 'p.price_color', transforms: ['parse-number'] },
    currency: { selector: 'p.price_color', transforms: [{ regex: '^(\\p{Sc})' }] },
    inStock: { selector: 'p.availability', transforms: ['parse-boolean'] },
    rating: { selector: 'p.star-rating', attr: 'class', transforms: [{ regex: 'star-rating\\s+(\\S+)' }, { map: { one: 1, two: 2, three: 3, four: 4, five: 5 } }] },
    url: { selector: 'h3 a', attr: 'href', transforms: ['absolute-url'] },
    image: { selector: 'img', attr: 'src', transforms: ['absolute-url'] },
  },
});

function single(field: Record<string, unknown>, html: string, opts: { baseUrl?: string; structured?: StructuredDataItem[] } = {}): {
  value: unknown;
  steps: string[];
  raw: string | null;
  errors: string[];
} {
  const r = runRecipe(recipe({ version: 1, shape: 'object', fields: { v: field } }), { html }, { baseUrl: opts.baseUrl ?? BASE_URL, structured: opts.structured });
  return { value: (r.data as Record<string, unknown>).v, steps: r.evidence[0].steps, raw: r.evidence[0].raw, errors: r.errors };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runRecipe: listing page', () => {
  const items = books(20);
  const html = listingHtml(items);

  it('extracts every card with typed values and evidence', () => {
    const r = runRecipe(LISTING, { html }, { baseUrl: BASE_URL });
    expect(r.errors).toEqual([]);
    expect(r.recordCount).toBe(20);
    const data = r.data as Array<Record<string, unknown>>;
    expect(data[0]).toEqual({
      title: 'A Light in the Attic',
      price: 10,
      currency: '£',
      inStock: true,
      rating: 3,
      url: 'https://books.example.com/catalogue/a-light-in-the-attic_1000/index.html',
      image: new URL(items[0].img, BASE_URL).href,
    });
    data.forEach((rec, i) => {
      expect(rec.title).toBe(items[i].title);
      expect(rec.price).toBe(Number(items[i].price.slice(1)));
      expect(rec.inStock).toBe(items[i].inStock);
    });
    expect(data[3].inStock).toBe(false);
    const ev = r.evidence.find((e) => e.path === '/3/price');
    expect(ev).toEqual({ path: '/3/price', raw: items[3].price, selector: 'p.price_color', steps: ['text', 'parse-number'] });
    expect(r.evidence.find((e) => e.path === '/0/rating')?.steps).toEqual(['attr:class', 'regex', 'map']);
    expect(r.evidence).toHaveLength(20 * 7);
  });

  it('accepts a pre-parsed document and an unvalidated (but valid) recipe object', () => {
    const $ = cheerio.load(html);
    const plain = JSON.parse(JSON.stringify(LISTING)) as ExtractionRecipe;
    const a = runRecipe(plain, { $ }, { baseUrl: BASE_URL });
    const b = runRecipe(LISTING, { html }, { baseUrl: BASE_URL });
    expect(a).toEqual(b);
  });

  it('collects all matches with all: true (capped) and [] when nothing matches', () => {
    const r = runRecipe(
      recipe({ version: 1, shape: 'array', recordSelector: 'article.product_pod', fields: { icons: { selector: 'i', attr: 'class', all: true }, none: { selector: 'video', all: true } } }),
      { html },
      { baseUrl: BASE_URL },
    );
    const first = (r.data as Array<Record<string, unknown>>)[0];
    expect(first.icons).toEqual(['icon-star', 'icon-star', 'icon-star', 'icon-ok']);
    expect(first.none).toEqual([]);
    expect(r.evidence.filter((e) => e.path.startsWith('/0/icons/'))).toHaveLength(4);
    expect(r.evidence.find((e) => e.path === '/0/none')).toMatchObject({ raw: null, steps: ['not-found'] });

    const many = `<ul>${'<li>x</li>'.repeat(150)}</ul>`;
    const capped = single({ selector: 'li', all: true }, many).value as unknown[];
    expect(capped).toHaveLength(100);
  });

  it('keeps values of nested records with the nearest record', () => {
    const nested = `<div class="r"><b>outer</b><div class="r"><b>inner</b></div><i>tail</i></div>`;
    for (const sel of ['b', 'b:first-child']) {
      const r = runRecipe(recipe({ version: 1, shape: 'array', recordSelector: 'div.r', fields: { b: { selector: sel }, all: { selector: 'b', all: true } } }), { html: nested }, { baseUrl: BASE_URL });
      expect(r.data).toEqual([
        { b: 'outer', all: ['outer'] },
        { b: 'inner', all: ['inner'] },
      ]);
    }
    // The slow (cheerio) path makes the same assignment.
    const slow = runRecipe(recipe({ version: 1, shape: 'array', recordSelector: 'div.r', fields: { b: { selector: 'b:not(.zzz)' } } }), { html: nested }, { baseUrl: BASE_URL });
    expect(slow.data).toEqual([{ b: 'outer' }, { b: 'inner' }]);
  });

  it('fast and slow selector paths agree on the listing', () => {
    const fast = runRecipe(recipe({ version: 1, shape: 'array', recordSelector: 'article.product_pod', fields: { t: { selector: 'h3 > a', attr: 'title' }, p: { selector: 'div.product_price p:first-child' } } }), { html }, { baseUrl: BASE_URL });
    const slow = runRecipe(recipe({ version: 1, shape: 'array', recordSelector: 'article.product_pod', fields: { t: { selector: 'h3 > a:not(.none)', attr: 'title' }, p: { selector: 'div.product_price p:is(:first-child)' } } }), { html }, { baseUrl: BASE_URL });
    expect(fast.data).toEqual(slow.data);
  });
});

describe('runRecipe: product page', () => {
  const html = pdpHtml();
  const PDP = recipe({
    version: 1,
    shape: 'object',
    scopeSelector: 'article.product_page',
    fields: {
      title: { selector: 'h1' },
      price: { selector: 'p.price', transforms: [{ regex: 'Price:\\s*(\\S+)' }, 'parse-number'] },
      priceText: { selector: 'p.price', transforms: [{ regex: 'Price:\\s*(\\S+)' }, 'strip-currency'] },
      stock: { selector: 'p.availability', transforms: [{ regex: '\\((\\d+) available\\)' }, 'parse-integer'] },
      available: { selector: 'p.availability', transforms: ['parse-boolean'] },
      upc: { selector: 'table tr:nth-child(1) > td' },
      description: { selector: '#product_description + p' },
      missing: { selector: 'span.does-not-exist' },
    },
  });

  it('extracts fields with regex, number, integer and boolean transforms', () => {
    const r = runRecipe(PDP, { html }, { baseUrl: PDP_URL });
    expect(r.errors).toEqual([]);
    expect(r.recordCount).toBe(1);
    expect(r.data).toEqual({
      title: 'A Light in the Attic',
      price: 51.77,
      priceText: '51.77',
      stock: 22,
      available: true,
      upc: 'a897fe39b1053632',
      description: "It's hard to imagine a world without A Light in the Attic. This now-classic collection of poetry and drawings is a treasure.",
      missing: null,
    });
    expect(r.evidence.find((e) => e.path === '/missing')).toEqual({ path: '/missing', raw: null, selector: 'span.does-not-exist', steps: ['not-found'] });
    expect(r.evidence.find((e) => e.path === '/stock')?.steps).toEqual(['text', 'regex', 'parse-integer']);
  });

  it('reports a missing scope instead of throwing', () => {
    const r = runRecipe(recipe({ version: 1, shape: 'object', scopeSelector: 'main.nope', fields: { t: { selector: 'h1' } } }), { html }, { baseUrl: PDP_URL });
    expect(r.errors).toEqual(['scope selector matched nothing']);
    expect(r.data).toEqual({ t: null });
    expect(r.recordCount).toBe(0);
  });

  it('reads the scope element itself with selector ""', () => {
    expect(single({ selector: '', attr: 'lang' }, '<html lang="en"><body></body></html>').value).toBeNull();
    const r = runRecipe(recipe({ version: 1, shape: 'object', scopeSelector: 'p.price', fields: { t: { selector: '' }, c: { attr: 'class' } } }), { html }, { baseUrl: PDP_URL });
    expect(r.data).toEqual({ t: 'Price: £51.77', c: 'price' });
  });
});

describe('runRecipe: text and attributes', () => {
  it('collapses whitespace, separates blocks and skips script/style', () => {
    const html = `<div id="d">  Hello\n\t<b>wor</b>ld<p>next</p><script>evil()</script><style>.x{}</style>&nbsp;end<br>line</div>`;
    expect(single({ selector: '#d' }, html).value).toBe('Hello world next end line');
  });

  it('leaves hidden descendants and svg out of text, like the document builder', () => {
    const html = `<span class="price"><span class="a-offscreen">$12.99</span><span aria-hidden="true">$12<sup>99</sup></span><span hidden>old</span><span style="display: none !important">x</span><svg><title>icon</title></svg></span>`;
    expect(single({ selector: 'span.price' }, html).value).toBe('$12.99');
    // The selected element itself is read even when hidden.
    expect(single({ selector: 'span[aria-hidden]' }, html).value).toBe('$1299');
    expect(single({ selector: 'p' }, '<p style="--x-display:none">kept</p>').value).toBe('kept');
  });

  it('keeps zero-width joiners and drops soft hyphens', () => {
    expect(single({ selector: 'p' }, '<p>Hel\u00adlo \u200d\u{1F600}</p>').value).toBe('Hello \u200d\u{1F600}');
  });

  it('missing elements and attributes are null with a reason step', () => {
    expect(single({ selector: 'h9' }, '<p>x</p>')).toMatchObject({ value: null, raw: null, steps: ['not-found'] });
    expect(single({ selector: 'p', attr: 'title' }, '<p>x</p>')).toMatchObject({ value: null, steps: ['attr:title:no-value'] });
    expect(single({ selector: 'p' }, '<p>   </p>').value).toBeNull();
  });

  it('never reads prototype members as attributes', () => {
    expect(single({ selector: 'p', attr: 'constructor' }, '<p>x</p>').value).toBeNull();
    expect(single({ selector: 'p', attr: '__proto__' }, '<p>x</p>').value).toBeNull();
    expect(single({ selector: 'p', attr: 'data-x' }, '<p DATA-X="1">x</p>').value).toBe('1');
  });

  it('survives hostile nesting depth', () => {
    const deep = `${'<div>'.repeat(5_000)}<span class="v">deep</span>${'</div>'.repeat(5_000)}`;
    expect(single({ selector: 'span.v' }, deep).value).toBe('deep');
    expect(single({ selector: 'div' }, deep).value).toBe('deep');
  });

  it('caps very long values', () => {
    const r = single({ selector: 'p' }, `<p>${'x'.repeat(150_000)}</p>`);
    expect((r.value as string).length).toBe(100_000);
  });
});

describe('runRecipe: transforms', () => {
  const t = (transforms: unknown[], text: string, baseUrl?: string): unknown => single({ selector: 'p', transforms }, `<p>${text}</p>`, { baseUrl }).value;

  it('parse-number handles US/EU formats and currency symbols', () => {
    expect(t(['parse-number'], '1,299.00')).toBe(1299);
    expect(t(['parse-number'], '1.299,00 €')).toBe(1299);
    expect(t(['parse-number'], '£51.77')).toBe(51.77);
    expect(t(['parse-number'], 'USD 12.50')).toBe(12.5);
    expect(t(['parse-number'], '1 299,99 zł')).toBe(1299.99);
    expect(t(['parse-number'], '-3.5')).toBe(-3.5);
    expect(t(['parse-number'], '4.5 out of 5')).toBe(4.5);
    expect(t(['parse-number'], 'Call for price')).toBeNull();
    expect(t(['parse-number'], '$10 - $20')).toBeNull();
    expect(t(['parse-integer'], '1.299,00')).toBe(1299);
    expect(t(['parse-integer'], '4.5')).toBeNull();
    expect(t(['parse-integer'], 'In stock (22 available)')).toBe(22);
  });

  it('parse-boolean recognizes stock and yes/no words', () => {
    const cases: Array<[string, boolean | null]> = [
      ['In stock', true], ['Out of stock', false], ['yes', true], ['No', false], ['true', true], ['FALSE', false],
      ['Available', true], ['Sold out', false], ['In stock (22 available)', true], ['maybe', null],
    ];
    for (const [text, want] of cases) expect(t(['parse-boolean'], text), text).toBe(want);
  });

  it('string transforms', () => {
    expect(t(['lowercase'], 'MiXeD')).toBe('mixed');
    expect(t(['uppercase'], 'MiXeD')).toBe('MIXED');
    expect(t(['strip-currency'], '£51.77')).toBe('51.77');
    expect(t(['strip-currency'], '1.299,00 €')).toBe('1.299,00');
    expect(t(['strip-currency'], 'US$ 12')).toBe('12');
    expect(t(['strip-currency'], 'EUR 7,50')).toBe('7,50');
    expect(single({ selector: 'p', attr: 'title', transforms: ['trim', 'collapse-whitespace'] }, '<p title="  a \n  b ">x</p>').value).toBe('a b');
  });

  it('absolute-url resolves against the page and <base href>, rejecting script URLs', () => {
    const a = (href: string, extra = ''): unknown => single({ selector: 'a', attr: 'href', transforms: ['absolute-url'] }, `${extra}<a href="${href}">x</a>`).value;
    expect(a('../x.html')).toBe('https://books.example.com/x.html');
    expect(a('//cdn.example.com/i.png')).toBe('https://cdn.example.com/i.png');
    expect(a('javascript:alert(1)')).toBeNull();
    expect(a('data:text/html,hi')).toBeNull();
    expect(a('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(a('p/1', '<base href="https://other.example.org/shop/">')).toBe('https://other.example.org/shop/p/1');
    expect(a('p/1', '<base href="javascript:void(0)">')).toBe('https://books.example.com/catalogue/p/1');
    expect(single({ selector: 'a', attr: 'href', transforms: ['absolute-url'] }, '<a href="/x">x</a>', { baseUrl: 'not a url' }).value).toBeNull();
    expect(single({ selector: 'a', attr: 'href', transforms: ['absolute-url'] }, '<a href="https://ok.example/x">x</a>', { baseUrl: 'not a url' }).value).toBe('https://ok.example/x');
  });

  it('regex: default group, explicit group 0, no match, 10,000-char input cap', () => {
    expect(t([{ regex: 'Price: (\\S+)' }], 'Price: £5')).toBe('£5');
    expect(t([{ regex: 'Price: \\S+', group: 0 }], 'Price: £5')).toBe('Price: £5');
    expect(t([{ regex: '\\d+' }], 'abc 42')).toBe('42');
    expect(t([{ regex: '(\\d+)' }], 'none')).toBeNull();
    expect(single({ selector: 'p', transforms: [{ regex: '(\\d+)' }] }, '<p>none</p>').steps).toEqual(['text', 'regex:no-value']);
    const late = `${'a'.repeat(10_000)} 42`;
    expect(t([{ regex: '(\\d+)' }], late)).toBeNull();
    expect(t([{ regex: '(\\d+)' }], `${'a'.repeat(9_990)} 42`)).toBe('42');
  });

  it('map: trimmed, case-insensitive exact match; misses are null; keys are data', () => {
    const parsed = JSON.parse('{"map": {"In Stock": "yes", "three": 3, "__proto__": "proto"}}');
    expect(t([parsed], '  in stock ')).toBe('yes');
    expect(t([parsed], 'THREE')).toBe(3);
    expect(t([parsed], 'In stock now')).toBeNull();
    expect(t([parsed], '__proto__')).toBe('proto');
    expect(t([parsed], 'constructor')).toBeNull();
    expect(t([{ map: { a: '7' } }, 'parse-integer'], 'A')).toBe(7);
  });
});

describe('runRecipe: structured data', () => {
  const structured: StructuredDataItem[] = [
    { id: 'sd0', source: 'json-ld', type: 'BreadcrumbList', data: { itemListElement: [{ name: 'Home' }] } },
    {
      id: 'sd1',
      source: 'json-ld',
      type: 'https://schema.org/Product',
      data: { name: 'Widget', offers: { price: 19.99, priceCurrency: 'USD' }, image: ['a.jpg', 'b.jpg', { '@id': 'x' }], sku: { '@value': 'S-1' }, inStock: true },
    },
  ];
  const s = (field: Record<string, unknown>, html = '<p class="price">$5.00</p>'): ReturnType<typeof single> => single(field, html, { structured });

  it('reads by type and JSON pointer, with transforms', () => {
    expect(s({ structured: { type: 'Product', pointer: '/name' } }).value).toBe('Widget');
    expect(s({ structured: { type: 'product', pointer: '/offers/price' }, transforms: ['parse-number'] }).value).toBe(19.99);
    expect(s({ structured: { pointer: '/offers/price' } }).steps).toEqual(['structured']);
    expect(s({ structured: { pointer: '/sku' } }).value).toBe('S-1');
    expect(s({ structured: { pointer: '/inStock' }, transforms: ['parse-boolean'] }).value).toBe(true);
    expect(s({ structured: { pointer: '/image' } }).value).toBe('a.jpg');
    expect(s({ structured: { pointer: '/image' }, all: true }).value).toEqual(['a.jpg', 'b.jpg']);
    const r = runRecipe(recipe({ version: 1, shape: 'object', fields: { p: { structured: { type: 'Product', pointer: '/offers/price' } } } }), { html: '' }, { baseUrl: BASE_URL, structured });
    expect(r.evidence[0]).toEqual({ path: '/p', raw: '19.99', structuredPointer: 'sd1/offers/price', steps: ['structured'] });
  });

  it('falls back to the DOM when structured data lacks the value', () => {
    expect(s({ structured: { type: 'Product', pointer: '/missing' }, selector: 'p.price', transforms: ['parse-number'] }).value).toBe(5);
    expect(s({ structured: { type: 'Offer', pointer: '/name' } }).value).toBeNull();
    expect(single({ structured: { pointer: '/name' } }, '<p>x</p>').value).toBeNull();
  });

  it('never follows prototype members or non-scalar values', () => {
    expect(s({ structured: { pointer: '/constructor' } }).value).toBeNull();
    expect(s({ structured: { pointer: '/__proto__' } }).value).toBeNull();
    expect(s({ structured: { pointer: '/offers' } }).value).toBeNull();
    expect(s({ structured: { pointer: '/image/01' } }).value).toBeNull();
    expect(s({ structured: { pointer: '/image/5' } }).value).toBeNull();
  });
});

describe('runRecipe: limits and failures', () => {
  const html = listingHtml(books(30));

  it('stops at maxRecords with an error entry', () => {
    const r = runRecipe(LISTING, { html }, { baseUrl: BASE_URL, maxRecords: 10 });
    expect(r.recordCount).toBe(10);
    expect(r.data).toHaveLength(10);
    expect(r.errors).toEqual(['maxRecords reached: 30 records matched, only the first 10 were extracted']);
  });

  it('a past deadline returns no data and an error', () => {
    const r = runRecipe(LISTING, { html }, { baseUrl: BASE_URL, deadlineMs: Date.now() - 1 });
    expect(r).toMatchObject({ data: [], recordCount: 0, errors: ['deadline exceeded before the recipe ran'] });
  });

  it('checks the deadline between records and returns what it has', () => {
    let calls = 0;
    const realNow = Date.now.bind(Date);
    const start = realNow();
    vi.spyOn(Date, 'now').mockImplementation(() => (++calls > 6 ? start + 10_000 : start));
    const r = runRecipe(LISTING, { html }, { baseUrl: BASE_URL, deadlineMs: start + 5_000 });
    expect(r.recordCount).toBeGreaterThan(0);
    expect(r.recordCount).toBeLessThan(30);
    expect(r.errors).toEqual([`deadline exceeded after ${r.recordCount} of 30 records`]);
    expect((r.data as unknown[]).length).toBe(r.recordCount);
  });

  it('returns validation errors for an invalid recipe instead of running it', () => {
    const bad = { version: 1, shape: 'array', recordSelector: 'li:contains(x)', fields: { a: { selector: 'p', transforms: [{ regex: '(a+)+' }] } } };
    const r = runRecipe(bad as unknown as ExtractionRecipe, { html }, { baseUrl: BASE_URL });
    expect(r.data).toEqual([]);
    expect(r.recordCount).toBe(0);
    expect(r.errors.length).toBe(2);
    expect(r.errors.every((e) => e.startsWith('invalid recipe: '))).toBe(true);
    const proto = JSON.parse('{"version":1,"shape":"object","fields":{"__proto__":{"selector":"p"}}}');
    expect(runRecipe(proto, { html }, { baseUrl: BASE_URL }).errors[0]).toMatch(/reserved name/);
    expect(runRecipe(null as unknown as ExtractionRecipe, { html }, { baseUrl: BASE_URL }).errors[0]).toMatch(/JSON object/);
  });

  it('empty documents and no matches are fine', () => {
    expect(runRecipe(LISTING, { html: '' }, { baseUrl: BASE_URL })).toEqual({ data: [], evidence: [], recordCount: 0, errors: [] });
    expect(runRecipe(LISTING, { html: '<<<>>>' }, { baseUrl: BASE_URL }).recordCount).toBe(0);
  });
});
