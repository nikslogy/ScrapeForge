import { describe, expect, it } from 'vitest';
import {
  findNumericTokens,
  hasCurrencyMarker,
  localeNumberCandidates,
  parseLocaleNumber,
} from '../../src/extract/validate/numbers.js';

describe('parseLocaleNumber', () => {
  it.each([
    ['0', 0],
    ['42', 42],
    ['007', 7],
    ['3.14', 3.14],
    ['3,14', 3.14],
    ['1,5', 1.5],
    ['12,99', 12.99],
    ['1,2345', 1.2345],
    ['1234,567', 1234.567],
    ['0,123', 0.123],
    ['0.123', 0.123],
    ['1,299.00', 1299],
    ['1.299,00', 1299],
    ['1 299,00', 1299],
    ['1 299.50', 1299.5],
    ["1'299.00", 1299],
    ['1’299.00', 1299],
    ['1,234,567', 1234567],
    ['1.234.567', 1234567],
    ['1.234.567,89', 1234567.89],
    ['1,234,567.89', 1234567.89],
    ['1 234 567', 1234567],
    ['1,23,456', 123456],
    ['1,23,456.78', 123456.78],
    ['12,34,56,789', 123456789],
    ['-5', -5],
    ['−5', -5],
    ['+5', 5],
    ['- 1,5', -1.5],
    ['-0', 0],
    ['  51.77  ', 51.77],
    ['１２３', 123],
  ])('%j → %d', (text, expected) => {
    expect(parseLocaleNumber(text)).toBe(expected);
  });

  describe('the ambiguous "x,xxx" / "x.xxx" shape', () => {
    it('reads a comma before three digits as thousands', () => {
      expect(parseLocaleNumber('1,234')).toBe(1234);
      expect(parseLocaleNumber('999,999')).toBe(999999);
    });

    it('reads a dot before three digits as a decimal point, except ".000"', () => {
      expect(parseLocaleNumber('1.234')).toBe(1.234);
      expect(parseLocaleNumber('1.000')).toBe(1000);
      expect(parseLocaleNumber('12.000')).toBe(12000);
    });

    it('prefers the integer reading for integer fields', () => {
      expect(parseLocaleNumber('1.024', { integer: true })).toBe(1024);
      expect(parseLocaleNumber('1,024', { integer: true })).toBe(1024);
    });

    it('follows an explicit decimal-separator hint', () => {
      expect(parseLocaleNumber('1,234', { decimal: ',' })).toBe(1.234);
      expect(parseLocaleNumber('1.234', { decimal: ',' })).toBe(1234);
      expect(parseLocaleNumber('1.234', { decimal: '.' })).toBe(1.234);
      expect(parseLocaleNumber('1,000', { decimal: ',' })).toBe(1);
      // The hint only resolves the ambiguous shape.
      expect(parseLocaleNumber('1,5', { decimal: '.' })).toBe(1.5);
      expect(parseLocaleNumber('1,299.00', { decimal: ',' })).toBe(1299);
    });

    it('is not ambiguous with a long or zero-led integer part', () => {
      expect(parseLocaleNumber('1234.567')).toBe(1234.567);
      expect(parseLocaleNumber('0,500')).toBe(0.5);
      expect(localeNumberCandidates('0,500')).toEqual([0.5]);
    });
  });

  it.each([
    [''],
    ['   '],
    ['abc'],
    ['1,2,3'],
    ['12,34,5'],
    ['1..2'],
    ['1,,000'],
    ['1.'],
    ['.5'],
    ['1,234.567,89'],
    ['1.234,567.89'],
    ['1 23'],
    ['1  299'],
    ['1,299 00'],
    ['1234,567,890'],
    ['$5'],
    ['5%'],
    ['1e5'],
    ['0x10'],
    ['Infinity'],
    ['NaN'],
    ['--5'],
    ['1'.repeat(65)],
    ['9'.repeat(400)],
  ])('rejects %j', (text) => {
    expect(parseLocaleNumber(text)).toBeNull();
  });
});

describe('localeNumberCandidates', () => {
  it.each([
    ['1,234', [1234, 1.234]],
    ['1.234', [1.234, 1234]],
    ['1,000', [1000]],
    ['1.000', [1000]],
    ['2,500', [2500]],
    ['1.250', [1.25, 1250]],
    ['1,299.00', [1299]],
    ['42', [42]],
    ['nope', []],
  ])('%j → %j', (text, expected) => {
    expect(localeNumberCandidates(text)).toEqual(expected);
  });
});

describe('findNumericTokens', () => {
  const texts = (text: string) => findNumericTokens(text).map((t) => t.text);

  it('keeps grouped and decimal numbers whole', () => {
    expect(texts('Price: 1,299.00 or 1.299,00 or 1 299,00 or 1\'299.00')).toEqual(['1,299.00', '1.299,00', '1 299,00', "1'299.00"]);
    expect(texts('₹1,23,456.00')).toEqual(['1,23,456.00']);
    expect(texts('pi is 3.14159')).toEqual(['3.14159']);
  });

  it('splits ranges, lists and dates', () => {
    expect(texts('$10 - $20')).toEqual(['10', '20']);
    expect(texts('10-20')).toEqual(['10', '20']);
    expect(texts('10, 20, 30')).toEqual(['10', '20', '30']);
    expect(texts('2021-05-06')).toEqual(['2021', '05', '06']);
    expect(texts('4.5 out of 5')).toEqual(['4.5', '5']);
  });

  it('marks negative numbers but not range dashes', () => {
    const tokens = findNumericTokens('-5 and 10-20 and $-3 and −7 and SKU-9');
    expect(tokens.map((t) => [t.text, t.negative])).toEqual([
      ['5', true],
      ['10', false],
      ['20', false],
      ['3', true],
      ['7', true],
      ['9', false],
    ]);
  });

  it('skips digits glued to Latin letters, except currency codes', () => {
    expect(texts('Model A1B2 v2 COVID19 USD12 eur5 Rs.499 Rs499 12EUR')).toEqual(['12', '5', '499', '499', '12']);
  });

  it('keeps digits next to CJK text', () => {
    expect(texts('价格100元')).toEqual(['100']);
    expect(texts('在庫3個')).toEqual(['3']);
  });

  it('reports offsets', () => {
    const [token] = findNumericTokens('Total: £51.77');
    expect(token).toEqual({ text: '51.77', start: 8, end: 13, negative: false });
  });

  it('honours maxTokens', () => {
    expect(findNumericTokens('1 2 3 4 5', 2)).toHaveLength(2);
  });

  it('is linear on long adversarial input', () => {
    const inputs = ['1,'.repeat(50_000), '1 '.repeat(50_000), '9'.repeat(100_000), `${'a'.repeat(100_000)}1`, '1.1.1.1.'.repeat(20_000)];
    const t0 = performance.now();
    for (const input of inputs) findNumericTokens(input);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

describe('hasCurrencyMarker', () => {
  it.each([
    ['£51.77', true],
    ['€ 5', true],
    ['$5', true],
    ['¥1,200', true],
    ['₹499', true],
    ['USD 12', true],
    ['12 eur', true],
    ['Rs. 499', true],
    ['5 kr', true],
    ['100円', true],
    ['12 apples', false],
    ['Try 3 for free', false],
    ['', false],
  ])('%j → %s', (text, expected) => {
    expect(hasCurrencyMarker(text)).toBe(expected);
  });
});
