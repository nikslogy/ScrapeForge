// Number fields that name a unit, and text that says there is no value.
// Both come from the first live benchmark: "512 GB PCIe 4.0 NVMe SSD" was
// 'ambiguous' for "SSD capacity in GB", and "Contact sales" or "TBA" for a
// price was 'unparseable', which made correct answers 'partial'.
import { describe, expect, it } from 'vitest';
import { convertUnit, fieldUnit, unitAfter } from '../../src/extract/validate/units.js';
import { normalizeValue, type NormalizeContext } from '../../src/extract/validate/normalize.js';
import type { FieldSpec, FieldType } from '../../src/extract/types.js';

const ctx: NormalizeContext = { baseUrl: 'https://shop.example.com/' };

function spec(name: string, type: FieldType, description?: string): FieldSpec {
  return { name, type, required: false, nullable: true, derived: false, schema: {}, ...(description ? { description } : {}) };
}

function normalized(raw: unknown, field: FieldSpec) {
  return normalizeValue(raw, field, ctx);
}

describe('fieldUnit', () => {
  it.each([
    [spec('storage', 'integer', 'SSD capacity in GB'), 'gb'],
    [spec('ram', 'integer', 'Memory of the selected configuration, in GB'), 'gb'],
    [spec('weightKg', 'number'), 'kg'],
    [spec('weight', 'number', 'Weight in kilograms'), 'kg'],
    [spec('battery', 'integer', 'Battery capacity (mAh)'), 'mah'],
    [spec('battery_mah', 'integer'), 'mah'],
    [spec('screenInches', 'number'), 'in'],
    [spec('length', 'number', 'Cable length in m'), 'm'],
    [spec('runtime', 'integer', 'Running time in minutes'), 'min'],
  ])('%j asks for %s', (field, unit) => {
    expect(fieldUnit(field)?.id).toBe(unit);
  });

  it.each([
    [spec('price', 'number', 'price in GBP')],
    [spec('pricePerKg', 'number', 'Price per kg')],
    [spec('rating', 'number', 'Average customer rating out of 5')],
    [spec('stock', 'integer', 'Units in stock')],
    [spec('loggedIn', 'boolean')],
    [spec('size', 'number', 'Weight in kg or length in cm')],
  ])('%j names no single unit', (field) => {
    expect(fieldUnit(field)).toBeUndefined();
  });
});

describe('unitAfter', () => {
  it.each([
    [' GB LPDDR5X', 'gb'],
    ['GB', 'gb'],
    [' g', 'g'],
    [' grams', 'g'],
    ['" OLED', 'in'],
    [' in', 'in'],
    [' in, 2.8K', 'in'],
    [' mAh (typ.)', 'mah'],
    [' W USB-C', 'w'],
  ])('%j is %s', (after, unit) => {
    expect(unitAfter(after)?.id).toBe(unit);
  });

  it.each([[' in stock'], ['G network'], [' to 10'], [' w/ case'], [' items']])('%j is no unit', (after) => {
    expect(unitAfter(after)).toBeUndefined();
  });

  it('converts only exact factors, rounded to the printed precision', () => {
    const kg = fieldUnit(spec('weightKg', 'number'))!;
    const lb = unitAfter(' lb')!;
    expect(convertUnit(3.09, '3.09', lb, kg)).toBe(1.4);
    expect(convertUnit(6, '6', lb, kg)).toBe(2.72);
    expect(convertUnit(1, '1', unitAfter(' TB')!, unitAfter(' GB')!)).toBeNull();
    expect(convertUnit(1, '1', unitAfter(' GB')!, kg)).toBeNull();
  });
});

describe('numbers in the field unit', () => {
  const storage = spec('storage', 'integer', 'SSD capacity in GB');
  const ram = spec('ram', 'integer', 'Memory, in GB');
  const weight = spec('weightKg', 'number', 'Weight in kilograms');

  it('picks the number printed in the field unit', () => {
    expect(normalized('512 GB PCIe 4.0 NVMe SSD', storage)).toMatchObject({ ok: true, value: 512 });
    expect(normalized('16 GB LPDDR5X-8533', ram)).toMatchObject({ ok: true, value: 16 });
    expect(normalized('1.4 kg (3.09 lb)', weight)).toMatchObject({ ok: true, value: 1.4 });
    expect(normalized('5,000 mAh (typ.)', spec('batteryMah', 'integer'))).toMatchObject({ ok: true, value: 5000 });
    const steps = (normalized('512 GB PCIe 4.0 NVMe SSD', storage) as { steps: string[] }).steps;
    expect(steps).toContain('unit:gb');
  });

  it('converts a value printed only in another unit of the same quantity', () => {
    expect(normalized('3.09 lb', weight)).toMatchObject({ ok: true, value: 1.4, steps: expect.arrayContaining(['convert:lb-kg']) });
  });

  it('does not guess between decimal and binary data units', () => {
    expect(normalized('1 TB SSD', storage)).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('keeps the usual rules when the text prints no unit of that quantity', () => {
    expect(normalized('512', storage)).toMatchObject({ ok: true, value: 512 });
    expect(normalized('512 or 1024', storage)).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(normalized('8 GB, 16 GB', ram)).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('leaves fields without a unit alone', () => {
    expect(normalized('512 GB PCIe 4.0 NVMe SSD', spec('storage', 'integer'))).toMatchObject({ ok: false, reason: 'ambiguous' });
  });
});

describe('text that states there is no value', () => {
  const price = spec('price', 'number');

  it.each([
    ['Contact sales'], ['Contact us for pricing'], ['Call for price'], ['Price on request'], ['Price: on request'], ['POA'],
    ['Custom pricing'], ['TBA'], ['To be announced'], ['Coming soon'], ['N/A'], ['—'], ['-'], ['Currently unavailable.'],
    ['Sold out'], ['Unlimited seats'], ['Preis auf Anfrage'], ['Prix sur demande'], ['Agotado'],
  ])('%j is null for a number', (raw) => {
    expect(normalized(raw, price)).toEqual({ ok: true, value: null, steps: ['no-value'] });
  });

  it.each([['Free'], ['None'], ['No reviews yet'], ['Contact sales: 555-0100'], ['Twelve']])('%j stays a failure', (raw) => {
    expect(normalized(raw, price).ok).toBe(false);
  });

  it('star glyphs count the filled stars', () => {
    const rating = spec('rating', 'number');
    expect(normalized('★★★★☆', rating)).toMatchObject({ ok: true, value: 4 });
    expect(normalized('★★★½☆', rating)).toMatchObject({ ok: true, value: 3.5 });
    expect(normalized('⭐⭐⭐', spec('stars', 'integer'))).toMatchObject({ ok: true, value: 3 });
    expect(normalized('☆☆☆☆☆', rating).ok).toBe(false);
  });

  it('booleans: "N/A" is no answer, "Not available" is an answer', () => {
    const inStock = spec('inStock', 'boolean');
    expect(normalized('N/A', inStock)).toEqual({ ok: true, value: null, steps: ['no-value'] });
    expect(normalized('TBD', inStock)).toEqual({ ok: true, value: null, steps: ['no-value'] });
    expect(normalized('Not available', inStock)).toMatchObject({ ok: true, value: false });
  });
});
