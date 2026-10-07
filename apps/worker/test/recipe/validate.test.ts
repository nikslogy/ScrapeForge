import { describe, expect, it } from 'vitest';
import { checkSelector } from '../../src/extract/recipe/selector.js';
import { isValidatedRecipe, validateRecipe } from '../../src/extract/recipe/validate.js';

const listing = {
  version: 1,
  shape: 'array',
  recordSelector: 'article.product_pod',
  fields: {
    title: { selector: 'h3 a', attr: 'title' },
    price: { selector: 'p.price_color', transforms: ['strip-currency', 'parse-number'] },
    rating: { selector: 'p.star-rating', attr: 'class', transforms: [{ regex: 'star-rating\\s+(\\S+)', group: 1 }, { map: { One: 1, Two: 2, Three: 3 } }] },
    url: { selector: 'h3 a', attr: 'href', transforms: ['absolute-url'] },
    images: { selector: 'img', attr: 'src', all: true },
    brand: { structured: { type: 'Product', pointer: '/brand/name' } },
  },
};

function errorsOf(input: unknown, fieldNames?: string[]): string[] {
  const r = validateRecipe(input, fieldNames);
  return r.ok ? [] : r.errors;
}

describe('validateRecipe', () => {
  it('accepts a well-formed listing recipe and returns a frozen copy', () => {
    const r = validateRecipe(listing, ['title', 'price', 'rating', 'url', 'images', 'brand']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe).toEqual(listing);
    expect(r.recipe).not.toBe(listing);
    expect(Object.isFrozen(r.recipe)).toBe(true);
    expect(Object.isFrozen(r.recipe.fields.rating.transforms)).toBe(true);
    expect(isValidatedRecipe(r.recipe)).toBe(true);
    expect(isValidatedRecipe(listing)).toBe(false);
  });

  it('accepts an object recipe with a scope selector and self/empty selectors', () => {
    const r = validateRecipe({ version: 1, shape: 'object', scopeSelector: 'div.product_main', fields: { name: { selector: 'h1' }, all: { selector: '   ' } } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recipe.fields.all.selector).toBe('');
  });

  it('requires version 1, a known shape and a record selector for arrays', () => {
    expect(errorsOf({ ...listing, version: 2 })).toContain('version: must be 1');
    expect(errorsOf({ ...listing, shape: 'table' }).join()).toMatch(/shape/);
    const { recordSelector: _omit, ...noRecords } = listing;
    expect(errorsOf(noRecords)).toContain('recordSelector: is required for shape "array"');
    expect(errorsOf({ version: 1, shape: 'object', recordSelector: 'li', fields: { a: {} } }).join()).toMatch(/only allowed for shape "array"/);
    expect(errorsOf({ ...listing, scopeSelector: 'main' }).join()).toMatch(/only allowed for shape "object"/);
  });

  it('rejects non-objects and unknown keys anywhere', () => {
    expect(errorsOf(null)).toEqual(['recipe: must be a JSON object']);
    expect(errorsOf([listing])).toEqual(['recipe: must be a JSON object']);
    expect(errorsOf('{"version":1}')).toEqual(['recipe: must be a JSON object']);
    expect(errorsOf({ ...listing, code: 'return $("h1").text()' }).join()).toMatch(/unknown key "code"/);
    expect(errorsOf({ ...listing, fields: { title: { selector: 'h1', script: 'x' } } }).join()).toMatch(/unknown key "script"/);
    expect(errorsOf({ ...listing, fields: { a: { structured: { pointer: '/a', eval: 1 } } } }).join()).toMatch(/unknown key "eval"/);
    expect(errorsOf({ ...listing, fields: { a: { transforms: [{ regex: 'a', flags: 'g' }] } } }).join()).toMatch(/unknown key "flags"/);
    expect(errorsOf({ ...listing, fields: { a: { transforms: [{ map: { a: 1 }, regex: 'x' }] } } }).join()).toMatch(/unknown key "map"/);
  });

  it('rejects code-like strings: they are neither selectors nor transforms', () => {
    const codeLike = [
      { selector: '$("h1").text()' },
      { selector: 'javascript:alert(1)' },
      { selector: 'h1; process.exit()' },
      { selector: '() => document.title' },
      { transforms: ['eval'] },
      { transforms: ['function(x){return x}'] },
      { transforms: [{ fn: 'x => x' }] },
      { attr: 'onclick="alert(1)"' },
      { structured: { pointer: 'constructor.constructor("return process")()' } },
    ];
    for (const field of codeLike) {
      expect(validateRecipe({ version: 1, shape: 'object', fields: { a: field } }).ok, JSON.stringify(field)).toBe(false);
    }
  });

  it('rejects class instances, functions and getters that throw', () => {
    class Fake {
      version = 1;
      shape = 'object';
      fields = { a: {} };
    }
    expect(validateRecipe(new Fake()).ok).toBe(false);
    expect(validateRecipe({ version: 1, shape: 'object', fields: { a: { selector: () => 'h1' } } }).ok).toBe(false);
    const hostile = { version: 1, shape: 'object', get fields(): unknown { throw new Error('boom'); } };
    const r = validateRecipe(hostile);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/could not be read: boom/);
  });

  it('rejects prototype-pollution field names', () => {
    for (const name of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) {
      const parsed = JSON.parse(`{"version":1,"shape":"object","fields":{${JSON.stringify(name)}:{"selector":"h1"}}}`);
      expect(errorsOf(parsed).join(), name).toMatch(/reserved name/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps "__proto__" map keys as data without touching prototypes', () => {
    const parsed = JSON.parse('{"version":1,"shape":"object","fields":{"a":{"transforms":[{"map":{"__proto__":{"polluted":1},"x":1}}]}}}');
    expect(errorsOf(parsed).join()).toMatch(/must be a string/);
    const ok = validateRecipe(JSON.parse('{"version":1,"shape":"object","fields":{"a":{"transforms":[{"map":{"__proto__":"p","x":1}}]}}}'));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const map = (ok.recipe.fields.a.transforms?.[0] as { map: Record<string, unknown> }).map;
      expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(map, '__proto__')).toBe(true);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('restricts field names to the schema when given', () => {
    expect(errorsOf(listing, ['title']).join()).toMatch(/fields\["price"\]: is not a field of the schema/);
    expect(errorsOf({ version: 1, shape: 'object', fields: {} })).toContain('fields: must define at least one field');
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`f${i}`, {}]));
    expect(errorsOf({ version: 1, shape: 'object', fields: many }).join()).toMatch(/more than 100 fields/);
    expect(errorsOf({ version: 1, shape: 'object', fields: { ['x'.repeat(201)]: {} } }).join()).toMatch(/1-200 chars/);
    expect(errorsOf({ version: 1, shape: 'object', fields: { 'a\nb': {} } }).join()).toMatch(/control characters/);
  });

  it('validates attribute names', () => {
    for (const ok of ['href', 'data-src', 'xlink:href', 'aria-label', '_x', 'data.v']) {
      expect(validateRecipe({ version: 1, shape: 'object', fields: { a: { attr: ok } } }).ok, ok).toBe(true);
    }
    for (const bad of ['', '1abc', 'a b', 'a"b', 'x'.repeat(101), 3]) {
      expect(validateRecipe({ version: 1, shape: 'object', fields: { a: { attr: bad } } }).ok, String(bad)).toBe(false);
    }
  });

  it('validates transforms: allowlist, regex safety, groups, maps and ordering', () => {
    const t = (transforms: unknown): string[] => errorsOf({ version: 1, shape: 'object', fields: { a: { transforms } } });
    expect(t('trim').join()).toMatch(/must be an array/);
    expect(t(['trim', 'collapse-whitespace', 'lowercase', 'uppercase', 'strip-currency', 'absolute-url', 'parse-number'])).toEqual([]);
    expect(t(['shout']).join()).toMatch(/unknown transform "shout"/);
    expect(t(['parse-number', 'trim']).join()).toMatch(/nothing may follow "parse-number"/);
    expect(t(['parse-boolean', { map: { a: 1 } }]).join()).toMatch(/nothing may follow/);
    expect(t([{ map: { 'in stock': true } }, 'parse-boolean'])).toEqual([]);
    expect(t(Array(13).fill('trim')).join()).toMatch(/more than 12 transforms/);
    expect(t([{ regex: '(a+)+' }]).join()).toMatch(/nested quantifier/);
    expect(t([{ regex: '\\s*(.+)$' }]).join()).toMatch(/polynomial/);
    expect(t([{ regex: '[' }]).join()).toMatch(/does not compile/);
    expect(t([{ regex: 'x'.repeat(201) }]).join()).toMatch(/longer than 200/);
    expect(t([{ regex: 5 }]).join()).toMatch(/must be a string/);
    expect(t([{ regex: '(a)', group: 2 }]).join()).toMatch(/only 1 capture group/);
    expect(t([{ regex: '(a)', group: 10 }]).join()).toMatch(/0 to 9/);
    expect(t([{ regex: '(a)', group: 1.5 }]).join()).toMatch(/0 to 9/);
    expect(t([{ regex: 'a', group: 0 }])).toEqual([]);
    expect(t([{ map: {} }]).join()).toMatch(/1-100 entries/);
    expect(t([{ map: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, i])) }]).join()).toMatch(/1-100 entries/);
    expect(t([{ map: { a: [1] } }]).join()).toMatch(/must be a string/);
    expect(t([{ map: { a: { b: 1 } } }]).join()).toMatch(/must be a string/);
    expect(t([{ map: { a: Number.NaN } }]).join()).toMatch(/must be a string/);
    expect(t([{ map: { a: 'x'.repeat(1001) } }]).join()).toMatch(/must be a string/);
    expect(t([{ map: { ['k'.repeat(201)]: 1 } }]).join()).toMatch(/at most 200 chars/);
    expect(t([{ map: { a: null, b: false, c: 2, d: 'x' } }])).toEqual([]);
    expect(t([42]).join()).toMatch(/must be a transform name/);
  });

  it('validates structured reads', () => {
    const s = (structured: unknown): string[] => errorsOf({ version: 1, shape: 'object', fields: { a: { structured } } });
    expect(s({ pointer: '/offers/0/price' })).toEqual([]);
    expect(s({ pointer: '' })).toEqual([]);
    expect(s({ type: 'Product', pointer: '/a~1b/c~0d' })).toEqual([]);
    expect(s({ pointer: 'offers/price' }).join()).toMatch(/JSON pointer/);
    expect(s({ pointer: '/a~2' }).join()).toMatch(/JSON pointer/);
    expect(s({ pointer: `/${'a'.repeat(200)}` }).join()).toMatch(/JSON pointer/);
    expect(s({ pointer: '/a', type: '' }).join()).toMatch(/type name/);
    expect(s({ type: 'Product' }).join()).toMatch(/JSON pointer/);
    expect(s('/a').join()).toMatch(/must be an object/);
  });

  it('caps regex transforms per recipe and validation time on adversarial patterns', () => {
    const fields = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, { transforms: [{ regex: `(a${i})` }] }]));
    expect(errorsOf({ version: 1, shape: 'object', fields }).join()).toMatch(/more than 50 regex transforms/);
    let ranges = '';
    for (let i = 0; ranges.length < 80; i++) ranges += `\\u{${(0x400 + i * 0x200).toString(16)}}-\\u{${(0x5ff + i * 0x200).toString(16)}}`;
    const pattern = `[${ranges}]+[\\p{L}\\p{Sc}\\d${ranges}]+x`;
    expect(pattern.length).toBeLessThanOrEqual(200);
    const hostile = Array.from({ length: 50 }, (_, i) => [`h${i}`, { transforms: [{ regex: pattern }] }]);
    const start = performance.now();
    const r = validateRecipe({ version: 1, shape: 'object', fields: Object.fromEntries(hostile) });
    expect(r.ok).toBe(false);
    expect(performance.now() - start).toBeLessThan(3_000);
  });

  it('caps the number of reported errors', () => {
    const fields = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`f${i}`, { selector: ':contains(x)' }]));
    const errors = errorsOf({ version: 1, shape: 'object', fields });
    expect(errors.length).toBe(51);
    expect(errors[50]).toMatch(/more errors omitted/);
  });
});

