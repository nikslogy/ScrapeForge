import { describe, expect, it } from 'vitest';
import { loadFixtures } from '../fixtures/extraction/load.js';
import {
  aggregate,
  formatSummary,
  isAbsent,
  isoInstant,
  MAX_MISMATCHES,
  matchRecords,
  normalizeText,
  normalizeUrl,
  numbersEqual,
  scalarKey,
  schemaFields,
  scoreExtraction,
  stringsEqual,
  valuesEqual,
  type ScorableFixture,
} from './scoring.js';

const product: ScorableFixture = {
  id: 'product',
  expectedShape: 'object',
  schema: { title: 'string', price: 'number', rating: 'number', inStock: 'boolean', tags: 'string[]', brand: 'string' },
  gold: { title: 'Sharp Objects', price: 47.82, rating: 4, inStock: true, tags: ['mystery', 'thriller'], brand: null },
};

const listing: ScorableFixture = {
  id: 'listing',
  expectedShape: 'array',
  recordKey: 'title',
  schema: { books: [{ title: 'string', price: 'number', url: 'url' }] },
  gold: [
    { title: 'Sharp Objects', price: 47.82, url: 'https://books.toscrape.com/catalogue/sharp-objects_997/index.html' },
    { title: 'Soumission', price: 50.1, url: 'https://books.toscrape.com/catalogue/soumission_998/index.html' },
    { title: 'The Widow', price: 27.26, url: null },
  ],
};

function goldOf(f: ScorableFixture): Array<Record<string, unknown>> {
  return structuredClone(f.gold) as Array<Record<string, unknown>>;
}

describe('normalizeText', () => {
  it('folds case, whitespace, quotes, dashes and invisible characters', () => {
    expect(normalizeText('  Shakespeare’s  Sonnets\n')).toBe("shakespeare's sonnets");
    expect(normalizeText('“Quoted” — text')).toBe("'quoted' - text");
    expect(normalizeText('soft­hyphen and zero​width')).toBe('softhyphen and zerowidth');
    expect(normalizeText('ＦＵＬＬＷＩＤＴＨ')).toBe('fullwidth');
    expect(normalizeText('')).toBe('');
  });
});

describe('stringsEqual', () => {
  it('matches after normalization but never on a substring', () => {
    expect(stringsEqual('In stock', '  in   STOCK ')).toBe(true);
    expect(stringsEqual("Shakespeare's Sonnets", 'Shakespeare’s Sonnets')).toBe(true);
    expect(stringsEqual('In stock', 'In stock (22 available)')).toBe(false);
    expect(stringsEqual('Pro', 'Product')).toBe(false);
    expect(stringsEqual('16GB', '16 GB')).toBe(false);
  });

  it('compares absolute URLs after normalization', () => {
    const gold = 'https://books.toscrape.com/catalogue/sharp-objects_997/index.html';
    expect(stringsEqual(gold, 'https://BOOKS.toscrape.com:443/catalogue/sharp-objects_997/index.html#reviews')).toBe(true);
    expect(stringsEqual('https://a.example/p/x/', 'https://a.example/p/x')).toBe(true);
    expect(stringsEqual('https://a.example/p?b=2&a=1', 'https://a.example/p?a=1&b=2')).toBe(true);
    expect(stringsEqual('https://a.example/%7Euser/a%2fb', 'https://a.example/~user/a%2Fb')).toBe(true);
    // Relative output, other scheme, other path: wrong.
    expect(stringsEqual(gold, '../../../sharp-objects_997/index.html')).toBe(false);
    expect(stringsEqual(gold, 'http://books.toscrape.com/catalogue/sharp-objects_997/index.html')).toBe(false);
    expect(stringsEqual(gold, 'https://books.toscrape.com/catalogue/sharp-objects_998/index.html')).toBe(false);
    expect(stringsEqual(gold, 'not a url')).toBe(false);
  });

  it('compares ISO date-times with an offset as instants', () => {
    const gold = '2026-09-14T06:30:00-04:00';
    expect(stringsEqual(gold, '2026-09-14T10:30:00Z')).toBe(true);
    expect(stringsEqual(gold, '2026-09-14T10:30:00.000+0000')).toBe(true);
    expect(stringsEqual(gold, '2026-09-14 10:30Z')).toBe(true);
    expect(stringsEqual(gold, '2026-09-14T10:31:00Z')).toBe(false);
    // No offset: the instant is ambiguous, so only an exact text match counts.
    expect(stringsEqual(gold, '2026-09-14T06:30:00')).toBe(false);
    expect(stringsEqual('2026-09-14', '2026-09-14T00:00:00Z')).toBe(false);
    expect(stringsEqual('2026-09-14', '2026-09-14')).toBe(true);
  });
});

