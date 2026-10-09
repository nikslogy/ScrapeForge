// Object and array fields with boolean leaves: a boolean has no printed form,
// so it must not make the whole value "ungrounded"; and nested leaves are
// normalized by their own sub-schema types.

import { describe, expect, it } from 'vitest';
import type { FieldSpec } from '../../src/extract/types.js';
import { checkGrounding, normalizeValue } from '../../src/extract/validate/index.js';

const block = 'Wireless: Yes · Price $1,299.00';

describe('grounding of nested booleans', () => {
  it('an object with a boolean leaf next to grounded facts is grounded', () => {
    expect(checkGrounding({ wireless: true, price: 1299 }, { blockText: block })).toMatchObject({ grounded: true, where: 'block' });
  });

  it('a boolean whose key the page names is grounded by the key', () => {
    expect(checkGrounding({ wireless: true }, { blockText: block })).toMatchObject({ grounded: true, where: 'block' });
    expect(checkGrounding({ wireless: false }, { blockText: 'Wireless: No' })).toMatchObject({ grounded: true, where: 'block' });
  });

  it('camelCase keys are matched as words', () => {
    expect(checkGrounding({ freeShipping: true }, { blockText: 'Free shipping on all orders' })).toMatchObject({ grounded: true });
  });

  it('array items with a boolean leaf are grounded by their other values', () => {
    expect(checkGrounding([{ size: 'M', available: true }, { size: 'L', available: false }], { blockText: 'Sizes: M, L (sold out)' })).toMatchObject({
      grounded: true,
    });
  });

  it('booleans never ground invented facts next to them', () => {
    expect(checkGrounding({ wireless: true, price: 999 }, { blockText: block }).grounded).toBe(false);
  });

  it('an object of booleans the page says nothing about stays unverified', () => {
    const g = checkGrounding({ bluetooth: true }, { blockText: block });
    expect(g.grounded && g.where !== 'none').toBe(false);
  });
});

describe('normalization of nested leaves', () => {
  const specs: FieldSpec = {
    name: 'specs',
    type: 'object',
    required: true,
    nullable: false,
    derived: false,
    schema: { type: 'object', properties: { wireless: { type: 'boolean' }, price: { type: 'number' }, label: { type: 'string' } } },
  };
  const ctx = { baseUrl: 'https://shop.example.com/p/1' };

  it('converts printed leaves by their sub-schema types', () => {
    expect(normalizeValue({ wireless: 'Yes', price: '$1,299.00', label: '  Turbo  ' }, specs, ctx)).toMatchObject({
      ok: true,
      value: { wireless: true, price: 1299, label: 'Turbo' },
    });
  });

  it('keeps already typed leaves and unknown keys', () => {
    expect(normalizeValue({ wireless: true, price: 1299, extra: 'x' }, specs, ctx)).toMatchObject({ ok: true, value: { wireless: true, price: 1299, extra: 'x' } });
  });

  it('reports an unconvertible leaf with its path', () => {
    const r = normalizeValue({ wireless: 'Bluetooth 5.0', price: 1299 }, specs, ctx);
    expect(r).toMatchObject({ ok: false, reason: 'unparseable' });
    expect(r.ok ? '' : r.detail).toContain('wireless');
  });

  it('normalizes objects inside arrays', () => {
    const variants: FieldSpec = {
      name: 'variants',
      type: 'array',
      itemType: 'object',
      required: false,
      nullable: true,
      derived: false,
      schema: { type: 'array', items: { type: 'object', properties: { size: { type: 'string' }, available: { type: 'boolean' } } } },
    };
    expect(normalizeValue([{ size: 'M', available: 'In stock' }, { size: 'L', available: 'Sold out' }], variants, ctx)).toMatchObject({
      ok: true,
      value: [
        { size: 'M', available: true },
        { size: 'L', available: false },
      ],
    });
  });
});
