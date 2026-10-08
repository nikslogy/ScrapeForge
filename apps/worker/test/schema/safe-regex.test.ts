import { describe, expect, it } from 'vitest';
import { checkRegex as checkRecipeRegex } from '../../src/extract/recipe/safe-regex.js';
import { checkRegexSafety, isSafeRegex, MAX_PATTERN_LENGTH } from '../../src/extract/schema/safe-regex.js';

const UNSAFE: string[] = [
  // Nested quantifiers (star height > 1).
  '(a+)+',
  '(a+)+$',
  '^(a*)*$',
  '(a+)*',
  '(a?)+',
  '(.*)+',
  '(.*)*x',
  '(\\d+)+$',
  '^(\\w+\\s?)*$',
  '((ab)*)+',
  '(?:a+){2,}',
  '(a{1,3}){2,5}',
  '(x+x+)+y',
  '(.*,){11}P',
  '(?<name>a+)+',
  '(?=(a+))+',
  '([a-z]+\\s?)+$',
  // Ambiguous alternation inside repetition.
  '(a|a)*',
  '(a|ab)+',
  '(\\w|\\d)+',
  '(.|\\s)*',
  '(|a)+',
  '((x|x)y)+',
  '(?:[a-z]|[0-9])+',
  '(a|b|a)*$',
  // An unbounded quantifier rescanning the run of an earlier ambiguous one.
  '\\s*(.+)$',
  '^\\s*(.+)$',
  'a*.*$',
  '^[a-z]*\\w+$',
  '^\\s*(.+?)\\s*$',
  '(.*?)\\s*x',
  '(\\d+)\\b\\d+',
  '[\\w.]+\\.\\d+x',
  '.*a.*b.*c',
  '^.*x.*y.*$',
  '\\S+\\S+\\S+$',
  '[^x]*y[^z]*w[^v]*u',
  'a*a*a*b',
  '\\d*\\d*\\d*x',
  '(?:ab)*(?:ab)*(?:ab)*c',
  '^(?:ab)*(?:ab)+$',
  '\\s*.{1,1000}$',
  '^\\s*\\s{20}x',
  '^a*(?:a{1,3}){8}$',
  // Choices that multiply without any repetition (exponential in pattern length).
  `${'a?'.repeat(20)}${'a'.repeat(20)}`,
  `${'a?'.repeat(13)}${'a'.repeat(13)}`,
  '(a|a)'.repeat(20),
  `^${'(?:x|x)'.repeat(14)}.*$`,
  `^${'(?:x|x)'.repeat(5)}.*a.*$`,
  `${'\\d{0,9}'.repeat(8)}`,
  `${'\\d{0,9}'.repeat(4)}x`,
  'x{0,5}x{0,5}x{0,5}y',
  '.*\\w{16}$',
  // Unanchored: every stopping point of the scan pays for what follows it.
  '(.*) reviews',
  '\\S*\\S\\S\\Sx',
  '\\S*\\S?\\S?x',
  '.*\\S{0,1}\\S{0,1}x',
  `\\S*${'\\S'.repeat(30)}x`,
  // Lookarounds, backreferences and counts.
  '(?=a+)b',
  '^(?=.*\\d).{8,}$',
  '(?=\\w{20})x',
  '(a+)\\1',
  '^(a)\\1+$',
  '(?:(a)\\1)+',
  'a{1001}',
  '(?:(?:a{100}){100}){100}',
];

const SAFE: string[] = [
  '^[A-Z]{2}-\\d{4}$',
  '^\\d+(\\.\\d+)?$',
  '^https?://',
  '^.*$',
  '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
  '^(?:\\+?1[-. ]?)?\\(?\\d{3}\\)?[-. ]?\\d{3}[-. ]?\\d{4}$',
  '^([^,]*,)*[^,]*$',
  '^(\\d+,)+\\d+$',
  '^(\\d{3}-)+$',
  '(foo|bar)+',
  '(a|b)*c',
  '^\\p{Lu}\\p{Ll}+$',
  '^[\\u{1F600}-\\u{1F64F}]+$',
  '^\\w+\\s\\w+$',
  '^(\\w+\\s)+$',
  '^(?<year>\\d{4})-(?<month>\\d{2})$',
  '^(a+b)+$',
  '^(?:ab)*$',
  '^[^]*$',
  '\\bprice\\b',
  '^(?!test)\\w+$',
  '^(a)\\1$',
  '^[a-z0-9]+(?:-[a-z0-9]+)*$',
  '^\\d{1,3}(,\\d{3})*(\\.\\d+)?$',
  '^(?:\\+?\\d{1,3}[-.\\s]?)?\\(?\\d{1,4}\\)?[-.\\s]?\\d{1,4}[-.\\s]?\\d{1,9}$',
  '^(?:[01]\\d|2[0-3]):[0-5]\\d$',
  '^[\\w.+-]+@[\\w-]+\\.[\\w.-]+$',
  '^\\s*\\S+\\s*$',
  'a?b?c?d?e?',
  // Separated by a character the earlier run cannot contain, or by a loop
  // whose iterations end in one: no rescans.
  '^\\w+(\\s\\w+)*$',
  '^\\w+@(?:\\w+\\.)+\\w+$',
  '^\\d*(?:\\d,)*$',
  '^[A-Z][a-z]+(?: [A-Z][a-z]+)*$',
  '^https?://[^/\\s]+(?:/[^\\s]*)?$',
  '^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}(?::\\d{2})?)?$',
  '^\\$?\\d+(?:\\.\\d{2})?$',
  '^#?[0-9a-fA-F]{6}$',
  '^[A-Za-z0-9]{8,64}$',
  '^.{1,1000}$',
  '^(\\w+)\\s\\1$',
  '\\s+$',
  '(\\d+) reviews',
  '^(.*) reviews$',
  'Price:\\s*(£\\d[\\d.,]*)',
  '(?:^|\\s)star-rating\\s+(\\S+)',
  '\\d{1,3}(?:,\\d{3})*',
  '(?<=Price: )\\S+',
  '^[A-Z]{3}$',
  '^\\d+(?:[.,]\\d+)?\\s?(?:kg|g|lb|oz)$',
  '^(?:FULL_TIME|PART_TIME|CONTRACTOR)$',
  '',
];