describe('normalizeUrl / isoInstant', () => {
  it('returns null for relative or unparseable URLs', () => {
    expect(normalizeUrl('/catalogue/x.html')).toBeNull();
    expect(normalizeUrl('https://')).toBeNull();
    expect(normalizeUrl('https://a.example')).toBe('https://a.example/');
    expect(normalizeUrl('https://user:pw@a.example/x')).toBe('https://a.example/x');
  });

  it('parses only full date-times with an offset', () => {
    expect(isoInstant('2026-09-14T10:30:00Z')).toBe(Date.UTC(2026, 8, 14, 10, 30));
    expect(isoInstant('2026-09-14T10:30:00.123456789+00:00')).toBe(Date.UTC(2026, 8, 14, 10, 30, 0, 123));
    expect(isoInstant('2026-09-14')).toBeNull();
    expect(isoInstant('2026-13-45T99:99:00Z')).toBeNull();
    expect(isoInstant('Sept. 14, 2026')).toBeNull();
  });
});

describe('numbersEqual', () => {
  it('is exact for integer gold and within 0.5% otherwise', () => {
    expect(numbersEqual(1299, 1299)).toBe(true);
    expect(numbersEqual(1299, 1299.01)).toBe(false);
    expect(numbersEqual(0, 0)).toBe(true);
    expect(numbersEqual(0, -0)).toBe(true);
    expect(numbersEqual(1099.99, 1100)).toBe(true);
    expect(numbersEqual(51.77, 52.02)).toBe(true); // 0.48 %
    expect(numbersEqual(51.77, 52.1)).toBe(false); // 0.64 %
    expect(numbersEqual(-1.5, -1.505)).toBe(true);
    expect(numbersEqual(1.5, Number.NaN)).toBe(false);
    expect(numbersEqual(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(false);
    expect(numbersEqual(51.77, 52.1, 0.01)).toBe(true);
  });
});

describe('valuesEqual', () => {
  it('requires the gold JSON type', () => {
    expect(valuesEqual(51.77, '51.77')).toBe(false);
    expect(valuesEqual(51.77, '£51.77')).toBe(false);
    expect(valuesEqual('2024', 2024)).toBe(false);
    expect(valuesEqual(true, 'true')).toBe(false);
    expect(valuesEqual(true, 1)).toBe(false);
    expect(valuesEqual(false, false)).toBe(true);
    expect(valuesEqual(['a'], 'a')).toBe(false);
  });

  it('treats null, undefined, blank strings and empty arrays as the same absence', () => {
    for (const absent of [null, undefined, '', '   ', [], [null, '']]) {
      expect(isAbsent(absent)).toBe(true);
      expect(valuesEqual(null, absent)).toBe(true);
    }
    expect(isAbsent(0)).toBe(false);
    expect(isAbsent([[]])).toBe(false);
    expect(isAbsent(false)).toBe(false);
    expect(valuesEqual(null, 0)).toBe(false);
    expect(valuesEqual(0, null)).toBe(false);
  });

  it('compares scalar arrays as unordered sets', () => {
    const authors = ['Maya Okafor', 'Daniel Reyes'];
    expect(valuesEqual(authors, ['daniel reyes', 'Maya  Okafor'])).toBe(true);
    expect(valuesEqual(authors, ['Maya Okafor', 'Daniel Reyes', 'Maya Okafor'])).toBe(true);
    expect(valuesEqual(authors, ['Maya Okafor'])).toBe(false);
    expect(valuesEqual(authors, ['Maya Okafor', 'Daniel Reyes', 'Priya Nair'])).toBe(false);
    expect(valuesEqual(['https://a.example/1.jpg'], ['https://A.example/1.jpg#x'])).toBe(true);
    expect(valuesEqual(['https://a.example/1.jpg'], ['/1.jpg'])).toBe(false);
    expect(valuesEqual([1.5, 2.25], [2.251, 1.5])).toBe(true);
    expect(valuesEqual([1, 2], ['1', '2'])).toBe(false);
  });

  it('survives deeply nested and cyclic output without recursing into it', () => {
    const cyclic: unknown[] = ['x'];
    cyclic.push(cyclic);
    expect(isAbsent(cyclic)).toBe(false);
    expect(valuesEqual(['x'], cyclic)).toBe(false);
    expect(valuesEqual({ a: 1 }, { a: cyclic })).toBe(false);
    let deep: unknown = 'x';
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(valuesEqual(['x'], deep)).toBe(false);
    expect(scoreExtraction(product, { title: deep, price: cyclic }).counts.correct).toBe(0);
  });

  it('compares objects by the gold keys and arrays of objects as multisets', () => {
    expect(valuesEqual({ amount: 5, currency: 'USD' }, { currency: 'usd', amount: 5, extra: 1 })).toBe(true);
    expect(valuesEqual({ amount: 5, currency: 'USD' }, { amount: 5 })).toBe(false);
    expect(valuesEqual([{ a: 1 }, { a: 2 }], [{ a: 2 }, { a: 1 }])).toBe(true);
    expect(valuesEqual([{ a: 1 }, { a: 1 }], [{ a: 1 }, { a: 2 }])).toBe(false);
    expect(valuesEqual({ a: 1 }, [{ a: 1 }])).toBe(false);
  });
});

describe('scalarKey', () => {
  it('keeps types apart and normalizes text, URLs and instants', () => {
    expect(scalarKey('1')).not.toBe(scalarKey(1));
    expect(scalarKey('  Sharp  OBJECTS ')).toBe(scalarKey('Sharp Objects'));
    expect(scalarKey('https://a.example/x/')).toBe(scalarKey('https://A.EXAMPLE/x#top'));
    expect(scalarKey('2026-09-14T06:30:00-04:00')).toBe(scalarKey('2026-09-14T10:30:00Z'));
    expect(scalarKey(null)).toBeNull();
    expect(scalarKey('')).toBeNull();
    expect(scalarKey({ a: 1 })).toBeNull();
    expect(scalarKey(Number.NaN)).toBeNull();
  });
});

describe('schemaFields', () => {
  it('reads shorthand, JSON Schema, wrappers and derived flags', () => {
    expect(schemaFields({ title: 'string', price: 'number' })).toEqual({ names: ['title', 'price'], derived: [] });
    expect(schemaFields({ books: [{ title: 'string', url: 'url' }] }).names).toEqual(['title', 'url']);
    expect(schemaFields({ tags: ['string'] }).names).toEqual(['tags']);
    expect(schemaFields({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } }).names).toEqual(['a', 'b']);
    expect(schemaFields({ type: 'array', items: { type: 'object', properties: { plan: { type: 'string' } } } }).names).toEqual(['plan']);
    expect(
      schemaFields({ type: 'object', properties: { phones: { type: 'array', items: { type: 'object', properties: { model: {} } } } } }).names,
    ).toEqual(['model']);
    expect(schemaFields({ headline: 'string', summary: { type: 'string', 'x-derived': true } })).toEqual({
      names: ['headline', 'summary'],
      derived: ['summary'],
    });
    expect(schemaFields({ properties: { s: { type: 'string', 'x-derived': true } } }).derived).toEqual(['s']);
  });
});

describe('scoreExtraction: single records', () => {
  it('scores a perfect answer as 1/1 with correct nulls counted separately', () => {
    const s = scoreExtraction(product, { ...(product.gold as object) });
    expect(s.valuePrecision).toBe(1);
    expect(s.valueRecall).toBe(1);
    expect(s.correctNulls).toBe(1);
    expect(s.counts).toMatchObject({ correct: 5, returned: 5, expected: 5 });
    expect(s.recordPrecision).toBeUndefined();
    expect(s.mismatches).toEqual([]);
  });

  it('counts a wrong value against both precision and recall', () => {
    const s = scoreExtraction(product, { ...(product.gold as object), price: 0.01 });
    expect(s.valuePrecision).toBeCloseTo(4 / 5);
    expect(s.valueRecall).toBeCloseTo(4 / 5);
    expect(s.fieldScores.price).toEqual({ correct: 0, returned: 1, expected: 1 });
    expect(s.mismatches).toEqual([{ path: '/price', expected: 47.82, got: 0.01, reason: 'wrong' }]);
  });

  it('counts a missing value against recall only', () => {
    const s = scoreExtraction(product, { ...(product.gold as object), price: null, tags: [] });
    expect(s.valuePrecision).toBe(1);
    expect(s.valueRecall).toBeCloseTo(3 / 5);
    expect(s.mismatches.map((m) => [m.path, m.reason])).toEqual([
      ['/price', 'missing'],
      ['/tags', 'missing'],
    ]);
  });

  it('counts a value where gold is null as a hallucination', () => {
    const s = scoreExtraction(product, { ...(product.gold as object), brand: 'Penguin' });
    expect(s.hallucinatedNulls).toBe(1);
    expect(s.valuePrecision).toBeCloseTo(5 / 6);
    expect(s.valueRecall).toBe(1);
    expect(s.correctNulls).toBe(0);
    expect(s.mismatches).toEqual([{ path: '/brand', expected: null, got: 'Penguin', reason: 'hallucinated' }]);
  });

  it('flags type errors separately from wrong values', () => {
    const s = scoreExtraction(product, { ...(product.gold as object), price: '£47.82', inStock: 'yes' });
    expect(s.mismatches.map((m) => m.reason)).toEqual(['type', 'type']);
    expect(s.valuePrecision).toBeCloseTo(3 / 5);
  });

  it('keeps a present falsy value (0, false) distinct from absence', () => {
    const f: ScorableFixture = { id: 'falsy', expectedShape: 'object', schema: { reviews: 'integer', ok: 'boolean' }, gold: { reviews: 0, ok: false } };
    expect(scoreExtraction(f, { reviews: 0, ok: false }).valueRecall).toBe(1);
    const missing = scoreExtraction(f, { reviews: null });
    expect(missing.valueRecall).toBe(0);
    expect(missing.counts.expected).toBe(2);
  });

  it('skips derived fields from the schema and from options', () => {
    const f: ScorableFixture = {
      id: 'article',
      expectedShape: 'object',
      schema: { headline: 'string', summary: { type: 'string', 'x-derived': true }, mood: 'string' },
      gold: { headline: 'Seawall approved', summary: null, mood: null },
    };
    const s = scoreExtraction(f, { headline: 'Seawall approved', summary: 'The council approved it.', mood: 'hopeful' }, { derivedFields: ['mood'] });
    expect(s.skippedFields.sort()).toEqual(['mood', 'summary']);
    expect(s.hallucinatedNulls).toBe(0);
    expect(s.valuePrecision).toBe(1);
    expect(Object.keys(s.fieldScores)).toEqual(['headline']);
  });

  it('ignores output keys outside the schema and never reads inherited properties', () => {
    const output = JSON.parse('{"title":"Sharp Objects","price":47.82,"rating":4,"inStock":true,"tags":["thriller","mystery"],"__proto__":{"brand":"X"},"extra":1}');
    const s = scoreExtraction(product, output);
    expect(s.valuePrecision).toBe(1);
    expect(s.hallucinatedNulls).toBe(0);

    // JSON.parse creates an own "__proto__" key (an object literal would set the prototype instead).
    const schema = JSON.parse('{"constructor": "string", "__proto__": "string"}') as Record<string, unknown>;
    const f: ScorableFixture = { id: 'proto', expectedShape: 'object', schema, gold: null };
    const proto = scoreExtraction(f, {});
    expect(Object.keys(proto.fieldScores).sort()).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(proto.fieldScores)).toBe(Object.prototype);
    expect(proto.counts.returned).toBe(0);
  });

  it('handles null, primitive and array outputs for an object fixture', () => {
    const none = scoreExtraction(product, null);
    expect([none.valuePrecision, none.valueRecall, none.shapeOk]).toEqual([1, 0, true]);

    const prim = scoreExtraction(product, 'oops');
    expect(prim.shapeOk).toBe(false);
    expect(prim.valueRecall).toBe(0);
    expect(prim.mismatches[0].reason).toBe('shape');

    // 'auto' shape may legitimately wrap a single record in an array: values count, the shape is flagged.
    const single = scoreExtraction(product, [{ ...(product.gold as object) }]);
    expect(single.shapeOk).toBe(false);
    expect(single.valueRecall).toBe(1);

    // Several records for a single-item page (e.g. decoys included): nothing matches, every value is returned.
    const many = scoreExtraction(product, [{ ...(product.gold as object) }, { title: 'Decoy', price: 9.99 }]);
    expect(many.shapeOk).toBe(false);
    expect(many.valueRecall).toBe(0);
    expect(many.valuePrecision).toBe(0);
    expect(many.counts.returned).toBe(7);
  });

  it('treats any data on a nothing-to-extract page as hallucinated', () => {
    const blocked: ScorableFixture = { id: 'blocked', expectedShape: 'object', schema: { title: 'string', price: 'number' }, gold: null };
    expect(scoreExtraction(blocked, null)).toMatchObject({ valuePrecision: 1, valueRecall: 1, hallucinatedNulls: 0 });
    const s = scoreExtraction(blocked, { title: 'Just a moment...', price: null });
    expect(s.hallucinatedNulls).toBe(1);
    expect(s.valuePrecision).toBe(0);
    expect(s.valueRecall).toBe(1);
    expect(s.mismatches[0].reason).toBe('extra-record');
  });
});

