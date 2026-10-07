import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeSchema } from '../../src/extract/schema/normalize.js';
import {
  clearValidatorCache,
  compileError,
  MAX_PATTERN_INPUT_CHARS,
  MAX_REPORTED_ERRORS,
  validateOutput,
  VALIDATOR_CACHE_SIZE,
  validatorCacheSize,
} from '../../src/extract/validate/ajv.js';
import type { NormalizedSchema } from '../../src/extract/types.js';

function handBuilt(jsonSchema: Record<string, unknown>, hash: string, shape: NormalizedSchema['shape'] = 'object'): NormalizedSchema {
  return { jsonSchema, shape, recordSchema: jsonSchema, fields: [], hash, fromShorthand: false };
}

beforeEach(() => clearValidatorCache());

describe('validateOutput', () => {
  const product = normalizeSchema({
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1 },
      price: { type: 'number', minimum: 0 },
      currency: { type: 'string', enum: ['USD', 'EUR', 'GBP'] },
      url: { type: 'string', format: 'uri' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'price'],
    additionalProperties: false,
  });

  it('accepts valid output', () => {
    expect(validateOutput(product, { title: 'A', price: 1.5, currency: 'GBP', tags: ['x'] })).toEqual({ valid: true, errors: [] });
  });

  it('reports human-readable "path message" errors', () => {
    const result = validateOutput(product, { title: '', price: -1, currency: 'JPY', tags: [1], extra: true });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        '/ must NOT have additional properties: "extra"',
        '/title must NOT have fewer than 1 characters',
        '/price must be >= 0',
        '/currency must be equal to one of the allowed values: "USD", "EUR", "GBP"',
        '/tags/0 must be string',
      ]),
    );
  });

  it('reports missing required properties at the root', () => {
    expect(validateOutput(product, {}).errors).toEqual([
      "/ must have required property 'title'",
      "/ must have required property 'price'",
    ]);
  });

  it('does not coerce types, fill defaults or remove properties', () => {
    const schema = normalizeSchema({
      type: 'object',
      properties: { n: { type: 'number', default: 5 }, s: { type: 'string' } },
      additionalProperties: false,
    });
    const data: Record<string, unknown> = { n: '12', s: 3 };
    expect(validateOutput(schema, data).valid).toBe(false);
    expect(data).toEqual({ n: '12', s: 3 });
    const empty: Record<string, unknown> = {};
    validateOutput(schema, empty);
    expect(empty).toEqual({});
    const extra = { n: 1, other: 'x' };
    expect(validateOutput(schema, extra).valid).toBe(false);
    expect(extra).toEqual({ n: 1, other: 'x' });
  });

  it('ignores formats (no ajv-formats installed)', () => {
    expect(validateOutput(product, { title: 'A', price: 1, url: 'not a url' }).valid).toBe(true);
  });

  it('understands OpenAPI nullable on hand-built schemas', () => {
    const schema = handBuilt({ type: 'object', properties: { a: { type: 'string', nullable: true } } }, 'nullable-hand-1');
    expect(validateOutput(schema, { a: null }).valid).toBe(true);
    expect(validateOutput(schema, { a: 1 }).valid).toBe(false);
  });

  it('caps reported errors at 20, saying how many were dropped', () => {
    const props = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, { type: 'number' }]));
    const schema = normalizeSchema({ type: 'object', properties: props });
    const data = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, 'x']));
    const { valid, errors } = validateOutput(schema, data);
    expect(valid).toBe(false);
    expect(errors).toHaveLength(MAX_REPORTED_ERRORS);
    expect(errors[0]).toBe('/f0 must be number');
    expect(errors[MAX_REPORTED_ERRORS - 1]).toBe('(31 more errors not shown)');
  });

  it('bounds the length of each error', () => {
    const schema = normalizeSchema({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false });
    const data = { ['k'.repeat(5_000)]: 1 };
    const [error] = validateOutput(schema, data).errors;
    expect(error.length).toBeLessThanOrEqual(300);
  });

  it('reports only the matching branch for shape auto', () => {
    const auto = normalizeSchema({ title: 'string', price: 'number' });
    expect(validateOutput(auto, { title: 1 }).errors).toEqual(['/title must be string,null']);
    expect(validateOutput(auto, [{ title: 'ok' }, { price: 'x' }]).errors).toEqual(['/1/price must be number,null']);
    expect(validateOutput(auto, 'x').errors).toEqual(['/ must be object']);
  });

  it('validates wrapper and array shapes', () => {
    const wrapper = normalizeSchema({
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] } } },
      required: ['items'],
    });
    expect(validateOutput(wrapper, { items: [{ a: 1 }] }).valid).toBe(true);
    expect(validateOutput(wrapper, { items: [{ a: 1.5 }, {}] }).errors).toEqual([
      '/items/0/a must be integer',
      "/items/1 must have required property 'a'",
    ]);
  });

  it('applies each pattern to its own property', () => {
    const s = normalizeSchema({
      type: 'object',
      properties: { a: { type: 'string', pattern: '^a+$' }, b: { type: 'string', pattern: '^b+$' } },
      patternProperties: { '^x-': { type: 'number' } },
    });
    expect(validateOutput(s, { a: 'aaa', b: 'bbb', 'x-1': 1 }).valid).toBe(true);
    expect(validateOutput(s, { a: 'bbb', b: 'aaa', 'x-1': 'no' }).errors).toEqual([
      '/a must match pattern "^a+$"',
      '/b must match pattern "^b+$"',
      '/x-1 must be number',
    ]);
  });

  it('does not run patterns on very long strings (they fail the pattern)', () => {
    const s = normalizeSchema({ type: 'object', properties: { code: { type: 'string', pattern: '^[a-z]+$' } } });
    expect(validateOutput(s, { code: 'a'.repeat(MAX_PATTERN_INPUT_CHARS) }).valid).toBe(true);
    expect(validateOutput(s, { code: 'a'.repeat(MAX_PATTERN_INPUT_CHARS + 1) }).errors).toEqual(['/code must match pattern "^[a-z]+$"']);
  });

  it('survives data it cannot traverse', () => {
    const schema = normalizeSchema({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } });
    const hostile = {
      get a(): unknown {
        throw new Error('boom');
      },
    };
    const result = validateOutput(schema, hostile);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/^validation_failed: boom/);
  });
});