describe('isSafeRegex: catastrophic shapes are rejected', () => {
  it.each(UNSAFE.map((p) => [p]))('%s', (pattern) => {
    expect(isSafeRegex(pattern)).toBe(false);
  });

  it('explains why a pattern is refused', () => {
    expect(checkRegexSafety('\\s*(.+)$')).toEqual({ ok: false, reason: expect.stringMatching(/polynomial/) });
    expect(checkRegexSafety('(a+)+')).toEqual({ ok: false, reason: expect.stringMatching(/nested quantifier/) });
    expect(checkRegexSafety('(a|a)*')).toEqual({ ok: false, reason: expect.stringMatching(/alternation/) });
    expect(checkRegexSafety('.*a.*b')).toEqual({ ok: false, reason: expect.stringMatching(/unanchored/) });
    expect(checkRegexSafety('a{1001}')).toEqual({ ok: false, reason: expect.stringMatching(/1000/) });
    expect(checkRegexSafety('(?=a+)b')).toEqual({ ok: false, reason: expect.stringMatching(/lookaround/) });
    expect(checkRegexSafety('([a-z')).toEqual({ ok: false, reason: expect.stringMatching(/compile/) });
    expect(checkRegexSafety('^\\d+$')).toEqual({ ok: true });
  });
});

describe('isSafeRegex: ordinary patterns pass', () => {
  it.each(SAFE.map((p) => [p]))('%s', (pattern) => {
    expect(checkRegexSafety(pattern)).toEqual({ ok: true });
  });
});

