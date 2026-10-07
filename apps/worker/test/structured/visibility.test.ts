import { describe, expect, it } from 'vitest';
import { isNumericLike, PageIndex, wordTokens } from '../../src/extract/structured/visibility.js';
import { makeDoc } from './helpers.js';

const page = (text: string, attrs: Array<Record<string, string>> = []) => new PageIndex(makeDoc({ text, items: [], attrs }));

describe('wordTokens', () => {
  it('normalizes like grounding and splits on non-word characters', () => {
    expect(wordTokens('A Light-in the “Attic”!')).toEqual(['a', 'light', 'in', 'the', 'attic']);
    expect(wordTokens('Café  Ｎｏｉｒ')).toEqual(['café', 'noir']);
    expect(wordTokens('<p>Fish &amp; Chips</p>')).toEqual(['fish', 'chips']);
    expect(wordTokens('東京タワー')).toEqual(['東', '京', 'タ', 'ワ', 'ー']);
    expect(wordTokens('a b c d', 2)).toEqual(['a', 'b']);
  });
});

describe('isNumericLike', () => {
  it.each(['51.77', '£51.77', '1,299.00', '1.299,00 €', 'USD 12', '12 euros', '0', '-3.5'])('%s is a number', (s) => {
    expect(isNumericLike(s)).toBe(true);
  });
  it.each(['', 'Free', '10 - 20', 'from $5', 'Model 3', '4.5/5', 'SKU-123', 'call 555-1234', '12 apples', 'x'.repeat(100)])('%s is not', (s) => {
    expect(isNumericLike(s)).toBe(false);
  });
});

