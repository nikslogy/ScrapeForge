import { describe, expect, it } from 'vitest';
import { normalizeSchema, SchemaError, SCHEMA_LIMITS, type SchemaErrorCode } from '../../src/extract/schema/normalize.js';
import { validateOutput } from '../../src/extract/validate/ajv.js';
import type { FieldSpec, NormalizedSchema } from '../../src/extract/types.js';

function field(schema: NormalizedSchema, name: string): FieldSpec {
  const found = schema.fields.find((f) => f.name === name);
  if (!found) throw new Error(`no field ${name}`);
  return found;
}

function expectSchemaError(input: unknown, code: SchemaErrorCode, message?: RegExp): SchemaError {
  let caught: unknown;
  try {
    normalizeSchema(input);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SchemaError);
  const error = caught as SchemaError;
  expect(error.code).toBe(code);
  if (message) expect(error.message).toMatch(message);
  return error;
}

function nested(depth: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < depth; i++) schema = { type: 'object', properties: { child: schema } };
  return schema;
}

describe('normalizeSchema: shorthand', () => {
  const quality = normalizeSchema({
    title: 'string — the book title as shown in the main product heading',
    price: 'number — numeric price in pounds, no currency symbol (e.g. 51.77)',
    availability: 'string — availability label such as "In stock" or "Out of stock"',
    rating: 'number — star rating 1–5 derived from the rating row',
  });

  it('parses the quality-test schema', () => {
    expect(quality.fromShorthand).toBe(true);
    expect(quality.shape).toBe('auto');
    expect(quality.wrapperKey).toBeUndefined();
    expect(quality.fields.map((f) => [f.name, f.type])).toEqual([
      ['title', 'string'],
      ['price', 'number'],
      ['availability', 'string'],
      ['rating', 'number'],
    ]);
    expect(field(quality, 'price').description).toBe('numeric price in pounds, no currency symbol (e.g. 51.77)');
    // The en dash inside the description is not a separator.
    expect(field(quality, 'rating').description).toBe('star rating 1–5 derived from the rating row');
  });

  it('makes shorthand fields optional and nullable', () => {
    for (const f of quality.fields) {
      expect(f.required).toBe(false);
      expect(f.nullable).toBe(true);
      expect(f.derived).toBe(false);
    }
    expect(field(quality, 'price').schema).toEqual({
      type: ['number', 'null'],
      description: 'numeric price in pounds, no currency symbol (e.g. 51.77)',
    });
  });

  it('validates both a single record and a list of records (shape auto)', () => {
    expect(validateOutput(quality, { title: 'A', price: 51.77, availability: null, rating: 3 }).valid).toBe(true);
    expect(validateOutput(quality, [{ title: 'A', price: 1 }, { title: 'B', price: null }]).valid).toBe(true);
    expect(validateOutput(quality, {}).valid).toBe(true);
    expect(validateOutput(quality, { price: '£51.77' }).valid).toBe(false);
    expect(validateOutput(quality, 'text').valid).toBe(false);
  });

  it.each([
    ['string — the title', 'string', 'the title'],
    ['string – the title', 'string', 'the title'],
    ['string - the title', 'string', 'the title'],
    ['string: the title', 'string', 'the title'],
    ['string—the title', 'string', 'the title'],
    ['number - price - in pounds', 'number', 'price - in pounds'],
    ['String — upper-case type word', 'string', 'upper-case type word'],
  ])('separator in %j', (value, type, description) => {
    const s = normalizeSchema({ a: value });
    expect(field(s, 'a').type).toBe(type);
    expect(field(s, 'a').description).toBe(description);
  });

  it.each([
    ['string', 'string', undefined, undefined],
    ['text', 'string', undefined, undefined],
    ['number', 'number', undefined, undefined],
    ['float', 'number', undefined, undefined],
    ['integer', 'integer', undefined, undefined],
    ['int', 'integer', undefined, undefined],
    ['boolean', 'boolean', undefined, undefined],
    ['bool', 'boolean', undefined, undefined],
    ['url', 'string', 'uri', undefined],
    ['date', 'string', 'date', undefined],
    ['datetime', 'string', 'date-time', undefined],
    ['email', 'string', 'email', undefined],
    ['object', 'object', undefined, undefined],
    ['array', 'array', undefined, 'unknown'],
    ['string[]', 'array', undefined, 'string'],
    ['url[]', 'array', undefined, 'string'],
    ['int[]', 'array', undefined, 'integer'],
    ['array<number>', 'array', undefined, 'number'],
    ['string[][]', 'array', undefined, 'array'],
    ['int?', 'integer', undefined, undefined],
  ])('type word %j', (value, type, format, itemType) => {
    const f = field(normalizeSchema({ a: value }), 'a');
    expect(f.type).toBe(type);
    expect(f.schema.format).toBe(format);
    expect(f.itemType).toBe(itemType);
  });

  it('keeps url format on array items', () => {
    const f = field(normalizeSchema({ images: 'url[] — gallery' }), 'images');
    expect(f.schema).toEqual({ type: ['array', 'null'], items: { type: 'string', format: 'uri' }, description: 'gallery' });
  });

  it('treats text without a known type as a described string', () => {
    const s = normalizeSchema({ title: 'the book title', label: 'Title: the main heading', link: 'https://example.com' });
    expect(field(s, 'title')).toMatchObject({ type: 'string', description: 'the book title' });
    expect(field(s, 'label')).toMatchObject({ type: 'string', description: 'Title: the main heading' });
    expect(field(s, 'link')).toMatchObject({ type: 'string', description: 'https://example.com' });
  });

  it('reads a leading unambiguous type word without a separator', () => {
    const s = normalizeSchema({ reviews: 'number of reviews', price: 'number (price in GBP)', note: 'text of the review', when: 'date of publication' });
    expect(field(s, 'reviews')).toMatchObject({ type: 'number', description: 'number of reviews' });
    expect(field(s, 'price')).toMatchObject({ type: 'number', description: 'price in GBP' });
    expect(field(s, 'note')).toMatchObject({ type: 'string', description: 'text of the review' });
    // "date" is too common an English word to be read as a type without a separator.
    expect(field(s, 'when').schema.format).toBeUndefined();
  });

  it('accepts nested JSON Schema values', () => {
    const s = normalizeSchema({
      title: 'string',
      price: { type: 'number', description: 'price', 'x-derived': false },
      summary: { type: 'string', 'x-derived': true },
      status: { enum: ['new', 'used'] },
    });
    expect(s.fromShorthand).toBe(true);
    expect(field(s, 'price')).toMatchObject({ type: 'number', nullable: true, required: false, description: 'price' });
    expect(field(s, 'summary').derived).toBe(true);
    expect(field(s, 'status')).toMatchObject({ type: 'string', nullable: true });
    expect(field(s, 'status').schema.enum).toEqual(['new', 'used', null]);
  });

  it('accepts nested shorthand objects and one-item arrays', () => {
    const s = normalizeSchema({ author: { name: 'string', url: 'url' }, tags: ['string'], variants: [{ sku: 'string', price: 'number' }] });
    const author = field(s, 'author');
    expect(author.type).toBe('object');
    expect(author.nullable).toBe(true);
    expect(author.schema.properties).toEqual({
      name: { type: ['string', 'null'] },
      url: { type: ['string', 'null'], format: 'uri' },
    });
    expect(field(s, 'tags')).toMatchObject({ type: 'array', itemType: 'string' });
    expect(field(s, 'variants')).toMatchObject({ type: 'array', itemType: 'object' });
    expect(validateOutput(s, { author: { name: 'A', url: null }, tags: ['x'], variants: [{ sku: 'a', price: 1 }] }).valid).toBe(true);
  });

  it('treats {"name": "string", "type": "string"} as shorthand with a "type" field', () => {
    const s = normalizeSchema({ name: 'string', type: 'string — product type' });
    expect(s.fromShorthand).toBe(true);
    expect(s.fields.map((f) => f.name)).toEqual(['name', 'type']);
  });

  it('treats the legacy {"items": {type: array, items: {...}}} form as a wrapper', () => {
    const s = normalizeSchema({ items: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } } } } });
    expect(s.shape).toBe('array');
    expect(s.wrapperKey).toBe('items');
    expect(s.fields.map((f) => f.name)).toEqual(['title']);
    expect(validateOutput(s, { items: [{ title: 'a' }] }).valid).toBe(true);
    expect(validateOutput(s, [{ title: 'a' }]).valid).toBe(false);
  });

  it.each([
    [{ a: 5 }],
    [{ a: true }],
    [{ a: null }],
    [{ a: ['string', 'number'] }],
    [{ a: [] }],
    [{ a: [5] }],
  ])('rejects invalid shorthand values %j', (input) => {
    expectSchemaError(input, 'invalid_schema', /\/a/);
  });
});