describe('scoreExtraction: record lists', () => {
  it('matches records by normalized key, in any order, inside a wrapper', () => {
    const out = goldOf(listing).reverse();
    out[0].title = '  the WIDOW ';
    const s = scoreExtraction(listing, { books: out });
    expect(s.shapeOk).toBe(true);
    expect(s.recordPrecision).toBe(1);
    expect(s.recordRecall).toBe(1);
    expect(s.valuePrecision).toBe(1);
    expect(s.counts).toMatchObject({ recordsExpected: 3, recordsReturned: 3, recordsMatched: 3 });
  });

  it('accepts an envelope object holding exactly one array', () => {
    expect(scoreExtraction(listing, { records: goldOf(listing), total: 3 }).shapeOk).toBe(true);
    // A lone record whose only array is one of its own fields is not a wrapper.
    const gallery: ScorableFixture = {
      id: 'gallery',
      expectedShape: 'array',
      recordKey: 'name',
      schema: { items: [{ name: 'string', images: 'url[]' }] },
      gold: [{ name: 'Mug', images: ['https://a.example/1.jpg'] }],
    };
    const lone = scoreExtraction(gallery, { name: 'Mug', images: ['https://a.example/1.jpg'] });
    expect(lone.shapeOk).toBe(false);
    expect(lone.recordRecall).toBe(1);
    expect(lone.valuePrecision).toBe(1);
    const two = scoreExtraction(listing, { a: goldOf(listing), b: [] });
    expect(two.shapeOk).toBe(false);
    expect(two.recordRecall).toBe(0);
  });

  it('penalizes a missing record in recall and an extra decoy record in precision', () => {
    const out = goldOf(listing).slice(0, 2);
    out.push({ title: 'Tipping the Velvet', price: 53.74, url: 'https://books.toscrape.com/catalogue/tipping-the-velvet_999/index.html' });
    const s = scoreExtraction(listing, out);
    expect(s.recordPrecision).toBeCloseTo(2 / 3);
    expect(s.recordRecall).toBeCloseTo(2 / 3);
    // Two matched records x 3 values; "The Widow" had 2 present values (url is null); the decoy returned 3.
    expect(s.counts).toMatchObject({ correct: 6, returned: 9, expected: 8 });
    expect(s.hallucinatedNulls).toBe(0);
    expect(s.mismatches.map((m) => [m.path, m.reason])).toEqual([
      ['/2', 'missing-record'],
      ['output:/2', 'extra-record'],
    ]);
    expect(s.mismatches[0].expected).toBe('The Widow');
    expect(s.mismatches[1].got).toBe('Tipping the Velvet');
  });

  it('reports field mismatches with the gold record index', () => {
    const out = goldOf(listing);
    out[1].price = 5;
    out[0].url = '../../../sharp-objects_997/index.html';
    const s = scoreExtraction(listing, out);
    expect(s.mismatches.map((m) => [m.path, m.reason])).toEqual([
      ['/0/url', 'wrong'],
      ['/1/price', 'wrong'],
    ]);
    expect(s.fieldScores.url).toEqual({ correct: 1, returned: 2, expected: 2 });
  });

  it('pairs duplicate keys by multiplicity, best-agreeing pairs first', () => {
    const f: ScorableFixture = {
      id: 'dupes',
      expectedShape: 'array',
      recordKey: 'name',
      schema: { items: [{ name: 'string', price: 'number' }] },
      gold: [
        { name: 'Mug', price: 5 },
        { name: 'Mug', price: 6 },
      ],
    };
    expect(scoreExtraction(f, [{ name: 'mug', price: 6 }, { name: 'MUG', price: 5 }]).valuePrecision).toBe(1);
    const one = scoreExtraction(f, [{ name: 'Mug', price: 6 }]);
    expect(one.recordRecall).toBe(0.5);
    expect(one.valuePrecision).toBe(1);
    const triple = scoreExtraction(f, [{ name: 'Mug', price: 5 }, { name: 'Mug', price: 6 }, { name: 'Mug', price: 6 }]);
    expect(triple.recordPrecision).toBeCloseTo(2 / 3);
    expect(triple.recordRecall).toBe(1);
  });

  it('never matches output records without a usable key', () => {
    const out: unknown[] = [{ price: 47.82 }, null, 'Sharp Objects', { title: '', price: 50.1 }, ...goldOf(listing)];
    const s = scoreExtraction(listing, out);
    expect(s.counts.recordsReturned).toBe(7);
    expect(s.counts.recordsMatched).toBe(3);
    expect(s.recordPrecision).toBeCloseTo(3 / 7);
    expect(s.counts.returned).toBe(10);
  });

  it('requires a recordKey for list fixtures', () => {
    expect(() => scoreExtraction({ ...listing, recordKey: undefined }, [])).toThrow(/recordKey/);
  });

  it('rejects gold of the wrong shape loudly', () => {
    expect(() => scoreExtraction({ ...listing, gold: { title: 'x' } }, [])).toThrow(/array gold/);
    expect(() => scoreExtraction({ ...product, gold: [] }, {})).toThrow(/object gold/);
  });
});