describe('compile failures', () => {
  it('returns schema_compile_failed instead of throwing', () => {
    const broken = handBuilt({ type: 'object', properties: { a: { type: 'strin' } } }, 'broken-1');
    const result = validateOutput(broken, { a: 'x' });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^schema_compile_failed: /);
    expect(compileError(broken)).toMatch(/type/);
  });

  it('caches the failure', () => {
    const broken = handBuilt({ type: 'object', required: 'a' }, 'broken-2');
    validateOutput(broken, {});
    const size = validatorCacheSize();
    validateOutput(broken, {});
    expect(validatorCacheSize()).toBe(size);
    expect(compileError(broken)).not.toBeNull();
  });

  it('refuses async schemas (their result is a Promise, not a verdict)', () => {
    const schema = handBuilt({ $async: true, type: 'object', properties: { a: { type: 'number' } } }, 'async-1');
    const result = validateOutput(schema, { a: 'x' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/schema_compile_failed: \$async/);
  });

  it('reports nullable without type as a compile failure', () => {
    const schema = handBuilt({ type: 'object', properties: { a: { nullable: true } } }, 'nullable-no-type');
    expect(validateOutput(schema, {}).errors[0]).toMatch(/schema_compile_failed: "nullable" cannot be used without "type"/);
  });
});

describe('validator cache', () => {
  it('reuses one compiled validator per schema hash', () => {
    const a = normalizeSchema({ title: 'string' });
    const b = normalizeSchema({ title: 'string' });
    expect(a.jsonSchema).not.toBe(b.jsonSchema);
    expect(a.hash).toBe(b.hash);
    validateOutput(a, {});
    const size = validatorCacheSize();
    validateOutput(b, {});
    expect(validatorCacheSize()).toBe(size);
  });

  it('is bounded to 200 entries (LRU)', () => {
    const keep = normalizeSchema({ keep: 'string' });
    validateOutput(keep, {});
    for (let i = 0; i < VALIDATOR_CACHE_SIZE + 50; i++) {
      validateOutput(normalizeSchema({ [`f${i}`]: 'string' }), {});
      // Touching "keep" keeps it at the young end of the LRU.
      if (i % 50 === 0) validateOutput(keep, {});
    }
    expect(validatorCacheSize()).toBe(VALIDATOR_CACHE_SIZE);
    expect(validateOutput(keep, { keep: 1 }).valid).toBe(false);
  });

  it('never validates against another schema that shares a hash', () => {
    // Same hash, different content (a forged 64-bit collision).
    const numbers = handBuilt({ type: 'object', properties: { a: { type: 'number' } } }, 'collide');
    const strings = handBuilt({ type: 'object', properties: { a: { type: 'string' } } }, 'collide');
    expect(validateOutput(numbers, { a: 1 }).valid).toBe(true);
    expect(validateOutput(strings, { a: 1 }).valid).toBe(false);
    expect(validateOutput(strings, { a: 'x' }).valid).toBe(true);
    expect(validateOutput(numbers, { a: 'x' }).valid).toBe(false);
  });

  it('keeps validating correctly after eviction and recompilation', () => {
    const s = normalizeSchema({ type: 'object', properties: { a: { type: 'integer' } } });
    expect(validateOutput(s, { a: 1 }).valid).toBe(true);
    for (let i = 0; i < VALIDATOR_CACHE_SIZE + 1; i++) validateOutput(normalizeSchema({ [`g${i}`]: 'number' }), {});
    expect(validateOutput(s, { a: 1.5 }).valid).toBe(false);
    expect(validateOutput(s, { a: 2 }).valid).toBe(true);
  });

  it('validates repeated calls quickly once compiled', () => {
    const props = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}`, { type: ['string', 'null'] }]));
    const s = normalizeSchema({ type: 'object', properties: props });
    const record = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}`, 'value']));
    validateOutput(s, record);
    const t0 = performance.now();
    for (let i = 0; i < 1_000; i++) validateOutput(normalizeSchema({ type: 'object', properties: props }), record);
    expect(performance.now() - t0).toBeLessThan(3_000);
  });
});
