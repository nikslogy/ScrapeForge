import { describe, expect, it } from 'vitest';
import { checkInvariants, compareOutputs, isEmptyValue, valuesAgree } from '../../src/extract/recipe/compare.js';
import type { StoredRecipe } from '../../src/extract/types.js';

const FIELDS = ['title', 'price', 'inStock'];

function records(n: number, mutate?: (r: Record<string, unknown>, i: number) => void): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => {
    const r: Record<string, unknown> = { title: `Book ${i}`, price: 10 + i, inStock: i % 2 === 0 };
    mutate?.(r, i);
    return r;
  });
}

describe('valuesAgree', () => {
  it('compares strings ignoring case and whitespace', () => {
    expect(valuesAgree('  A Light  in the\nAttic ', 'a light in the attic')).toBe(true);
    expect(valuesAgree('Ｆｕｌｌｗｉｄｔｈ', 'fullwidth')).toBe(true);
    expect(valuesAgree('A Light', 'A Lamp')).toBe(false);
  });

  it('compares numbers within 0.5% relative', () => {
    expect(valuesAgree(100, 100.4)).toBe(true);
    expect(valuesAgree(100, 100.6)).toBe(false);
    expect(valuesAgree(0, 0)).toBe(true);
    expect(valuesAgree(0, 0.001)).toBe(false);
    expect(valuesAgree(-50, -50.1)).toBe(true);
    expect(valuesAgree(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('compares a number with a printed number and a boolean with a word', () => {
    expect(valuesAgree('£51.77', 51.77)).toBe(true);
    expect(valuesAgree(1299, '1.299,00 €')).toBe(true);
    expect(valuesAgree('Call us', 5)).toBe(false);
    expect(valuesAgree('In stock', true)).toBe(true);
    expect(valuesAgree('Sold out', true)).toBe(false);
    expect(valuesAgree(true, 1)).toBe(false);
  });

  it('treats empty values as equal only to empty values', () => {
    expect(valuesAgree(null, undefined)).toBe(true);
    expect(valuesAgree('', null)).toBe(true);
    expect(valuesAgree([], null)).toBe(true);
    expect(valuesAgree(null, 'x')).toBe(false);
    expect(isEmptyValue({})).toBe(true);
    expect(isEmptyValue([null, ''])).toBe(true);
    expect(isEmptyValue(Number.NaN)).toBe(true);
    expect(isEmptyValue(0)).toBe(false);
    expect(isEmptyValue(false)).toBe(false);
  });

  it('compares arrays element-wise and objects by key', () => {
    expect(valuesAgree(['a', 'B'], ['A', 'b'])).toBe(true);
    expect(valuesAgree(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(valuesAgree({ x: 1, y: 'A' }, { x: 1.001, y: 'a' })).toBe(true);
    expect(valuesAgree({ x: 1 }, { x: 2 })).toBe(false);
  });

  it('stops at hostile nesting depth', () => {
    let a: unknown = 'x';
    let b: unknown = 'x';
    for (let i = 0; i < 1_000; i++) {
      a = [a];
      b = [b];
    }
    expect(valuesAgree(a, b)).toBe(false);
  });
});

describe('compareOutputs', () => {
  it('agrees on identical listings', () => {
    const r = compareOutputs(records(20), records(20), FIELDS);
    expect(r).toEqual({ agree: true, fieldAgreement: 1, recordCountRatio: 1, details: [] });
  });

  it('compares every record', () => {
    const recipe = records(30, (r, i) => {
      if (i >= 20) r.title = 'garbage';
    });
    expect(compareOutputs(recipe, records(30), FIELDS).agree).toBe(false);
  });

  it('a record with values on one side only is a disagreement', () => {
    expect(compareOutputs(records(18), records(20), FIELDS)).toMatchObject({ agree: false, recordCountRatio: 0.9 });
    const r = compareOutputs(records(17), records(20), FIELDS);
    expect(r.agree).toBe(false);
    expect(r.details[0]).toBe('record count 17 vs reference 20');
  });

  it('a shifted record breaks per-position agreement', () => {
    const shifted = records(21).slice(1);
    const r = compareOutputs(shifted, records(20), FIELDS);
    expect(r.agree).toBe(false);
    expect(r.fieldAgreement).toBeLessThan(0.9);
  });

  it('requires every compared value to match', () => {
    // 20 records × 3 fields = 60 comparisons; one disagreement is enough.
    const oneWrong = records(20, (r, i) => {
      if (i === 0) r.title = 'wrong';
    });
    const r = compareOutputs(oneWrong, records(20), FIELDS);
    expect(r).toMatchObject({ agree: false, details: ['/0/title: "wrong" vs "Book 0"'] });
    expect(r.fieldAgreement).toBeCloseTo(59 / 60);
    const closePrice = records(20, (r, i) => {
      if (i === 3) r.price = (r.price as number) * 1.004;
    });
    expect(compareOutputs(closePrice, records(20), FIELDS).agree).toBe(false);
  });

  it('values missing on both sides are not compared; one-sided values disagree', () => {
    const ref = records(10, (r) => {
      r.inStock = null;
    });
    const recipe = records(10, (r) => {
      delete r.inStock;
    });
    expect(compareOutputs(recipe, ref, FIELDS)).toMatchObject({ agree: true, fieldAgreement: 1 });
    const extra = records(10, (r) => {
      r.inStock = 'yes';
    });
    expect(compareOutputs(extra, ref, FIELDS).fieldAgreement).toBeCloseTo(20 / 30);
  });

  it('compares objects and reports shape mismatches', () => {
    expect(compareOutputs({ title: 'X', price: '£5' }, { title: 'x', price: 5 }, ['title', 'price'])).toMatchObject({ agree: true, fieldAgreement: 1 });
    expect(compareOutputs({ title: 'X' }, [{ title: 'X' }], ['title'])).toMatchObject({ agree: false, details: ['shape mismatch: recipe object, reference array'] });
    expect(compareOutputs(null, {}, ['title']).agree).toBe(false);
  });

  it('nothing to compare is not agreement', () => {
    expect(compareOutputs([], [], FIELDS)).toMatchObject({ agree: false, fieldAgreement: 0, recordCountRatio: 1 });
    expect(compareOutputs({ a: null }, { a: null }, ['a'])).toMatchObject({ agree: false, details: ['no non-empty values to compare'] });
    expect(compareOutputs([{ a: 1 }], [], ['a']).recordCountRatio).toBe(Number.POSITIVE_INFINITY);
  });

  it('ignores fields not listed and prototype keys', () => {
    const a = [{ title: 'x', other: 1 }];
    const b = [{ title: 'x', other: 2 }];
    expect(compareOutputs(a, b, ['title', 'constructor', '__proto__']).agree).toBe(true);
  });
});

describe('checkInvariants', () => {
  const stored = (over: Partial<StoredRecipe> = {}): StoredRecipe => ({
    recipe: { version: 1, shape: 'array', recordSelector: 'li', fields: { title: {}, price: {}, inStock: {} } },
    state: 'active',
    createdAt: '2026-10-07T00:00:00Z',
    validatedOn: ['a', 'b', 'c'],
    uses: 0,
    failures: 0,
    requiredFields: ['title', 'price'],
    recordCount: { min: 18, max: 22 },
    ...over,
  });

  it('accepts output that looks like what was validated', () => {
    expect(checkInvariants(stored(), { data: records(20), recordCount: 20 })).toEqual({ ok: true, reasons: [] });
  });

  it('requires each required field in ≥ 90% of records', () => {
    const data = records(20, (r, i) => {
      if (i < 2) r.price = null;
    });
    expect(checkInvariants(stored(), { data, recordCount: 20 }).ok).toBe(true);
    const worse = records(20, (r, i) => {
      if (i < 3) r.price = '';
    });
    expect(checkInvariants(stored(), { data: worse, recordCount: 20 })).toEqual({ ok: false, reasons: ['required field "price" filled in 17 of 20 records'] });
  });

  it('keeps the record count within [0.5 × min, 2 × max]', () => {
    expect(checkInvariants(stored(), { data: records(9), recordCount: 9 }).ok).toBe(true);
    expect(checkInvariants(stored(), { data: records(8), recordCount: 8 }).reasons).toEqual(['record count 8 outside the validated range 18-22']);
    expect(checkInvariants(stored(), { data: records(44), recordCount: 44 }).ok).toBe(true);
    expect(checkInvariants(stored(), { data: records(45), recordCount: 45 }).ok).toBe(false);
    expect(checkInvariants(stored({ recordCount: undefined }), { data: records(500), recordCount: 500 }).ok).toBe(true);
  });

  it('fails on no records or the wrong shape', () => {
    expect(checkInvariants(stored(), { data: [], recordCount: 0 }).reasons).toEqual(['no records extracted']);
    expect(checkInvariants(stored(), { data: { title: 'x' }, recordCount: 1 }).reasons).toEqual(['expected an array of records']);
  });

  it('object recipes need every required field', () => {
    const obj = stored({ recipe: { version: 1, shape: 'object', fields: { title: {}, price: {} } }, recordCount: undefined });
    expect(checkInvariants(obj, { data: { title: 'x', price: 0 }, recordCount: 1 }).ok).toBe(true);
    expect(checkInvariants(obj, { data: { title: 'x', price: '  ' }, recordCount: 1 }).reasons).toEqual(['required field "price" is empty']);
    expect(checkInvariants(obj, { data: [{ title: 'x' }], recordCount: 1 }).reasons).toEqual(['expected an object']);
  });
});