describe('matchRecords', () => {
  it('returns matched pairs and leftovers on both sides', () => {
    const gold = [{ k: 'a' }, { k: 'b' }, { k: 'c' }];
    const out = [{ k: 'C' }, { k: 'x' }, { k: 'a' }];
    expect(matchRecords(gold, out, 'k')).toEqual({ matched: [[0, 2], [2, 0]], unmatchedGold: [1], unmatchedOutput: [1] });
  });
});

describe('scoreExtraction at scale', () => {
  const [large] = loadFixtures({ ids: ['large-listing'] });
  const gold = large.gold as Array<Record<string, unknown>>;

  it('scores 600 shuffled records quickly and exactly', () => {
    const shuffled = [...gold].reverse().map((r) => ({ ...r, sku: ` ${String(r.sku).toLowerCase()} ` }));
    const t0 = performance.now();
    const s = scoreExtraction(large, { products: shuffled });
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(s.valuePrecision).toBe(1);
    expect(s.recordRecall).toBe(1);
  });

  it('scores a Phase-1 style truncated answer honestly', () => {
    const s = scoreExtraction(large, gold.slice(0, 150));
    expect(s.recordPrecision).toBe(1);
    expect(s.recordRecall).toBe(0.25);
    expect(s.valuePrecision).toBe(1);
    expect(s.valueRecall).toBeLessThan(0.3);
    expect(s.mismatches.filter((m) => m.reason === 'missing-record')).toHaveLength(450);
  });

  it('stays bounded on adversarial output (huge duplicate-key groups, mismatch flood)', () => {
    const flood = Array.from({ length: 20_000 }, (_, i) => ({ sku: gold[0].sku, name: `x${i}`, price: i, rating: null }));
    const t0 = performance.now();
    const s = scoreExtraction(large, flood);
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(s.counts.recordsMatched).toBe(1);
    expect(s.mismatches).toHaveLength(MAX_MISMATCHES);
    // 599 missing gold records, 19,999 extra outputs, and name/price/rating wrong on the one matched pair.
    expect(s.mismatches.length + s.mismatchesOmitted).toBe(599 + 19_999 + 3);
  });

  it('caps oversized values in mismatch reports', () => {
    const s = scoreExtraction(product, { ...(product.gold as object), title: 'x'.repeat(10_000) });
    expect(String(s.mismatches[0].got).length).toBeLessThanOrEqual(201);
  });
});

