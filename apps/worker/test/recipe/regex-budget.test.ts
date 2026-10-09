// Regex transforms are bounded per run: the deadline is checked before every
// regex application (not only between records), and the total regex input of
// one run is capped.

import { describe, expect, it } from 'vitest';
import { runRecipe } from '../../src/extract/recipe/run.js';
import { RECIPE_LIMITS } from '../../src/extract/recipe/limits.js';
import { isSafeRegex } from '../../src/extract/recipe/safe-regex.js';
import type { ExtractionRecipe } from '../../src/extract/types.js';

// Accepted by the safety screen, but quadratic: ~50 ms per exec on 3,000 chars without an "x".
const SLOW = '(?:a|a|a|a).*x';
const LONG = 'a'.repeat(3_000);
const BASE = 'https://shop.example.com/';

function paragraphs(n: number, text: string): string {
  return Array.from({ length: n }, () => `<p>${text}</p>`).join('');
}

describe('recipe regex budget', () => {
  it('the slow pattern passes the safety screen (so only the run budget bounds it)', () => {
    expect(isSafeRegex(SLOW)).toBe(true);
  });

  it('stops regex work inside one object record at the deadline', () => {
    const html = `<html><body><main>${paragraphs(60, LONG)}</main></body></html>`;
    const recipe: ExtractionRecipe = {
      version: 1,
      shape: 'object',
      fields: { v: { selector: 'p', all: true, transforms: [{ regex: SLOW }] } },
    };
    const t0 = Date.now();
    const out = runRecipe(recipe, { html }, { baseUrl: BASE, deadlineMs: t0 + 200 });
    const elapsed = Date.now() - t0;
    // Unbounded, 60 slow execs take ~3 s; the deadline stops it after at most one more exec.
    expect(elapsed).toBeLessThan(1_000);
    expect(out.errors.some((e) => /deadline/.test(e))).toBe(true);
  });

  it('stops regex work inside the first listing record at the deadline', () => {
    const html = `<html><body><ul><li>${paragraphs(60, LONG)}</li><li>${paragraphs(60, LONG)}</li></ul></body></html>`;
    const recipe: ExtractionRecipe = {
      version: 1,
      shape: 'array',
      recordSelector: 'li',
      fields: { v: { selector: 'p', all: true, transforms: [{ regex: SLOW }] } },
    };
    const t0 = Date.now();
    const out = runRecipe(recipe, { html }, { baseUrl: BASE, deadlineMs: t0 + 200 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(out.errors.some((e) => /deadline/.test(e))).toBe(true);
    // A record cut short is dropped: every record returned is complete.
    expect(out.data).toEqual([]);
    expect(out.recordCount).toBe(0);
  });

  it('caps the total regex input of one run', () => {
    const perValue = 10_000;
    const records = Math.ceil(RECIPE_LIMITS.maxRegexInputCharsPerRun / perValue) + 20;
    const text = `${'b'.repeat(perValue - 3)}123`;
    const html = `<html><body><ul>${Array.from({ length: records }, () => `<li><p>${text}</p></li>`).join('')}</ul></body></html>`;
    const recipe: ExtractionRecipe = {
      version: 1,
      shape: 'array',
      recordSelector: 'li',
      fields: { n: { selector: 'p', transforms: [{ regex: '(\\d+)' }, 'parse-integer'] } },
    };
    const out = runRecipe(recipe, { html }, { baseUrl: BASE });
    const data = out.data as Array<Record<string, unknown>>;
    expect(out.errors).toEqual([
      `regex budget exceeded (${RECIPE_LIMITS.maxRegexInputCharsPerRun} input chars) after ${data.length} of ${records} records`,
    ]);
    expect(data.length).toBe(Math.floor(RECIPE_LIMITS.maxRegexInputCharsPerRun / perValue));
    expect(data.every((r) => r.n === 123)).toBe(true);
  });

  it('an object record over the regex budget reports it', () => {
    const big = 'c'.repeat(RECIPE_LIMITS.maxRegexInputChars);
    const n = Math.ceil(RECIPE_LIMITS.maxRegexInputCharsPerRun / RECIPE_LIMITS.maxRegexInputChars) + 1;
    const fields: ExtractionRecipe['fields'] = {};
    // Spread over fields with all:true (100 items each) to pass the per-field cap.
    for (let f = 0; f * RECIPE_LIMITS.maxItemsPerField < n; f++) fields[`f${f}`] = { selector: 'p', all: true, transforms: [{ regex: 'z' }] };
    const html = `<html><body>${paragraphs(Math.min(n, RECIPE_LIMITS.maxItemsPerField), big)}</body></html>`;
    const out = runRecipe({ version: 1, shape: 'object', fields }, { html }, { baseUrl: BASE });
    expect(out.errors).toContain(`regex budget exceeded (${RECIPE_LIMITS.maxRegexInputCharsPerRun} input chars)`);
  });

  it('ordinary listings stay well inside the budget', () => {
    const html = `<html><body><ul>${Array.from({ length: 2_000 }, (_, i) => `<li><p class="star-rating Three">x</p><span>Price: ${i}</span></li>`).join('')}</ul></body></html>`;
    const recipe: ExtractionRecipe = {
      version: 1,
      shape: 'array',
      recordSelector: 'li',
      fields: {
        rating: { selector: 'p', attr: 'class', transforms: [{ regex: 'star-rating\\s+(\\S+)' }, { map: { three: 3 } }] },
        price: { selector: 'span', transforms: [{ regex: 'Price:\\s*(\\d+)' }, 'parse-integer'] },
      },
    };
    const out = runRecipe(recipe, { html }, { baseUrl: BASE, deadlineMs: Date.now() + 10_000 });
    expect(out.errors).toEqual([]);
    expect(out.recordCount).toBe(2_000);
    expect((out.data as Array<Record<string, unknown>>)[1999]).toEqual({ rating: 3, price: 1999 });
  });
});
