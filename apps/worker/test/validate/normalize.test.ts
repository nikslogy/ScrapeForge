import { describe, expect, it } from 'vitest';
import { normalizeSchema } from '../../src/extract/schema/normalize.js';
import { isUrlField, normalizeValue, parseLocaleNumber, type NormalizeContext } from '../../src/extract/validate/normalize.js';
import type { FieldSpec, FieldType, JsonSchema } from '../../src/extract/types.js';

const ctx: NormalizeContext = { baseUrl: 'https://books.example.com/catalogue/page-2.html' };

function spec(type: FieldType, extra: Partial<FieldSpec> = {}): FieldSpec {
  return { name: 'value', type, required: false, nullable: true, derived: false, schema: {}, ...extra };
}

const number = spec('number');
const integer = spec('integer');
const boolean = spec('boolean');
const string = spec('string');

function value(raw: unknown, field: FieldSpec, context: NormalizeContext = ctx): unknown {
  const result = normalizeValue(raw, field, context);
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.detail}`);
  return result.value;
}

function failure(raw: unknown, field: FieldSpec, context: NormalizeContext = ctx): string {
  const result = normalizeValue(raw, field, context);
  if (result.ok) throw new Error(`expected failure, got ${JSON.stringify(result.value)}`);
  return result.reason;
}

it('re-exports parseLocaleNumber', () => {
  expect(parseLocaleNumber('1.299,00')).toBe(1299);
});

describe('empty values', () => {
  it.each([[null], [undefined], [''], ['   '], ['\n\t ']])('%j → null with step "empty"', (raw) => {
    for (const type of ['string', 'number', 'integer', 'boolean', 'array', 'object', 'unknown'] as FieldType[]) {
      expect(normalizeValue(raw, spec(type), ctx)).toEqual({ ok: true, value: null, steps: ['empty'] });
    }
  });
});

describe('numbers', () => {
  it.each([
    ['£51.77', 51.77, ['strip-currency', 'parse-number']],
    ['$1,299.00', 1299, ['strip-currency', 'parse-number']],
    ['1.299,00 €', 1299, ['strip-currency', 'parse-number']],
    ['1 299,00 €', 1299, ['strip-currency', 'parse-number']],
    ['1\u00a0299,00\u00a0€', 1299, ['strip-currency', 'parse-number']],
    ['1\u202f299,00 €', 1299, ['strip-currency', 'parse-number']],
    ['€12,99', 12.99, ['strip-currency', 'parse-number']],
    ['¥1,200', 1200, ['strip-currency', 'parse-number']],
    ['￥１，２００', 1200, ['strip-currency', 'parse-number']],
    ['₹1,23,456.00', 123456, ['strip-currency', 'parse-number']],
    ['USD 12', 12, ['strip-currency', 'parse-number']],
    ['12 EUR', 12, ['strip-currency', 'parse-number']],
    ['EUR12', 12, ['strip-currency', 'parse-number']],
    ['US$ 9.99', 9.99, ['strip-currency', 'parse-number']],
    ['Rs. 499', 499, ['strip-currency', 'parse-number']],
    ['CHF 1\'299.50', 1299.5, ['strip-currency', 'parse-number']],
    ['12', 12, ['parse-number']],
    ['  3.5  ', 3.5, ['parse-number']],
    ['-5', -5, ['parse-number']],
    ['−2.5', -2.5, ['parse-number']],
    ['15%', 15, ['percent', 'parse-number']],
    ['-20 %', -20, ['percent', 'parse-number']],
    ['4.5 out of 5', 4.5, ['rating-scale', 'parse-number']],
    ['4.5/5', 4.5, ['rating-scale', 'parse-number']],
    ['3 of 5 stars', 3, ['rating-scale', 'parse-number']],
    ['Three', 3, ['number-word', 'parse-number']],
    ['star-rating Three', 3, ['number-word', 'parse-number']],
    ['four out of five stars', 4, ['number-word', 'parse-number']],
    ['1.2K', 1200, ['scale-suffix', 'parse-number']],
    ['3.4 million', 3400000, ['scale-suffix', 'parse-number']],
    ['$2B', 2e9, ['strip-currency', 'scale-suffix', 'parse-number']],
    ['(1,024 reviews)', 1024, ['extract-number', 'parse-number']],
    ['5 Mio. €', 5e6, ['strip-currency', 'scale-suffix', 'parse-number']],
    ['₹2 lakh', 2e5, ['strip-currency', 'scale-suffix', 'parse-number']],
    ['1.5 crore', 1.5e7, ['scale-suffix', 'parse-number']],
    ['Price: £5', 5, ['strip-currency', 'extract-number', 'parse-number']],
    ['$10 / $10', 10, ['strip-currency', 'parse-number']],
  ])('%j → %d', (raw, expected, steps) => {
    expect(normalizeValue(raw, number, ctx)).toEqual({ ok: true, value: expected, steps });
  });

  it('passes finite numbers through without steps', () => {
    expect(normalizeValue(51.77, number, ctx)).toEqual({ ok: true, value: 51.77, steps: [] });
    expect(normalizeValue(0, number, ctx)).toEqual({ ok: true, value: 0, steps: [] });
  });

  it.each([
    ['$10 - $20'],
    ['10–20'],
    ['10 to 20'],
    ['Was $20, now $15'],
    ['4.5 out of 5 stars (120 reviews)'],
    ['3 for $10'],
    ['$5 mil'],
    ['5 mil euros'],
    ['1,2,3'.replace(/,/g, ', ')],
  ])('%j is ambiguous (never guessed)', (raw) => {
    expect(failure(raw, number)).toBe('ambiguous');
  });

  it.each([['Free'], ['Call for price'], ['N/A'], ['—'], ['One of the best'], ['SKU A1B2'], ['10,20,30'], [`${'1 '.repeat(150)}`]])(
    '%j is unparseable',
    (raw) => {
      expect(failure(raw, number)).toBe('unparseable');
    },
  );

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY]])('%d is unparseable', (raw) => {
    expect(failure(raw, number)).toBe('unparseable');
  });

  it.each([[true], [{ amount: 5 }], [[5]]])('%j is a type mismatch', (raw) => {
    expect(failure(raw, number)).toBe('type_mismatch');
  });

  it('rejects huge inputs without scanning them', () => {
    const t0 = performance.now();
    expect(failure('9'.repeat(5_000_000), number)).toBe('unparseable');
    expect(performance.now() - t0).toBeLessThan(200);
  });

  describe('integers', () => {
    it.each([
      ['(1,024 reviews)', 1024],
      ['1.024 Bewertungen', 1024],
      ['1,024', 1024],
      ['22 available', 22],
      ['1.2K', 1200],
      ['Three', 3],
      ['3 of 5', 3],
    ])('%j → %d', (raw, expected) => {
      expect(value(raw, integer)).toBe(expected);
    });

    it('records parse-integer', () => {
      expect(normalizeValue('(1,024 reviews)', integer, ctx)).toEqual({ ok: true, value: 1024, steps: ['extract-number', 'parse-integer'] });
    });

    it.each([['4.5'], ['1,5'], [4.5], ['4.5 out of 5']])('%j is not an integer', (raw) => {
      expect(failure(raw, integer)).toBe('type_mismatch');
    });
  });

  describe('locale hint', () => {
    it('resolves the ambiguous shape', () => {
      expect(value('1.234', number)).toBe(1.234);
      expect(value('1.234', number, { ...ctx, decimalSeparator: ',' })).toBe(1234);
      expect(value('1,234', number, { ...ctx, decimalSeparator: ',' })).toBe(1.234);
      expect(value('1,234', number)).toBe(1234);
    });
  });
});

describe('booleans', () => {
  it.each([
    ['true', true],
    ['Yes', true],
    ['Y', true],
    ['In stock', true],
    ['In Stock (22 available)', true],
    ['instock', true],
    ['Available', true],
    ['Add to cart', true],
    ['ADD TO BASKET', true],
    ['Buy now', true],
    ['Pre-order', true],
    ['Preorder now', true],
    ['Only 3 left in stock!', true],
    ['Back in stock', true],
    ['https://schema.org/InStock', true],
    ['http://schema.org/PreOrder', true],
    ['✓', true],
    ['false', false],
    ['No', false],
    ['Out of stock', false],
    ['OUT-OF-STOCK', false],
    ['Not available', false],
    ['Not in stock', false],
    ['Unavailable', false],
    ['Currently unavailable.', false],
    ['Sold out', false],
    ['SOLD OUT!', false],
    ['Discontinued', false],
    ['Email me when back in stock', false],
    ['Notify me when available', false],
    ['Coming soon', false],
    ['schema.org/OutOfStock', false],
    ['https://schema.org/SoldOut', false],
  ])('%j → %s', (raw, expected) => {
    expect(normalizeValue(raw, boolean, ctx)).toEqual({ ok: true, value: expected, steps: ['parse-boolean'] });
  });

  it('passes booleans through and accepts 1/0', () => {
    expect(normalizeValue(true, boolean, ctx)).toEqual({ ok: true, value: true, steps: [] });
    expect(value(1, boolean)).toBe(true);
    expect(value(0, boolean)).toBe(false);
  });

  it('flags contradictory text as ambiguous', () => {
    expect(failure('In stock online, sold out in store', boolean)).toBe('ambiguous');
  });

  it.each([['maybe'], ['Red'], ['schema.org/constructor'], ['schema.org/Unknown'], [2], ['x'.repeat(500)]])('%j is unparseable', (raw) => {
    expect(failure(raw, boolean)).toBe('unparseable');
  });

  it.each([[{}], [['yes']]])('%j is a type mismatch', (raw) => {
    expect(failure(raw, boolean)).toBe('type_mismatch');
  });
});

describe('strings', () => {
  it('trims and collapses whitespace, reporting only what changed', () => {
    expect(normalizeValue('  A  Light\n in\tthe Attic ', string, ctx)).toEqual({
      ok: true,
      value: 'A Light in the Attic',
      steps: ['trim', 'collapse-whitespace'],
    });
    expect(normalizeValue('plain', string, ctx)).toEqual({ ok: true, value: 'plain', steps: [] });
    expect(normalizeValue('a\u00a0\u00a0b', string, ctx)).toEqual({ ok: true, value: 'a b', steps: ['collapse-whitespace'] });
  });

  it('keeps the text otherwise verbatim (no NFKC, no case change)', () => {
    expect(value('ﬁne Ｃafé “quoted”', string)).toBe('ﬁne Ｃafé “quoted”');
  });

  it('stringifies numbers and booleans', () => {
    expect(normalizeValue(12, string, ctx)).toEqual({ ok: true, value: '12', steps: ['to-string'] });
    expect(value(false, string)).toBe('false');
  });

  it.each([[{ a: 1 }], [['a']], [Number.NaN]])('%j is a type mismatch', (raw) => {
    expect(failure(raw, string)).toBe('type_mismatch');
  });

  it('matches enum values loosely when exactly one matches', () => {
    const field = spec('string', { schema: { type: 'string', enum: ['in_stock', 'out_of_stock'] } });
    expect(normalizeValue('In Stock', field, ctx)).toEqual({ ok: true, value: 'in_stock', steps: ['enum-match'] });
    expect(normalizeValue('in_stock', field, ctx)).toEqual({ ok: true, value: 'in_stock', steps: [] });
    expect(value('Limited', field)).toBe('Limited');
    const twoMatches = spec('string', { schema: { enum: ['in-stock', 'in stock'] } });
    expect(value('IN STOCK', twoMatches)).toBe('IN STOCK');
  });
});

describe('URLs', () => {
  const url = spec('string', { name: 'url', schema: { type: 'string', format: 'uri' } });

  it.each([
    ['../../media/cache/a.jpg', 'https://books.example.com/media/cache/a.jpg'],
    ['/catalogue/x_1/index.html', 'https://books.example.com/catalogue/x_1/index.html'],
    ['x_1/index.html', 'https://books.example.com/catalogue/x_1/index.html'],
    ['page-3.html', 'https://books.example.com/catalogue/page-3.html'],
    ['?page=3', 'https://books.example.com/catalogue/page-2.html?page=3'],
    ['#reviews', 'https://books.example.com/catalogue/page-2.html#reviews'],
    ['//cdn.example.net/a.png', 'https://cdn.example.net/a.png'],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeValue(raw, url, ctx)).toEqual({ ok: true, value: expected, steps: ['absolute-url'] });
  });

  it.each([
    ['https://other.example/a'],
    ['HTTP://Example.COM/A'],
    ['mailto:a@b.co'],
    ['javascript:void(0)'],
    ['data:image/png;base64,AAAA'],
    ['www.example.com'],
    ['Click here'],
    ['Buy'],
  ])('leaves %j unchanged', (raw) => {
    expect(normalizeValue(raw, url, ctx)).toEqual({ ok: true, value: raw, steps: [] });
  });

  it('leaves relative URLs alone when the base URL is unusable', () => {
    expect(value('/a.html', url, { baseUrl: 'not a url' })).toBe('/a.html');
    expect(value('/a.html', url, { baseUrl: '' })).toBe('/a.html');
  });

  it('detects URL fields by format, name or description', () => {
    expect(isUrlField({ name: 'x', schema: { format: 'uri-reference' } })).toBe(true);
    for (const name of ['url', 'imageUrl', 'image_url', 'productLink', 'href', 'thumbnail', 'images', 'logo', 'img_src']) {
      expect(isUrlField({ name, schema: {} })).toBe(true);
    }
    for (const name of ['title', 'linkText', 'imageAlt', 'image_count', 'urlTitle', 'price']) {
      expect(isUrlField({ name, schema: {} })).toBe(false);
    }
    expect(isUrlField({ name: 'target', description: 'absolute URL of the product page', schema: {} })).toBe(true);
    expect(isUrlField({ name: 'target', description: 'the product name', schema: {} })).toBe(false);
  });

  it('resolves relative URLs for name-detected fields too', () => {
    const image = spec('string', { name: 'imageUrl' });
    expect(value('../media/a.jpg', image)).toBe('https://books.example.com/media/a.jpg');
    const linkText = spec('string', { name: 'linkText' });
    expect(value('next/page.html', linkText)).toBe('next/page.html');
  });

  it('works with fields produced by normalizeSchema', () => {
    const s = normalizeSchema({ url: 'url', image: 'string — cover image', images: 'url[]' });
    const byName = (n: string) => s.fields.find((f) => f.name === n)!;
    expect(value('/a', byName('url'))).toBe('https://books.example.com/a');
    expect(value('img/b.jpg', byName('image'))).toBe('https://books.example.com/catalogue/img/b.jpg');
    expect(value(['/1.jpg', '/2.jpg'], byName('images'))).toEqual(['https://books.example.com/1.jpg', 'https://books.example.com/2.jpg']);
  });
});

describe('arrays', () => {
  const strings = spec('array', { itemType: 'string' });
  const numbers = spec('array', { itemType: 'number' });

  it('normalizes each item and merges steps', () => {
    expect(normalizeValue(['  a ', 'b'], strings, ctx)).toEqual({ ok: true, value: ['a', 'b'], steps: ['trim'] });
    expect(normalizeValue(['£1.50', '£2'], numbers, ctx)).toEqual({ ok: true, value: [1.5, 2], steps: ['strip-currency', 'parse-number'] });
  });

  it('drops empty items and says so', () => {
    expect(normalizeValue(['a', '', null, 'b'], strings, ctx)).toEqual({ ok: true, value: ['a', 'b'], steps: ['drop-empty-items'] });
  });

  it('fails the whole field on a bad item, naming it', () => {
    const result = normalizeValue(['£1', 'Free'], numbers, ctx);
    expect(result).toEqual({ ok: false, reason: 'unparseable', detail: 'item 1: no number in "Free"' });
    expect(failure(['$1 - $2'], numbers)).toBe('ambiguous');
  });

  it.each([
    ['red, green ,blue', ['red', 'green', 'blue']],
    ['a; b, c', ['a', 'b, c']],
    ['a | b | c', ['a', 'b', 'c']],
    ['line one\nline two\r\n\r\nline three', ['line one', 'line two', 'line three']],
    ['single', ['single']],
    [',,', []],
  ])('splits %j on clear separators', (raw, expected) => {
    expect(value(raw, strings)).toEqual(expected);
  });

  it('records split-list or wrap-array', () => {
    expect(normalizeValue('a, b', strings, ctx)).toMatchObject({ steps: ['split-list'] });
    expect(normalizeValue('a', strings, ctx)).toMatchObject({ steps: ['wrap-array'] });
    expect(normalizeValue(5, numbers, ctx)).toMatchObject({ value: [5], steps: ['wrap-array'] });
  });

  it('does not split numbers on thousands separators', () => {
    expect(value('1,299, 2,499', numbers)).toEqual([1299, 2499]);
    expect(value('10,20,30', numbers)).toEqual([10, 20, 30]);
    expect(value('1,234,567', numbers)).toEqual([1234567]);
    expect(value('1,5, 2,5', numbers, { ...ctx, decimalSeparator: ',' })).toEqual([1.5, 2.5]);
  });

  it('rejects strings for arrays of objects and non-array values', () => {
    expect(failure('a, b', spec('array', { itemType: 'object' }))).toBe('type_mismatch');
    expect(failure({ a: 1 }, strings)).toBe('type_mismatch');
  });

  it('splits strings for untyped arrays', () => {
    expect(value('a, b', spec('array'))).toEqual(['a', 'b']);
  });

  it('uses the item schema for enum matching', () => {
    const field = spec('array', { itemType: 'string', schema: { type: 'array', items: { enum: ['Red', 'Blue'] } } as JsonSchema });
    expect(value('red, blue', field)).toEqual(['Red', 'Blue']);
  });

  it('passes nested arrays through', () => {
    expect(value([[1, 2], [3]], spec('array', { itemType: 'array' }))).toEqual([[1, 2], [3]]);
  });
});

describe('objects and unknown types', () => {
  it('pass through unchanged', () => {
    const raw = { a: ' x ' };
    expect(normalizeValue(raw, spec('object'), ctx)).toEqual({ ok: true, value: raw, steps: [] });
    expect(normalizeValue('  text ', spec('unknown'), ctx)).toEqual({ ok: true, value: '  text ', steps: [] });
    expect(normalizeValue(5, spec('unknown'), ctx)).toEqual({ ok: true, value: 5, steps: [] });
  });
});