describe('aggregate', () => {
  it('reports micro and macro averages, record totals and pooled fields', () => {
    const perfect = scoreExtraction(product, { ...(product.gold as object) });
    const half = scoreExtraction(listing, goldOf(listing).slice(0, 1));
    const summary = aggregate([perfect, half]);
    expect(summary.fixtures).toBe(2);
    // Values: product 5/5; listing returned one record (3 values) of 8 present gold values.
    expect(summary.counts).toEqual({ correct: 8, returned: 8, expected: 13 });
    expect(summary.micro.valuePrecision).toBe(1);
    expect(summary.micro.valueRecall).toBeCloseTo(8 / 13);
    expect(summary.macro.valueRecall).toBeCloseTo((1 + 3 / 8) / 2);
    expect(summary.micro.f1).toBeCloseTo(16 / 21);
    expect(summary.records).toEqual({ precision: 1, recall: 1 / 3, fixtures: 1 });
    expect(summary.byField.price).toMatchObject({ correct: 2, returned: 2, expected: 4, precision: 1, recall: 0.5 });
    expect(summary.rows.map((r) => r.id)).toEqual(['product', 'listing']);
    expect(summary.rows[1].recordRecall).toBeCloseTo(1 / 3);
    expect(summary.shapeErrors).toBe(0);
  });

  it('never reports a passing score for an empty run', () => {
    const summary = aggregate([]);
    expect(summary.micro).toEqual({ valuePrecision: 0, valueRecall: 0, f1: 0 });
    expect(summary.macro).toEqual({ valuePrecision: 0, valueRecall: 0, f1: 0 });
    expect(summary.records).toBeUndefined();
  });

  it('formats a readable table', () => {
    const table = formatSummary(aggregate([scoreExtraction(product, null), scoreExtraction(listing, 'bad')]));
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/^fixture\s+value P\s+value R/);
    expect(lines.find((l) => l.startsWith('listing'))).toMatch(/WRONG$/);
    expect(lines.find((l) => l.startsWith('product'))).toMatch(/100\.0%\s+0\.0%/);
    expect(lines.some((l) => l.startsWith('micro (2)'))).toBe(true);
  });
});

describe('scoring the real corpus', () => {
  const fixtures = loadFixtures();

  it('penalizes the listing decoys when they leak into books-listing', () => {
    const [f] = loadFixtures({ ids: ['books-listing'] });
    const decoys = [
      { title: 'Tipping the Velvet', price: 53.74, rating: 1, inStock: true, url: 'https://books.toscrape.com/catalogue/tipping-the-velvet_999/index.html' },
      { title: 'Soumission', price: 50.1, rating: 1, inStock: true, url: 'https://books.toscrape.com/catalogue/soumission_998/index.html' },
    ];
    const s = scoreExtraction(f, { books: [...(f.gold as object[]), ...decoys] });
    expect(s.recordPrecision).toBeCloseTo(20 / 22);
    expect(s.recordRecall).toBe(1);
    expect(s.valuePrecision).toBeCloseTo(100 / 110);
  });

  it('gives an all-null answer zero recall and no hallucinations on every fixture', () => {
    for (const f of fixtures) {
      const s = scoreExtraction(f, null);
      expect(s.hallucinatedNulls, f.id).toBe(0);
      expect(s.valuePrecision, f.id).toBe(1);
      expect(s.valueRecall, f.id).toBe(f.gold === null ? 1 : 0);
    }
  });
});