describe('normalizeSchema: JSON Schema forms', () => {
  it('bare properties → record schema, shape auto, constraints honoured', () => {
    const s = normalizeSchema({
      properties: { title: { type: 'string' }, price: { type: 'string' }, inStock: { type: 'boolean' } },
      required: ['title'],
    });
    expect(s.fromShorthand).toBe(false);
    expect(s.shape).toBe('auto');
    expect(s.recordSchema.type).toBe('object');
    expect(field(s, 'title')).toMatchObject({ required: true, nullable: false });
    expect(field(s, 'price')).toMatchObject({ required: false, nullable: false });
    expect(validateOutput(s, { title: 'x' }).valid).toBe(true);
    expect(validateOutput(s, { price: '1' }).valid).toBe(false);
    expect(validateOutput(s, [{ title: 'x' }]).valid).toBe(true);
    expect(validateOutput(s, { title: null }).valid).toBe(false);
  });

  it('typed object → shape object with nullability exactly as written', () => {
    const s = normalizeSchema({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: ['string', 'null'] },
        c: { type: 'string', nullable: true },
        d: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        e: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
        f: { type: 'string', enum: ['x', 'y'] },
        g: { enum: ['x', null] },
      },
      required: ['a', 'b'],
    });
    expect(s.shape).toBe('object');
    expect(s.jsonSchema).toBe(s.recordSchema);
    const summary = Object.fromEntries(s.fields.map((f) => [f.name, [f.type, f.nullable, f.required]]));
    expect(summary).toEqual({
      a: ['string', false, true],
      b: ['string', true, true],
      c: ['string', true, false],
      d: ['number', true, false],
      e: ['integer', true, false],
      f: ['string', false, false],
      g: ['string', true, false],
    });
    expect(field(s, 'c').schema).toEqual({ type: ['string', 'null'] });
    expect(validateOutput(s, { a: 'x', b: null, c: null, d: null, e: 1 }).valid).toBe(true);
    expect(validateOutput(s, [{ a: 'x', b: null }]).valid).toBe(false);
  });

  it('nullable:true keeps enum and combinator semantics', () => {
    const s = normalizeSchema({
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['a', 'b'], nullable: true },
        mixed: { anyOf: [{ type: 'string' }, { type: 'number' }], nullable: true, description: 'either' },
        strict: { allOf: [{ type: 'string' }, { minLength: 2 }], nullable: true, description: 'kept' },
        constant: { const: 'x', nullable: true },
      },
    });
    expect(field(s, 'status').schema).toEqual({ type: ['string', 'null'], enum: ['a', 'b', null] });
    expect(field(s, 'mixed').schema).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }], description: 'either' });
    expect(field(s, 'strict').schema).toEqual({
      description: 'kept',
      anyOf: [{ allOf: [{ type: 'string' }, { minLength: 2 }] }, { type: 'null' }],
    });
    expect(field(s, 'strict').description).toBe('kept');
    expect(field(s, 'constant').schema).toEqual({ enum: ['x', null] });
    for (const f of s.fields) expect(f.nullable).toBe(true);
    expect(validateOutput(s, { status: null, mixed: null, strict: null, constant: null }).valid).toBe(true);
    expect(validateOutput(s, { strict: 'a' }).valid).toBe(false);
    expect(validateOutput(s, { status: 'c' }).valid).toBe(false);
  });

  it('top-level array of objects → shape array', () => {
    const s = normalizeSchema({ type: 'array', items: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } });
    expect(s.shape).toBe('array');
    expect(s.wrapperKey).toBeUndefined();
    expect(s.recordSchema).toEqual({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'] });
    expect(field(s, 'title').required).toBe(true);
    expect(validateOutput(s, [{ title: 'a' }]).valid).toBe(true);
    expect(validateOutput(s, { title: 'a' }).valid).toBe(false);
  });

  it('adds type object to an untyped array item schema', () => {
    const s = normalizeSchema({ type: 'array', items: { properties: { a: { type: 'string' } } } });
    expect(s.recordSchema.type).toBe('object');
  });

  it('wrapper: object with exactly one array-of-objects property', () => {
    const s = normalizeSchema({
      type: 'object',
      properties: {
        products: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number' } } } },
      },
      required: ['products'],
    });
    expect(s.shape).toBe('array');
    expect(s.wrapperKey).toBe('products');
    expect(s.fields.map((f) => f.name)).toEqual(['name', 'price']);
    expect(s.jsonSchema.properties).toBeDefined();
    expect(validateOutput(s, { products: [{ name: 'a', price: 1 }] }).valid).toBe(true);
    expect(validateOutput(s, [{ name: 'a' }]).valid).toBe(false);
  });

  it('is not a wrapper when the object has other properties or the array holds scalars', () => {
    const two = normalizeSchema({
      type: 'object',
      properties: { products: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } }, total: { type: 'integer' } },
    });
    expect(two.shape).toBe('object');
    const scalars = normalizeSchema({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } });
    expect(scalars.shape).toBe('object');
    expect(field(scalars, 'tags')).toMatchObject({ type: 'array', itemType: 'string' });
  });

  it('infers field types from enum, const, format, structure and combinators', () => {
    const s = normalizeSchema({
      type: 'object',
      properties: {
        e1: { enum: ['a', 'b'] },
        e2: { enum: [1, 2, 3] },
        e3: { enum: [1.5, 2] },
        e4: { enum: [true, false] },
        e5: { enum: ['a', 1] },
        c1: { const: 5 },
        f1: { format: 'uri' },
        p1: { properties: { x: { type: 'string' } } },
        i1: { items: { type: 'number' } },
        a1: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        a2: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        a3: { allOf: [{ description: 'no type' }, { type: 'boolean' }] },
        a4: { anyOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'null' }] },
        t1: { type: ['null', 'integer'] },
        u1: {},
        u2: true,
        u3: false,
      },
    });
    const types = Object.fromEntries(s.fields.map((f) => [f.name, f.type]));
    expect(types).toEqual({
      e1: 'string', e2: 'integer', e3: 'number', e4: 'boolean', e5: 'unknown', c1: 'integer', f1: 'string', p1: 'object',
      i1: 'array', a1: 'string', a2: 'unknown', a3: 'boolean', a4: 'array', t1: 'integer', u1: 'unknown', u2: 'unknown', u3: 'unknown',
    });
    expect(field(s, 'i1').itemType).toBe('number');
    expect(field(s, 'a4').itemType).toBe('integer');
    expect(field(s, 'u1').nullable).toBe(true);
    expect(field(s, 'u2')).toMatchObject({ nullable: true, schema: {} });
    expect(field(s, 'u3')).toMatchObject({ nullable: false, schema: { not: {} } });
  });

  it('uses description, falling back to title', () => {
    const s = normalizeSchema({ type: 'object', properties: { a: { type: 'string', title: 'A title' }, b: { type: 'string', title: 'T', description: 'D' } } });
    expect(field(s, 'a').description).toBe('A title');
    expect(field(s, 'b').description).toBe('D');
  });

  it('collects properties and required from allOf branches', () => {
    const s = normalizeSchema({
      type: 'object',
      allOf: [{ properties: { a: { type: 'string' } }, required: ['a'] }, { properties: { b: { type: 'number' } } }],
    });
    expect(s.fields.map((f) => [f.name, f.required])).toEqual([['a', true], ['b', false]]);
  });

  it('maps type aliases inside JSON Schema', () => {
    const s = normalizeSchema({
      type: 'object',
      properties: { a: { type: 'float' }, b: { type: 'url' }, c: { type: ['int', 'null'] }, d: { type: 'datetime', format: 'date' } },
    });
    expect(field(s, 'a').schema).toEqual({ type: 'number' });
    expect(field(s, 'b').schema).toEqual({ type: 'string', format: 'uri' });
    expect(field(s, 'c').schema).toEqual({ type: ['integer', 'null'] });
    // An explicit format wins over the alias' format.
    expect(field(s, 'd').schema).toEqual({ type: 'string', format: 'date' });
  });

  it('accepts type strings where a property schema belongs', () => {
    const s = normalizeSchema({ properties: { title: 'string — the title', price: 'number' } });
    expect(field(s, 'title')).toMatchObject({ type: 'string', description: 'the title', nullable: false });
    expect(field(s, 'price').type).toBe('number');
  });

  it('strips $schema/$id so Ajv compiles any draft declaration and duplicate ids', () => {
    const a = normalizeSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.com/product.json',
      type: 'object',
      properties: { a: { type: 'string', $id: '#inner' } },
    });
    const b = normalizeSchema({ $id: 'https://example.com/product.json', type: 'object', properties: { b: { type: 'number' } } });
    expect(a.jsonSchema.$schema).toBeUndefined();
    expect(a.jsonSchema.$id).toBeUndefined();
    expect(field(a, 'a').schema).toEqual({ type: 'string' });
    expect(validateOutput(a, { a: 'x' }).valid).toBe(true);
    expect(validateOutput(b, { b: 1 }).valid).toBe(true);
  });

  it('keeps vendor extensions and data keywords untouched', () => {
    const s = normalizeSchema({
      type: 'object',
      properties: { a: { type: 'string', 'x-hint': { selector: '.price' }, default: 'x', examples: ['y'], minLength: 1 } },
    });
    expect(field(s, 'a').schema).toEqual({ type: 'string', 'x-hint': { selector: '.price' }, default: 'x', examples: ['y'], minLength: 1 });
  });

  it.each([
    [{ type: 'string' }],
    [{ type: 'string', description: 'a scalar' }],
    [{ type: 'array', items: { type: 'string' } }],
    [{ type: 'array' }],
    [{ $ref: '#/definitions/s', definitions: { s: { type: 'string' } } }],
  ])('rejects a top level that is not an object or array of objects: %j', (input) => {
    expectSchemaError(input, 'invalid_schema');
  });
});

