import { describe, expect, it } from 'vitest';
import { checkRegex, isSafeRegex } from '../../src/extract/recipe/safe-regex.js';

describe('isSafeRegex (recipe)', () => {
  const safe = [
    'Price:\\s*(£\\d[\\d.,]*)',
    'Price:\\s?(£\\d[\\d.,]*)',
    '(\\d+) reviews',
    '(.*) reviews',
    '\\bstar-rating\\s+(\\S+)',
    '(?:^|\\s)star-rating\\s+(\\S+)',
    '(\\S+)\\s+star(?:\\s|$)',
    '^(\\S+)',
    '^\\S+\\s+\\S+\\s+(\\S+)',
    '(\\d+(?:\\.\\d+)?)',
    '\\d{1,3}(?:,\\d{3})*',
    '(\\d+)\\s*(?:reviews|ratings)',
    '\\((\\d[\\d.,]*)',
    '(?<=Price: )\\S+',
    'Price:(.*)',
    '\\p{L}+\\s+\\p{L}+',
    '([A-Z]{3})\\s?(\\d[\\d.,]*)',
    '(\\d+)\\s*%',
    'SKU:\\s*([\\w-]+)',
    '\\u{1F600}+',
    '[^,]*,(\\d+)',
  ];
  it.each(safe)('accepts %s', (p) => {
    expect(checkRegex(p)).toMatchObject({ ok: true });
  });

  const unsafe: Array<[string, RegExp]> = [
    ['(a+)+', /nested quantifier/],
    ['(a*)*', /nested quantifier/],
    ['(\\w+\\s?)*', /nested quantifier/],
    ['(.*,){11}', /nested quantifier/],
    ['(a|a)*', /alternation/],
    ['(a|ab)+', /alternation/],
    ['(?:\\d|\\d)+$', /alternation/],
    ['.*a.*b', /polynomial/],
    ['a*a*b', /polynomial/],
    ['\\s*(.+)$', /polynomial/],
    ['^\\s*(.+?)\\s*$', /polynomial/],
    ['(.*?)\\s*x', /polynomial/],
    ['(\\d+)\\b\\d+', /polynomial/],
    ['(a)\\1', /backreference/],
    ['(?<x>a)\\k<x>', /backreference/],
    ['(?=a+)b', /lookaround/],
    ['x{0,5}x{0,5}x{0,5}y', /ambiguous ways/],
    ['.{0,1000}.{0,1000}', /ambiguous ways/],
    ['a{1001}', /bounds/],
    ['(?:(?:a{100}){100}){100}', /repetition counts/],
    ['(', /compile/],
    ['\\£', /compile/],
    ['', /non-empty/],
    ['a'.repeat(201), /longer than 200/],
  ];
  it.each(unsafe)('rejects %s', (p, reason) => {
    const r = checkRegex(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it('reports capture groups', () => {
    expect(checkRegex('(a)(?:b)(?<n>c)')).toEqual({ ok: true, captureGroups: 2 });
    expect(checkRegex('abc')).toEqual({ ok: true, captureGroups: 0 });
  });

  it('decides class overlap soundly', () => {
    // \d+ then a space: disjoint, so the trailing .* is the only ambiguous quantifier.
    expect(isSafeRegex('\\d+ (.*)$')).toBe(true);
    // [\w.]+ then "." overlaps; a second unbounded quantifier after it is rejected.
    expect(isSafeRegex('[\\w.]+\\.\\d+x')).toBe(false);
    // Negated classes overlap anything but their own members.
    expect(isSafeRegex('[^x]*[^y]*z')).toBe(false);
    // Ranges are compared by interval.
    expect(isSafeRegex('[a-f]+[0-9]+z')).toBe(true);
    expect(isSafeRegex('[a-f]+[c-z]+1')).toBe(false);
  });

  it('accepted patterns stay fast on hostile 10,000-char inputs', () => {
    const inputs = ['1'.repeat(10_000), ' '.repeat(10_000), 'a'.repeat(10_000), 'Price: '.repeat(1_400)];
    for (const p of safe) {
      const re = new RegExp(p, 'u');
      for (const input of inputs) {
        const start = performance.now();
        re.exec(input);
        expect(performance.now() - start).toBeLessThan(1_000);
      }
    }
  });

  it('non-strings are unsafe', () => {
    expect(isSafeRegex(42 as unknown as string)).toBe(false);
  });
});