describe('isSafeRegex: at least as strict as the recipe screen', () => {
  // The recipe screen's own rejection corpus (test/recipe/safe-regex.test.ts).
  // Exceptions are deliberate schema policies: backreferences to fixed groups
  // are allowed here, the empty pattern is valid, and the length limit is 256.
  const recipeUnsafe = [
    '(a+)+', '(a*)*', '(\\w+\\s?)*', '(.*,){11}', '(a|a)*', '(a|ab)+', '(?:\\d|\\d)+$', '.*a.*b', 'a*a*b', '\\s*(.+)$',
    '^\\s*(.+?)\\s*$', '(.*?)\\s*x', '(\\d+)\\b\\d+', '(?=a+)b', 'x{0,5}x{0,5}x{0,5}y', '.{0,1000}.{0,1000}', 'a{1001}',
    '(?:(?:a{100}){100}){100}', '(', '\\£', '[\\w.]+\\.\\d+x', '[^x]*[^y]*z', '[a-f]+[c-z]+1',
  ];

  it.each(recipeUnsafe.map((p) => [p]))('%s', (pattern) => {
    expect(checkRecipeRegex(pattern).ok).toBe(false);
    expect(isSafeRegex(pattern)).toBe(false);
  });

  it('documented exceptions', () => {
    expect(checkRecipeRegex('(a)\\1').ok).toBe(false);
    expect(isSafeRegex('(a)\\1')).toBe(true);
    expect(isSafeRegex('')).toBe(true);
    expect(isSafeRegex('a'.repeat(201))).toBe(true);
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
    expect(isSafeRegex('^\\ud83d\\ude00+$')).toBe(true);
    expect(isSafeRegex('^(?<n>\\d)\\k<n>$')).toBe(true);
    // "+?" is still a repetition.
    expect(isSafeRegex('(a+?)+?')).toBe(false);
  });

  it('analyses long patterns quickly', () => {
    const patterns = [
      `^${'(?:ab|cd)'.repeat(28)}$`,
      `^${'[a-z]+-'.repeat(36)}$`,
      `${'\\p{L}*'.repeat(42)}`,
      `^${'(?:[\\u0000-\\uffff]x)?'.repeat(10)}$`,
      `^${'('.repeat(30)}a${')'.repeat(30)}$`,
    ];
    const t0 = performance.now();
    for (const pattern of patterns) {
      expect(pattern.length).toBeLessThanOrEqual(MAX_PATTERN_LENGTH);
      for (let i = 0; i < 20; i++) isSafeRegex(pattern);
    }
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

// ─────────────────────────────────────────────────────────────
// Timing: what is accepted must stay fast on hostile input
// ─────────────────────────────────────────────────────────────

/** validate/ajv.ts never runs a pattern on a longer string. */
const INPUT_CHARS = 2_000;
const BUDGET_MS = 50;
const SAMPLE_CHARS = ['a', 'Z', '0', '9', ' ', '\t', '\n', '_', '-', '.', ',', '@', ':', '/', 'é', '€', '\u2028'];
// "€" makes the subject a two-byte string: V8's slower matching path.
const PAIR_SAMPLES = ['a', '0', ' ', '€'];
const TAILS = ['\n', '!', '\u0000'];

/**
 * Inputs that pump each character, each pair of characters, and each
 * character after a literal of the pattern ("a@" + "...": the host part of an
 * e-mail pattern), all ending in a character that makes the match fail.
 */
function hostileInputs(pattern: string): string[] {
  const literals = [...new Set([...pattern].filter((ch) => ch >= ' ' && ch <= '~'))];
  const alphabet = [...new Set([...SAMPLE_CHARS, ...literals])];
  const pairAlphabet = [...new Set([...PAIR_SAMPLES, ...literals])];
  const out = new Set<string>();
  for (const c of alphabet) {
    out.add(c.repeat(INPUT_CHARS));
    for (const t of TAILS) out.add(c.repeat(INPUT_CHARS - 1) + t);
  }
  for (const c of pairAlphabet) {
    for (const d of pairAlphabet) {
      if (c === d) continue;
      for (const t of TAILS.slice(0, 2)) out.add((c + d).repeat((INPUT_CHARS - 2) / 2) + t);
    }
  }
  for (const l of literals) {
    for (const c of alphabet) {
      out.add(`a${l}${c.repeat(INPUT_CHARS - 3)}\n`);
      out.add(`a${l}${c.repeat(INPUT_CHARS - 4)}€\n`);
    }
  }
  return [...out];
}

function worstCase(pattern: string): { ms: number; input: string } {
  const re = new RegExp(pattern, 'u');
  let worst = { ms: 0, input: '' };
  for (const input of hostileInputs(pattern)) {
    let ms = Infinity;
    // Re-measure slow runs: a GC pause or a busy machine is not the regex.
    for (let attempt = 0; attempt < 3 && ms >= BUDGET_MS / 2; attempt++) {
      const t0 = performance.now();
      re.test(input);
      ms = Math.min(ms, performance.now() - t0);
    }
    if (ms > worst.ms) worst = { ms, input };
  }
  return worst;
}

describe('isSafeRegex: accepted patterns run in < 50 ms on hostile 2,000-char inputs', () => {
  const accepted = [
    ...SAFE,
    // Accepted shapes close to rejected ones.
    '^\\s*\\S+\\s*$',
    '^\\S+\\s+\\S+\\s+(\\S+)',
    '\\d+ (.*)$',
    '[a-f]+[0-9]+z',
    '^[^:]+:\\s?\\S.*$',
    '^.*@[^@]+$',
    '^[^@\\s]+@[^@\\s]+$',
    `^${'(?:x|y)?'.repeat(13)}$`,
    `^${'\\d{0,9}'.repeat(4)}$`,
    '^(?:a|b)(?:a|c)(?:a|d).*$',
  ].filter((p, i, all) => all.indexOf(p) === i);

  it('every pattern of the corpus is accepted', () => {
    expect(accepted.filter((p) => !isSafeRegex(p))).toEqual([]);
  });

  // Quadratic patterns take ~5-30 ms per input, so a pattern can take seconds.
  it.each(accepted.filter((p) => p !== '').map((p) => [p]))('%s', { timeout: 120_000 }, (pattern) => {
    const worst = worstCase(pattern);
    expect(worst.ms, `${worst.ms.toFixed(1)} ms on ${JSON.stringify(worst.input.slice(0, 12))}…`).toBeLessThan(BUDGET_MS);
  });

  it('the generator finds the slow inputs of patterns this module rejects', () => {
    // Guards the harness itself: a rejected cubic pattern must look slow to it.
    expect(isSafeRegex('\\s*(.+)$')).toBe(false);
    const re = /\s*(.+)$/u;
    const input = hostileInputs('\\s*(.+)$').find((s) => s.startsWith('   ') && s.endsWith('\n'));
    expect(input).toBeDefined();
    const t0 = performance.now();
    re.test((input as string).slice(-600));
    expect(performance.now() - t0).toBeGreaterThan(5);
  });
});