describe('normalizeSchema: $ref', () => {
  it('inlines local refs from definitions and $defs', () => {
    const s = normalizeSchema({
      type: 'object',
      definitions: { Money: { type: 'number', minimum: 0 } },
      $defs: { Name: { type: 'string', description: 'from defs' } },
      properties: { price: { $ref: '#/definitions/Money' }, name: { $ref: '#/$defs/Name' } },
    });
    expect(field(s, 'price').schema).toEqual({ type: 'number', minimum: 0 });
    expect(field(s, 'name')).toMatchObject({ type: 'string', description: 'from defs' });
    expect(s.jsonSchema.definitions).toBeUndefined();
    expect(s.jsonSchema.$defs).toBeUndefined();
    expect(JSON.stringify(s.jsonSchema)).not.toContain('$ref');
    expect(validateOutput(s, { price: -1 }).valid).toBe(false);
  });

  it('lets sibling keywords override the target (extended refs)', () => {
    const s = normalizeSchema({
      type: 'object',
      $defs: { Price: { type: 'number', description: 'generic' } },
      properties: { sale: { $ref: '#/$defs/Price', description: 'sale price', nullable: true } },
    });
    expect(field(s, 'sale').schema).toEqual({ type: ['number', 'null'], description: 'sale price' });
  });

  it('follows chains and decodes pointer escapes', () => {
    const s = normalizeSchema({
      type: 'object',
      $defs: { 'a/b': { $ref: '#/$defs/c~0d' }, 'c~d': { $ref: '#/$defs/my%20type' }, 'my type': { type: 'integer', minimum: 1 } },
      properties: { n: { $ref: '#/$defs/a~1b' } },
    });
    expect(field(s, 'n').schema).toEqual({ type: 'integer', minimum: 1 });
  });

  it('resolves a root $ref (zod-to-json-schema style)', () => {
    const s = normalizeSchema({
      $ref: '#/definitions/Product',
      definitions: { Product: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
      $schema: 'http://json-schema.org/draft-07/schema#',
    });
    expect(s.shape).toBe('object');
    expect(field(s, 'title').required).toBe(true);
  });

  it('resolves refs into arrays and properties of the original document', () => {
    const s = normalizeSchema({
      type: 'object',
      properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }] }, b: { $ref: '#/properties/a/anyOf/0' } },
    });
    expect(field(s, 'b').schema).toEqual({ type: 'string' });
  });

  it.each([
    ['https://evil.example/schema.json'],
    ['http://localhost:8080/schema.json#/definitions/a'],
    ['other.json#/definitions/a'],
    ['#anchor'],
    ['#'],
    ['file:///etc/passwd'],
  ])('rejects non-local $ref %j', (ref) => {
    expectSchemaError({ type: 'object', properties: { a: { $ref: ref } } }, 'unsupported_ref', /local/);
  });

  it('rejects non-string $ref', () => {
    expectSchemaError({ type: 'object', properties: { a: { $ref: 5 } } }, 'unsupported_ref');
  });

  it.each([['$dynamicRef'], ['$recursiveRef']])('rejects %s', (key) => {
    expectSchemaError({ type: 'object', properties: { a: { [key]: '#meta' } } }, 'unsupported_ref', new RegExp(key.replace('$', '\\$')));
  });

  it('rejects recursive refs (direct, mutual and through the root)', () => {
    expectSchemaError({ type: 'object', $defs: { n: { type: 'object', properties: { next: { $ref: '#/$defs/n' } } } }, properties: { head: { $ref: '#/$defs/n' } } }, 'unsupported_ref', /recursive/);
    expectSchemaError({ type: 'object', $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } }, properties: { x: { $ref: '#/$defs/a' } } }, 'unsupported_ref', /recursive/);
    expectSchemaError({ type: 'object', properties: { self: { $ref: '#/properties/self' } } }, 'unsupported_ref', /recursive/);
  });

  it('rejects refs that do not resolve or do not point at a schema', () => {
    expectSchemaError({ type: 'object', properties: { a: { $ref: '#/$defs/missing' } } }, 'invalid_schema', /does not resolve/);
    expectSchemaError({ type: 'object', properties: { a: { $ref: '#/required/0' } }, required: ['a'] }, 'invalid_schema');
    expectSchemaError({ type: 'object', properties: { a: { $ref: '#/$defs/%E0%A4%A' } } }, 'invalid_schema');
  });

  it('stops exponential ref expansion ("billion laughs")', () => {
    const defs: Record<string, unknown> = { d9: { type: 'string' } };
    for (let i = 8; i >= 0; i--) {
      defs[`d${i}`] = { allOf: Array.from({ length: 6 }, () => ({ $ref: `#/$defs/d${i + 1}` })) };
    }
    expectSchemaError({ type: 'object', $defs: defs, properties: { boom: { $ref: '#/$defs/d0' } } }, 'schema_too_large');
  });

  it('counts properties reached through refs', () => {
    const props = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`p${i}`, { type: 'string' }]));
    const input = {
      type: 'object',
      $defs: { Block: { type: 'object', properties: props } },
      properties: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`b${i}`, { $ref: '#/$defs/Block' }])),
    };
    expectSchemaError(input, 'schema_too_large', /properties/);
  });
});