describe('checkSelector', () => {
  const rel = { relative: true };
  const doc = { relative: false };

  it.each([
    'h3 a',
    'p.price_color',
    'div.product_main > h1',
    '#product_description + p',
    'table tr:nth-child(2) > td',
    'li:nth-of-type(2n+1)',
    'a[href^="https"]',
    'a[data-id="x y"]',
    "a[title='it\\'s']",
    'img[alt="x" i]',
    'span[itemprop=price]',
    'div:not(.ad):is(.card, .tile)',
    'li:has(> a.next)',
    'h2 ~ p',
    'ul > li:first-child',
    'p:empty',
    '*',
    'ul li, ol li',
    '.a\\:b',
  ])('accepts %s', (sel) => {
    expect(checkSelector(sel, doc)).toBeNull();
  });

  it('allows leading ">" and "" only for field selectors', () => {
    expect(checkSelector('> h3 > a', rel)).toBeNull();
    expect(checkSelector('', rel)).toBeNull();
    expect(checkSelector('> h3', doc)).toMatch(/may not start with ">"/);
    expect(checkSelector('', doc)).toMatch(/must not be empty/);
    expect(checkSelector('+ div', rel)).toMatch(/may not start with "\+"/);
    expect(checkSelector('~ div', rel)).toMatch(/may not start with "~"/);
  });

  it.each([
    ['p:contains(Price)', /:contains\(\) is not allowed/],
    ['p:icontains(x)', /not allowed/],
    ['li:first', /:first is not allowed/],
    ['li:eq(0)', /:eq\(\) is not allowed/],
    ['li:gt(2)', /not allowed/],
    ['li:even', /not allowed/],
    ['a:hover', /not allowed/],
    ['p:header', /not allowed/],
    ['p::before', /pseudo-elements/],
    ['svg|a', /namespaces/],
    ['div:has(p:has(a))', /inside :has/],
    ['a:not(:not(:not(:not(b))))', /nested too deeply/],
    ['a b c d e f g h i j k l m', /more than 12 compound/],
    ['a, b, c, d, e, f, g, h, i, j, k, l, m', /more than 12 compound/],
    ['a:not(b, c, d, e, f, g, h, i, j, k, l, m)', /more than 12 compound/],
    ['a[href', /not closed/],
    ['a[href!="x"]', /operator/],
    ['li:nth-child(foo)', /argument/],
    ['p,', /expected/],
    ['a > > b', /expected/],
    ['div)', /unexpected/],
    ['h1\u0000', /control/],
    ['x'.repeat(301), /longer than 300/],
  ])('rejects %s', (sel, reason) => {
    expect(checkSelector(sel, doc)).toMatch(reason);
  });

  it('rejects non-strings', () => {
    expect(checkSelector(42, doc)).toMatch(/must be a string/);
  });
});
