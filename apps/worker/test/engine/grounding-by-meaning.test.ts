// Live benchmark finding: GPT-5 Nano answered a rating the page shows only
// as class="star-rating Three" with "3", and "In stock" with "true". Both
// are correct, but neither text is on the page, so they were rejected. The
// engine now accepts a number or boolean when a short text of the cited
// block (or its record's attributes) converts to exactly the same value.

import { describe, expect, it } from 'vitest';
import { buildSourceDocument } from '../../src/extract/document/index.js';
import { extractStructured } from '../../src/extract/index.js';
import { blockId, fakeClient, page, request } from './helpers.js';

const html = page(`<main>
  <h1>A Light in the Attic</h1>
  <p class="price_color">£51.77</p>
  <p class="instock availability">In stock (22 available)</p>
  <p class="star-rating Three"><i class="icon-star"></i></p>
  <p class="note">Ships in 2 days</p>
</main>`);
const SCHEMA = { title: 'string', rating: 'number — stars 1-5', inStock: 'boolean', days: 'integer — shipping days' };
const bTitle = blockId(html, 'A Light in the Attic');
const bStock = blockId(html, 'In stock (22 available)');
const bShip = blockId(html, 'Ships in 2 days');

function ratingBlock(): string {
  // The rating has no text: it is the attribute-only field block.
  const { blocks } = buildSourceDocument(html, 'https://shop.example.com/products/widget');
  const hit = blocks.find((b) => b.attrs?.class?.includes('star-rating'));
  if (!hit) throw new Error('no rating block');
  return hit.id as string;
}

async function run(answer: Record<string, { v: unknown; b: string | null }>) {
  const { client } = fakeClient(() => ({ text: JSON.stringify({ records: [answer] }), finishReason: 'stop', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 }));
  return extractStructured(request(html, SCHEMA), { modelClient: client, recipeStore: null, learning: 'off' });
}

describe('grounding numbers and booleans by meaning', () => {
  it('accepts "3" for a class-only "Three" rating and "true" for "In stock"', async () => {
    const out = await run({
      title: { v: 'A Light in the Attic', b: bTitle },
      rating: { v: '3', b: ratingBlock() },
      inStock: { v: 'true', b: bStock },
      days: { v: '2', b: bShip },
    });
    expect(out.data).toEqual({ title: 'A Light in the Attic', rating: 3, inStock: true, days: 2 });
    expect(out.status).toBe('complete');
    expect(out.warnings).toContain('grounded_by_meaning');
    const rating = out.evidence.find((e) => e.path === '/rating');
    expect(rating?.grounded).toBe(true);
    expect(rating?.note).toMatch(/matched by meaning: ".*Three"/);
  });

  it('still rejects values whose meaning differs from the cited block', async () => {
    const out = await run({
      title: { v: 'A Light in the Attic', b: bTitle },
      rating: { v: '4', b: ratingBlock() },
      inStock: { v: 'false', b: bStock },
      days: { v: '5', b: bShip },
    });
    expect(out.data).toMatchObject({ rating: null, inStock: null, days: null });
    expect(out.missing.filter((m) => m.reason === 'rejected_ungrounded').map((m) => m.path).sort()).toEqual(['/days', '/inStock', '/rating']);
    expect(out.status).toBe('partial');
  });

  it('does not match strings by meaning', async () => {
    const out = await run({
      title: { v: 'A light in an attic', b: bTitle },
      rating: { v: null, b: null },
      inStock: { v: 'In stock', b: bStock },
      days: { v: null, b: null },
    });
    expect(out.data).toMatchObject({ title: null, inStock: true });
    expect(out.missing.find((m) => m.path === '/title')?.reason).toBe('rejected_ungrounded');
  });

  it('needs a citation: an uncited "true" is not matched against arbitrary text', async () => {
    const out = await run({
      title: { v: 'A Light in the Attic', b: bTitle },
      rating: { v: null, b: null },
      inStock: { v: 'true', b: null },
      days: { v: null, b: null },
    });
    expect(out.data).toMatchObject({ title: 'A Light in the Attic', inStock: null });
  });
});
