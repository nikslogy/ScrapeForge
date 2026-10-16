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

// After the adversarial review of the unit rules.
describe('one unit after several numbers', () => {
  it.each([
    ['31.2 x 22.1 x 1.5 cm', spec('widthCm', 'number')],
    ['128/256/512GB', spec('storageGb', 'integer')],
    ['2–3 kg', spec('weightKg', 'number')],
    ['5 to 7 kg', spec('weightKg', 'number')],
    ['60 x 90 cm', spec('widthCm', 'number')],
    ['5-7 lb', spec('weightKg', 'number')],
  ])('%s is several values, not the last one', (raw, field) => {
    expect(normalized(raw, field)).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('a pack count is not a size: "6 x 330 ml" is 330 ml', () => {
    expect(normalized('6 x 330 ml', spec('volumeMl', 'number'))).toMatchObject({ ok: true, value: 330 });
    expect(normalized('2 x 16 GB', spec('ramGb', 'integer'))).toMatchObject({ ok: true, value: 16 });
  });

  it('specs with one number in the unit are unchanged', () => {
    expect(normalized('512 GB PCIe 4.0 NVMe SSD', spec('storageGb', 'integer'))).toMatchObject({ ok: true, value: 512 });
    expect(normalized('16 GB LPDDR5X-8533', spec('ramGb', 'integer'))).toMatchObject({ ok: true, value: 16 });
    expect(normalized('1.4 kg (3.09 lb)', spec('weightKg', 'number'))).toMatchObject({ ok: true, value: 1.4 });
  });
});

describe('feet and inches', () => {
  it.each([
    [`6'2"`, spec('heightCm', 'number'), 188],
    [`6 ft 2 in`, spec('heightCm', 'number'), 188],
    [`5′10″`, spec('heightInches', 'number'), 70],
    [`6'2"`, spec('heightFt', 'number'), 6.17],
    [`6'2" (188 cm)`, spec('heightCm', 'number'), 188],
  ])('%s for %s is one length', (raw, field, value) => {
    expect(normalized(raw, field)).toMatchObject({ ok: true, value });
  });

  it('several heights, or a field with no unit, stay ambiguous', () => {
    expect(normalized(`6'2" – 6'4"`, spec('heightCm', 'number'))).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(normalized(`6'2"`, spec('height', 'number'))).toMatchObject({ ok: false, reason: 'ambiguous' });
  });
});

describe('words that only look like units', () => {
  it('"pounds" in a price field is money, not a mass', () => {
    expect(fieldUnit(spec('price', 'number', 'Price in pounds'))).toBeUndefined();
    expect(fieldUnit(spec('priceLb', 'number'))).toBeUndefined();
    expect(fieldUnit(spec('weight', 'number', 'Weight in pounds'))?.id).toBe('lb');
    // Whole words only: "display" is not "pay".
    expect(fieldUnit(spec('displayWeightLb', 'number'))?.id).toBe('lb');
    expect(fieldUnit(spec('shippingWeight', 'number', 'Shipping weight in pounds'))?.id).toBe('lb');
    expect(normalized('£24.99 (2.5 kg)', spec('price', 'number', 'Price in pounds'))).not.toMatchObject({ ok: true, value: 5.51 });
  });

  it('"Min" ending a name is a minimum unless a time word comes before it', () => {
    expect(fieldUnit(spec('priceMin', 'number'))).toBeUndefined();
    expect(fieldUnit(spec('salaryMin', 'number'))).toBeUndefined();
    expect(fieldUnit(spec('cookTimeMin', 'integer'))?.id).toBe('min');
    expect(fieldUnit(spec('durationMins', 'integer'))?.id).toBe('min');
    expect(normalized('From $45 for 30 min', spec('priceMin', 'number'))).not.toMatchObject({ ok: true, value: 30 });
  });
});

describe('no-value markers and star glyphs, more forms', () => {
  it('"k. A." (keine Angabe) states no value, with or without its last dot', () => {
    expect(normalized('k. A.', spec('price', 'number'))).toEqual({ ok: true, value: null, steps: ['no-value'] });
    expect(normalized('k.A.', spec('price', 'number'))).toEqual({ ok: true, value: null, steps: ['no-value'] });
    expect(normalized('k. A.', spec('inStock', 'boolean'))).toEqual({ ok: true, value: null, steps: ['no-value'] });
  });

  it('emoji stars with a variation selector count', () => {
    expect(normalized('⭐️⭐️⭐️⭐️', spec('rating', 'number'))).toMatchObject({ ok: true, value: 4 });
    expect(normalized('⭐️⭐️⭐️☆☆', spec('rating', 'number'))).toMatchObject({ ok: true, value: 3 });
  });
});
