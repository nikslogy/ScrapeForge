// The small but critical transforms in html-cleaner.ts that feed the LLM.
// Converted from the hand-rolled script that lived at tests/unit/html-cleaner.test.ts.
import { describe, expect, it } from 'vitest';
import { pruneForLlm } from '../../src/extraction/html-cleaner.js';

describe('pruneForLlm', () => {
  describe('rating class decoding', () => {
    // The case that silently returned 0 before the preservation + decode fix.
    const pruned = pruneForLlm(`
      <div class="product_main">
        <h1>Sapiens</h1>
        <p class="price_color">£54.23</p>
        <p class="instock availability">In stock (20 available)</p>
        <p class="star-rating Five"><i></i><i></i><i></i><i></i><i></i></p>
      </div>
    `);

    it('preserves the star-rating class', () => {
      expect(pruned).toMatch(/star-rating/i);
    });

    it('preserves the rating word in the class', () => {
      expect(pruned).toMatch(/\bFive\b/);
    });

    it('injects explicit "Rating: 5/5" text', () => {
      expect(pruned).toMatch(/Rating:\s*5\/5/);
    });

    it('stamps data-rating-decoded="5"', () => {
      expect(pruned).toMatch(/data-rating-decoded="5"/);
    });
  });

  describe('low ratings', () => {
    // Previous LLM-miss cases.
    it.each([
      ['One', 1],
      ['Two', 2],
      ['Three', 3],
      ['Four', 4],
    ])('%s decodes to %i', (word, n) => {
      const pruned = pruneForLlm(`<p class="star-rating ${word}"></p>`);
      expect(pruned).toMatch(new RegExp(`Rating:\\s*${n}/5`));
      expect(pruned).toMatch(new RegExp(`data-rating-decoded="${n}"`));
    });
  });

  describe('semantic-class preservation', () => {
    // An element with a semantic class but no text must survive the
    // empty-element sweep; dropping it made ratings invisible.
    it('keeps an empty <p class="star-rating Three">', () => {
      expect(pruneForLlm('<div><p class="star-rating Three"></p></div>')).toMatch(/star-rating/);
    });
  });

  describe('utility-class filtering', () => {
    // Tailwind-style utility classes would blow the token budget on noise.
    const pruned = pruneForLlm(
      '<div class="p-4 mx-auto bg-red-500 product-card featured">hi</div>',
    );

    it('keeps semantic classes', () => {
      expect(pruned).toMatch(/product-card/);
      expect(pruned).toMatch(/featured/);
    });

    it('drops utility classes', () => {
      expect(pruned).not.toMatch(/\bp-4\b/);
      expect(pruned).not.toMatch(/bg-red-500/);
    });
  });

  describe('data-* preservation', () => {
    it('keeps data-* attributes', () => {
      const pruned = pruneForLlm('<span data-sku="XY123" data-price="9.99">buy</span>');
      expect(pruned).toMatch(/data-sku="XY123"/);
      expect(pruned).toMatch(/data-price="9.99"/);
    });
  });
});
