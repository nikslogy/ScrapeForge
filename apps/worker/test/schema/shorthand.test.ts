import { describe, expect, it } from 'vitest';
import { aliasForType, parseShorthandString, typeWordSchema } from '../../src/extract/schema/shorthand.js';

describe('parseShorthandString', () => {
  it.each([
    ['string — the book title', { type: 'string', description: 'the book title' }],
    ['number – price', { type: 'number', description: 'price' }],
    ['integer - count', { type: 'integer', description: 'count' }],
    ['integer -- count', { type: 'integer', description: 'count' }],
    ['boolean: in stock?', { type: 'boolean', description: 'in stock?' }],
    ['url', { type: 'string', format: 'uri' }],
    ['  url  ', { type: 'string', format: 'uri' }],
    ['date-time', { type: 'string', format: 'date-time' }],
    ['string[] — tags', { type: 'array', items: { type: 'string' }, description: 'tags' }],
    ['list<int>', { type: 'array', items: { type: 'integer' } }],
    ['any — whatever', { description: 'whatever' }],
    ['string —', { type: 'string' }],
    ['', { type: 'string' }],
  ])('%j', (input, schema) => {
    expect(parseShorthandString(input).schema).toEqual(schema);
  });

  it('splits on the earliest separator only', () => {
    expect(parseShorthandString('url: see https://example.com — docs').schema).toEqual({
      type: 'string',
      format: 'uri',
      description: 'see https://example.com — docs',
    });
  });

  it('does not treat a hyphen inside a word as a separator', () => {
    expect(parseShorthandString('string-ish value').schema).toEqual({ type: 'string', description: 'string-ish value' });
  });

  it('falls back to a described string for unknown types', () => {
    expect(parseShorthandString('money — amount')).toEqual({
      schema: { type: 'string', description: 'money — amount' },
      description: 'money — amount',
    });
    expect(parseShorthandString('array<money>').schema).toEqual({ type: 'string', description: 'array<money>' });
  });

  it('stays linear on long whitespace runs', () => {
    const input = `string${' '.repeat(60_000)}x`;
    const t0 = performance.now();
    parseShorthandString(input);
    parseShorthandString(`(${' '.repeat(60_000)}`);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe('type words', () => {
  it('returns fresh objects', () => {
    const a = typeWordSchema('url')!;
    a.format = 'mutated';
    expect(typeWordSchema('url')).toEqual({ type: 'string', format: 'uri' });
  });

  it('maps aliases to JSON types and formats', () => {
    expect(aliasForType('Float')).toEqual({ type: 'number' });
    expect(aliasForType('link')).toEqual({ type: 'string', format: 'uri' });
    expect(aliasForType('null')).toEqual({ type: 'null' });
    expect(aliasForType('any')).toBeNull();
    expect(aliasForType('constructor')).toBeNull();
    expect(aliasForType('__proto__')).toBeNull();
    expect(typeWordSchema('toString')).toBeNull();
    expect(typeWordSchema('constructor')).toBeNull();
    expect(typeWordSchema('valueOf')).toBeNull();
    expect(parseShorthandString('constructor — x').schema).toEqual({ type: 'string', description: 'constructor — x' });
  });
});
