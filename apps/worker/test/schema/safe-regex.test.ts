import { describe, expect, it } from 'vitest';
import { isSafeRegex, MAX_PATTERN_LENGTH } from '../../src/extract/schema/safe-regex.js';

describe('isSafeRegex: catastrophic shapes are rejected', () => {
  it.each([
    // Nested quantifiers (star height > 1).
    ['(a+)+'],
    ['(a+)+$'],
    ['^(a*)*$'],
    ['(a+)*'],
    ['(a?)+'],
    ['(.*)+'],
    ['(.*)*x'],
    ['(\\d+)+$'],
    ['^(\\w+\\s?)*$'],
    ['((ab)*)+'],
    ['(?:a+){2,}'],
    ['(a{1,3}){2,5}'],
    ['(x+x+)+y'],
    ['(.*,){11}P'],
    ['(?<name>a+)+'],
    ['(?=(a+))+'],
    ['([a-z]+\\s?)+$'],
    // Ambiguous alternation inside repetition.
    ['(a|a)*'],
    ['(a|ab)+'],
    ['(\\w|\\d)+'],
    ['(.|\\s)*'],
    ['(|a)+'],
    ['((x|x)y)+'],
    ['(?:[a-z]|[0-9])+'],
    ['(a|b|a)*$'],
    // More than two undelimited unbounded quantifiers (high-degree polynomial).
    ['.*a.*b.*c'],
    ['\\S+\\S+\\S+$'],
    ['[^x]*y[^z]*w[^v]*u'],
    ['a*a*a*b'],
    ['\\d*\\d*\\d*x'],
    ['(?:ab)*(?:ab)*(?:ab)*c'],
    // Choices that multiply without any repetition (exponential in pattern length).
    [`${'a?'.repeat(20)}${'a'.repeat(20)}`],
    ['(a|a)'.repeat(20)],
    [`^${'(?:x|x)'.repeat(14)}.*$`],
    [`^${'(?:x|x)'.repeat(5)}.*a.*$`],
    [`${'\\d{0,9}'.repeat(8)}`],
  ])('%s', (pattern) => {
    expect(isSafeRegex(pattern)).toBe(false);
  });
});

describe('isSafeRegex: ordinary patterns pass', () => {
  it.each([
    ['^[A-Z]{2}-\\d{4}$'],
    ['^\\d+(\\.\\d+)?$'],
    ['^https?://'],
    ['^.*$'],
    ['^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'],
    ['^(?:\\+?1[-. ]?)?\\(?\\d{3}\\)?[-. ]?\\d{3}[-. ]?\\d{4}$'],
    ['^([^,]*,)*[^,]*$'],
    ['^(\\d+,)+\\d+$'],
    ['^(\\d{3}-)+$'],
    ['(foo|bar)+'],
    ['(a|b)*c'],
    ['^\\p{Lu}\\p{Ll}+$'],
    ['^[\\u{1F600}-\\u{1F64F}]+$'],
    ['^\\w+\\s\\w+$'],
    ['^(\\w+\\s)+$'],
    ['^(?<year>\\d{4})-(?<month>\\d{2})$'],
    ['^(a+b)+$'],
    ['^(?:ab)*$'],
    ['^[^]*$'],
    ['\\bprice\\b'],
    ['^(?!test)\\w+$'],
    ['^(a)\\1$'],
    ['^[a-z0-9]+(?:-[a-z0-9]+)*$'],
    ['^\\d{1,3}(,\\d{3})*(\\.\\d+)?$'],
    ['^(?:\\+?\\d{1,3}[-.\\s]?)?\\(?\\d{1,4}\\)?[-.\\s]?\\d{1,4}[-.\\s]?\\d{1,9}$'],
    ['^(?:[01]\\d|2[0-3]):[0-5]\\d$'],
    ['^[\\w.+-]+@[\\w-]+\\.[\\w.-]+$'],
    ['^\\s*\\S+\\s*$'],
    ['a?b?c?d?e?'],
  ])('%s', (pattern) => {
    expect(isSafeRegex(pattern)).toBe(true);
  });
});

describe('isSafeRegex: input validation', () => {
  it('rejects patterns that do not compile in unicode mode', () => {
    expect(isSafeRegex('([a-z')).toBe(false);
    expect(isSafeRegex('a{')).toBe(false);
    expect(isSafeRegex('\\')).toBe(false);
    expect(isSafeRegex('(?<x>a)\\k<y>')).toBe(false);
  });

  it('rejects patterns over the length limit', () => {
    expect(isSafeRegex('a'.repeat(MAX_PATTERN_LENGTH))).toBe(true);
    expect(isSafeRegex('a'.repeat(MAX_PATTERN_LENGTH + 1))).toBe(false);
    expect(isSafeRegex('a'.repeat(300), 400)).toBe(true);
  });

  it('rejects non-strings', () => {
    expect(isSafeRegex(5 as unknown as string)).toBe(false);
    expect(isSafeRegex(undefined as unknown as string)).toBe(false);
  });

  it('handles escapes, classes and quantifier syntax', () => {
    expect(isSafeRegex('^\\x41\\u0042\\u{43}\\cJ\\t\\0$')).toBe(true);
    expect(isSafeRegex('^[\\]\\\\-]+$')).toBe(true);
    expect(isSafeRegex('^a{2}b{1,}c{0,3}?$')).toBe(true);
    // "+?" is still a repetition.
    expect(isSafeRegex('(a+?)+?')).toBe(false);
  });

  it('accepted patterns stay fast on adversarial input', () => {
    const accepted = ['^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', '^([^,]*,)*[^,]*$', '^(\\d+,)+\\d+$', '^(a+b)+$', '^(\\w+\\s)+$'];
    const inputs = ['a@'.repeat(5_000), ','.repeat(20_000) + '\n', '1,'.repeat(10_000) + 'x', 'a'.repeat(20_000) + 'c', 'ab '.repeat(5_000) + '!'];
    for (const pattern of accepted) {
      expect(isSafeRegex(pattern)).toBe(true);
      const re = new RegExp(pattern, 'u');
      const t0 = performance.now();
      for (const input of inputs) re.test(input);
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });

  it('analyses long patterns quickly', () => {
    const pattern = `^${'(?:ab|cd)'.repeat(28)}$`;
    expect(pattern.length).toBeLessThanOrEqual(MAX_PATTERN_LENGTH);
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) isSafeRegex(pattern);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