describe('normalizeSchema: limits and adversarial input', () => {
  it('rejects schemas larger than 64 KB', () => {
    expectSchemaError({ title: `string — ${'x'.repeat(70_000)}` }, 'schema_too_large');
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}`, `string — ${'d'.repeat(400)}`]));
    expectSchemaError(many, 'schema_too_large');
  });

  it('measures size in UTF-8 bytes', () => {
    // 25k chars of a 3-byte character: ~75 KB of UTF-8.
    expectSchemaError({ title: `string — ${'€'.repeat(25_000)}` }, 'schema_too_large');
  });

  it('accepts exactly the maximum depth and rejects one more level', () => {
    expect(() => normalizeSchema(nested(SCHEMA_LIMITS.maxDepth))).not.toThrow();
    expectSchemaError(nested(SCHEMA_LIMITS.maxDepth + 1), 'schema_too_deep');
  });

  it('rejects pathological JSON nesting without overflowing the stack', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 50_000; i++) deep = { a: deep };
    expectSchemaError(deep, 'schema_too_deep');
    let arrays: unknown = 'string';
    for (let i = 0; i < 50_000; i++) arrays = [arrays];
    expectSchemaError({ a: arrays }, 'schema_too_deep');
  });

  it('counts depth through shorthand nesting', () => {
    let value: Record<string, unknown> = { leaf: 'string' };
    for (let i = 0; i < SCHEMA_LIMITS.maxDepth; i++) value = { inner: value };
    expectSchemaError({ root: value }, 'schema_too_deep');
  });

  it('rejects more than 300 properties in total', () => {
    const ok = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}`, 'string']));
    expect(normalizeSchema(ok).fields).toHaveLength(300);
    const tooMany = Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`f${i}`, 'string']));
    expectSchemaError(tooMany, 'schema_too_large', /300/);
    // Nested properties count too.
    const nestedProps = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`o${i}`, { type: 'object', properties: Object.fromEntries(Array.from({ length: 15 }, (_, j) => [`p${j}`, { type: 'string' }])) }]),
      ),
    };
    expectSchemaError(nestedProps, 'schema_too_large');
  });

  it.each([
    ['(a+)+$'],
    ['(a*)*'],
    ['(a|a)*'],
    ['(.*)+'],
    ['^(\\w+\\s?)*$'],
    ['(.*,){12}x'],
  ])('rejects catastrophic pattern %j', (pattern) => {
    expectSchemaError({ type: 'object', properties: { a: { type: 'string', pattern } } }, 'unsafe_pattern');
  });

  it('rejects unsafe patternProperties keys and nested patterns', () => {
    expectSchemaError({ type: 'object', properties: { a: { type: 'object', patternProperties: { '(x+)+': { type: 'string' } } } } }, 'unsafe_pattern');
    expectSchemaError({ type: 'object', properties: { a: { type: 'object', propertyNames: { pattern: '(a|a)+' } } } }, 'unsafe_pattern');
    expectSchemaError({ type: 'array', items: { type: 'object', properties: { a: { type: 'array', items: { pattern: '(b*)*' } } } } }, 'unsafe_pattern');
  });

  it('rejects patterns over 256 chars and invalid patterns', () => {
    expectSchemaError({ type: 'object', properties: { a: { type: 'string', pattern: 'a'.repeat(257) } } }, 'unsafe_pattern', /256/);
    expectSchemaError({ type: 'object', patternProperties: { ['b'.repeat(300)]: {} }, properties: { a: {} } }, 'unsafe_pattern');
    expectSchemaError({ type: 'object', properties: { a: { type: 'string', pattern: '([a-z' } } }, 'invalid_schema', /regular expression/);
    expectSchemaError({ type: 'object', properties: { a: { type: 'string', pattern: 5 } } }, 'invalid_schema');
  });

  it('accepts ordinary patterns', () => {
    const s = normalizeSchema({
      type: 'object',
      properties: {
        sku: { type: 'string', pattern: '^[A-Z]{2}-\\d{4}$' },
        email: { type: 'string', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
        csv: { type: 'string', pattern: '^([^,]*,)*[^,]*$' },
      },
    });
    expect(validateOutput(s, { sku: 'AB-1234', email: 'a@b.co', csv: 'a,b,c' }).valid).toBe(true);
    expect(validateOutput(s, { sku: 'x' }).errors).toEqual(['/sku must match pattern "^[A-Z]{2}-\\d{4}$"']);
  });

  it.each([
    [{}],
    [{ type: 'object' }],
    [{ type: 'object', properties: {} }],
    [{ properties: {} }],
    [{ type: 'array', items: { type: 'object' } }],
    [{ type: 'object', properties: { list: { type: 'array', items: { type: 'object' } } } }],
  ])('rejects schemas without fields: %j', (input) => {
    expectSchemaError(input, 'empty_schema');
  });

  it.each([[null], [[]], ['string'], [42], [undefined], [[{ title: 'string' }]]])('rejects non-object input %j', (input) => {
    expectSchemaError(input, 'invalid_schema');
  });

  it('rejects non-JSON values', () => {
    expectSchemaError({ a: new Date() }, 'invalid_schema', /Date/);
    expectSchemaError({ a: () => 1 }, 'invalid_schema', /function/);
    expectSchemaError({ a: 10n }, 'invalid_schema', /bigint/);
    expectSchemaError({ a: Symbol('x') }, 'invalid_schema');
    expectSchemaError({ type: 'object', properties: { a: { type: 'number', maximum: Number.NaN } } }, 'invalid_schema', /non-finite/);
    expectSchemaError({ a: new Map() }, 'invalid_schema');
  });

  it('rejects "__proto__" keys anywhere', () => {
    expectSchemaError(JSON.parse('{"__proto__": "string"}'), 'invalid_schema', /__proto__/);
    expectSchemaError(JSON.parse('{"type":"object","properties":{"a":{"type":"object","properties":{"__proto__":{"type":"string"}}}}}'), 'invalid_schema');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('accepts other prototype-ish property names as ordinary fields', () => {
    const s = normalizeSchema({ constructor: 'string', toString: 'number', hasOwnProperty: 'boolean' });
    expect(s.fields.map((f) => f.type)).toEqual(['string', 'number', 'boolean']);
    expect(validateOutput(s, { constructor: 'x', toString: 1 }).valid).toBe(true);
    expect(validateOutput(s, {}).valid).toBe(true);
    const required = normalizeSchema({ type: 'object', properties: { valueOf: { type: 'string' } }, required: ['valueOf'] });
    expect(validateOutput(required, {}).errors).toEqual(["/ must have required property 'valueOf'"]);
  });

  it('strips $async so validation never returns a Promise', () => {
    const s = normalizeSchema({ $async: true, type: 'object', properties: { a: { type: 'number' } } });
    expect(s.jsonSchema.$async).toBeUndefined();
    expect(validateOutput(s, { a: 'x' }).valid).toBe(false);
  });

  it('rejects huge flat arrays and objects before walking them', () => {
    const t0 = performance.now();
    expectSchemaError({ type: 'object', properties: { a: { enum: new Array(1_000_000).fill(0) } } }, 'schema_too_large');
    expectSchemaError(Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, 0])), 'schema_too_large');
    expect(performance.now() - t0).toBeLessThan(1_000);
  });

  it('rejects cyclic input', () => {
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.properties = { self: cyclic };
    expectSchemaError(cyclic, 'schema_too_deep');
  });

  it('ignores undefined members like JSON.stringify does', () => {
    const s = normalizeSchema({ title: 'string', skip: undefined });
    expect(s.fields.map((f) => f.name)).toEqual(['title']);
  });

  it('rejects unknown type names and malformed keywords', () => {
    expectSchemaError({ type: 'object', properties: { a: { type: 'money' } } }, 'invalid_schema', /unknown type "money" at \/properties\/a\/type/);
    expectSchemaError({ type: 'object', properties: { a: { type: 5 } } }, 'invalid_schema');
    expectSchemaError({ type: 'object', properties: { a: { anyOf: [] } } }, 'invalid_schema', /non-empty array/);
    expectSchemaError({ type: 'object', properties: { a: { type: 'string' } }, required: 'a' }, 'invalid_schema', /not valid JSON Schema/);
    expectSchemaError({ type: 'object', properties: { a: { type: 'string', minLength: 'x' } } }, 'invalid_schema');
    expectSchemaError({ type: 'object', properties: 'nope', title: 'string' }, 'invalid_schema');
  });

  it('never aliases the caller-owned input', () => {
    const input = { type: 'object', properties: { a: { type: 'string', enum: ['x'] } } };
    const s = normalizeSchema(input);
    (input.properties.a.enum as string[]).push('y');
    input.properties.a.type = 'number';
    expect(field(s, 'a').schema).toEqual({ type: 'string', enum: ['x'] });
  });

  it('normalizes a large legal schema quickly', () => {
    const props = Object.fromEntries(
      Array.from({ length: 290 }, (_, i) => [`field_${i}`, { type: ['string', 'null'], description: `description ${i}`, maxLength: 200 }]),
    );
    const t0 = performance.now();
    const s = normalizeSchema({ type: 'object', properties: props });
    const elapsed = performance.now() - t0;
    expect(s.fields).toHaveLength(290);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('normalizeSchema: hash', () => {
  it('is 16 hex chars and independent of key order', () => {
    const a = normalizeSchema({ title: 'string', price: 'number' });
    const b = normalizeSchema({ price: 'number', title: 'string' });
    expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(a.hash).toBe(b.hash);
  });

  it('is computed over the original input', () => {
    const a = normalizeSchema({ title: 'string' });
    const b = normalizeSchema({ title: 'string — with a description' });
    const c = normalizeSchema({ type: 'object', properties: { b: { type: 'string' }, a: { type: 'number' } } });
    const d = normalizeSchema({ properties: { a: { type: 'number' }, b: { type: 'string' } }, type: 'object' });
    expect(a.hash).not.toBe(b.hash);
    expect(c.hash).toBe(d.hash);
  });

  it('distinguishes array order and nested values', () => {
    const a = normalizeSchema({ type: 'object', properties: { s: { enum: ['a', 'b'] } } });
    const b = normalizeSchema({ type: 'object', properties: { s: { enum: ['b', 'a'] } } });
    expect(a.hash).not.toBe(b.hash);
  });
});
