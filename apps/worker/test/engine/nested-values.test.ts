// Engine level: object/array fields with boolean leaves are accepted when the
// facts are on the page (they used to be rejected as ungrounded every time).

import { describe, expect, it } from 'vitest';
import { extractStructured } from '../../src/extract/index.js';
import { blockId, fakeClient, page, request } from './helpers.js';

const html = page(`<main><h1>Acme Turbo Widget</h1><p class="price">$1,299.00</p><p class="stock">In stock</p><p>Wireless: Yes</p></main>`);
const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    specs: { type: 'object', properties: { wireless: { type: 'boolean' }, price: { type: 'number' } } },
  },
  required: ['name', 'specs'],
};

describe('nested boolean leaves', () => {
  for (const [label, specs] of [
    ['typed booleans', { wireless: true, price: 1299 }],
    ['printed values', { wireless: 'Yes', price: '$1,299.00' }],
  ] as const) {
    it(`an object field with a boolean leaf is kept (${label})`, async () => {
      const bName = blockId(html, 'Acme Turbo Widget');
      const bW = blockId(html, 'Wireless: Yes');
      const { client } = fakeClient(() => ({
        text: JSON.stringify({ records: [{ name: { v: 'Acme Turbo Widget', b: bName }, specs: { v: specs, b: bW } }] }),
        finishReason: 'stop',
        inputTokens: 10,
        outputTokens: 10,
        costUsd: 0.0001,
        latencyMs: 1,
      }));
      const out = await extractStructured(request(html, schema), { modelClient: client, recipeStore: null, learning: 'off' });
      expect(out.data).toEqual({ name: 'Acme Turbo Widget', specs: { wireless: true, price: 1299 } });
      expect(out.status).toBe('complete');
      expect(out.schemaValid).toBe(true);
    });
  }
});