describe('PageIndex.visible', () => {
  it('short text: word sequence with word boundaries', () => {
    const p = page('Red Kettle\n\nBored of tea? Try our kettle.');
    expect(p.visible('Red Kettle', 'text')).toBe(true);
    expect(p.visible('red  KETTLE', 'name')).toBe(true);
    expect(p.visible('Red', 'text')).toBe(true);
    expect(p.visible('Kettle Red', 'text')).toBe(false);
    expect(p.visible('ore', 'text')).toBe(false);
    expect(p.visible('', 'text')).toBe(false);
    expect(p.visible('!!!', 'text')).toBe(false);
  });

  it('numbers by value in any display form', () => {
    const p = page('Now £1,299.00 (was £1,499) · 4.6 out of 5 · 1.024 reviews');
    expect(p.visible(1299, 'number')).toBe(true);
    expect(p.visible('1299.00', 'number')).toBe(true);
    expect(p.visible('1,499', 'number')).toBe(true);
    expect(p.visible('4.6', 'number')).toBe(true);
    expect(p.visible(1024, 'number')).toBe(true);
    expect(p.visible(129, 'number')).toBe(false);
    expect(p.visible(4, 'number')).toBe(false);
    expect(p.visible(Number.NaN, 'number')).toBe(false);
  });

  it('long text by overlap, tolerant of small edits and markup', () => {
    const body = 'Heavy rain pushed rivers across the valley to record levels on Friday, officials said, as crews worked through the night to reinforce levees near the town.';
    const p = page(`Weather\n\n${body}\n\nRelated stories`);
    expect(p.visible(`<p>${body.replace('Friday', 'Friday morning')}</p>`, 'body')).toBe(true);
    expect(p.visible('A completely different paragraph about elections and markets that shares only a few words like the and rain with the page above it.', 'body')).toBe(false);
  });

  it('enumerations by their label', () => {
    const p = page('In stock (22 available)\n\nCondition: New\n\nFull-time');
    expect(p.visible('https://schema.org/InStock', 'enum')).toBe(true);
    expect(p.visible('http://schema.org/OutOfStock', 'enum')).toBe(false);
    expect(p.visible('https://schema.org/NewCondition', 'enum')).toBe(true);
    expect(p.visible('FULL_TIME', 'enum')).toBe(true);
    expect(p.visible(true, 'enum')).toBe(false);
  });

  it('currency codes by code or symbol', () => {
    expect(page('£18.00').visible('GBP', 'text')).toBe(true);
    expect(page('18.00 GBP').visible('GBP', 'text')).toBe(true);
    expect(page('$18.00').visible('GBP', 'text')).toBe(false);
  });

  it('dates in display forms and datetime attributes', () => {
    expect(page('Published March 1, 2024').visible('2024-03-01T08:30:00Z', 'date')).toBe(true);
    expect(page('1st March 2024').visible('2024-03-01', 'date')).toBe(true);
    expect(page('01/03/2024').visible('2024-03-01', 'date')).toBe(true);
    expect(page('Sep 9, 2023').visible('2023-09-09', 'date')).toBe(true);
    expect(page('2024-03-01').visible('2024-03-01T00:00:00+02:00', 'date')).toBe(true);
    expect(page('Posted today', [{ datetime: '2024-03-01T08:30:00Z' }]).visible('2024-03-01', 'date')).toBe(true);
    expect(page('March 2, 2024').visible('2024-03-01', 'date')).toBe(false);
    expect(page('x').visible('2024-13-45', 'date')).toBe(false);
  });

  it('ISO durations in display forms', () => {
    expect(page('Prep 15 mins').visible('PT15M', 'duration')).toBe(true);
    expect(page('Cook: 1 hr 30 min').visible('PT1H30M', 'duration')).toBe(true);
    expect(page('Ready in 90 minutes').visible('PT1H30M', 'duration')).toBe(true);
    expect(page('Bake 1h 5m').visible('PT1H5M', 'duration')).toBe(true);
    expect(page('Prep 20 mins').visible('PT15M', 'duration')).toBe(false);
    expect(page('x').visible('P1Y', 'duration')).toBe(false);
  });

  it('URLs among link and image attributes (host, query and trailing slash tolerant)', () => {
    const p = page('Gallery', [{ src: 'https://cdn.example.com/img/lamp-large.jpg?w=600' }, { href: 'https://shop.example.com/p/lamp/' }]);
    expect(p.visible('https://cdn.example.com/img/lamp-large.jpg', 'url')).toBe(true);
    expect(p.visible('//img.example.net/img/lamp-large.jpg', 'url')).toBe(true);
    expect(p.visible('https://shop.example.com/p/lamp', 'url')).toBe(true);
    expect(p.visible('/p/lamp', 'url')).toBe(true);
    expect(p.visible('https://cdn.example.com/img/other.jpg', 'url')).toBe(false);
  });

  it('arrays: every member must be visible', () => {
    const p = page('By Jane Doe and John Roe');
    expect(p.visible(['Jane Doe', 'John Roe'], 'name')).toBe(true);
    expect(p.visible(['Jane Doe', 'Max Mustermann'], 'name')).toBe(false);
    expect(p.visible([], 'name')).toBe(false);
  });

  it('non-scalar values are never visible', () => {
    const p = page('anything');
    let deep: unknown = 'anything';
    for (let i = 0; i < 100_000; i++) deep = [deep];
    for (const v of [null, undefined, {}, { name: 'anything' }, Symbol('x'), [['anything']], deep]) expect(p.visible(v, 'text')).toBe(false);
    expect(p.visible(['anything'], 'text')).toBe(true);
  });

  it('scales to a large page', () => {
    const words = Array.from({ length: 200_000 }, (_, i) => `w${i % 5000} item${i}`).join(' ');
    const p = page(words);
    const t0 = performance.now();
    for (let i = 0; i < 5_000; i++) p.visible(`w${i} item${i}`, 'text');
    expect(p.visible('w42 item42', 'text')).toBe(true);
    expect(p.visible('item42 w42', 'text')).toBe(false);
    expect(performance.now() - t0).toBeLessThan(3_000);
  });
});
