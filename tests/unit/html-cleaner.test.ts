/* eslint-disable no-console */
// Sanity-check the small but critical transforms in html-cleaner.ts.
// Not wired into a runner — invoke with `npx tsx tests/unit/html-cleaner.test.ts`.
// Exits non-zero on any assertion failure.

import { pruneForLlm } from '../../apps/worker/src/extraction/html-cleaner.js';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok  ${name}`);
    pass++;
  } else {
    console.log(`  !!  ${name}${detail ? `  (${detail})` : ''}`);
    fail++;
  }
}

// 1. Rating class decode — the case that was silently returning 0 before
// the preservation + decode fix.
{
  console.log('\n── rating class decoding ──');
  const input = `
    <div class="product_main">
      <h1>Sapiens</h1>
      <p class="price_color">£54.23</p>
      <p class="instock availability">In stock (20 available)</p>
      <p class="star-rating Five"><i></i><i></i><i></i><i></i><i></i></p>
    </div>
  `;
  const pruned = pruneForLlm(input);
  check('preserves `star-rating` class', /star-rating/i.test(pruned), pruned);
  check('preserves `Five` word in class', /\bFive\b/.test(pruned), pruned);
  check(
    'injects explicit `Rating: 5/5` text',
    /Rating:\s*5\/5/.test(pruned),
    pruned,
  );
  check(
    'stamps data-rating-decoded="5"',
    /data-rating-decoded="5"/.test(pruned),
    pruned,
  );
}

// 2. "One" / "Two" should decode too (previous LLM-miss cases).
{
  console.log('\n── low ratings ──');
  const one = pruneForLlm('<p class="star-rating One"></p>');
  check('One → 1', /Rating:\s*1\/5/.test(one) && /data-rating-decoded="1"/.test(one), one);
  const two = pruneForLlm('<p class="star-rating Two"></p>');
  check('Two → 2', /Rating:\s*2\/5/.test(two) && /data-rating-decoded="2"/.test(two), two);
  const three = pruneForLlm('<p class="star-rating Three"></p>');
  check('Three → 3', /Rating:\s*3\/5/.test(three) && /data-rating-decoded="3"/.test(three), three);
  const four = pruneForLlm('<p class="star-rating Four"></p>');
  check('Four → 4', /Rating:\s*4\/5/.test(four) && /data-rating-decoded="4"/.test(four), four);
}

// 3. Element with semantic class but no text content must survive stage 3's
// empty-element sweep. This was the regression that made ratings invisible.
{
  console.log('\n── semantic-class preservation ──');
  const html = '<div><p class="star-rating Three"></p></div>';
  const pruned = pruneForLlm(html);
  check(
    'empty <p class="star-rating Three"> is not dropped',
    /star-rating/.test(pruned),
    pruned,
  );
}

// 4. Tailwind-style utility classes must be filtered out so we don't blow
// the token budget on non-semantic noise.
{
  console.log('\n── utility-class filtering ──');
  const pruned = pruneForLlm(
    '<div class="p-4 mx-auto bg-red-500 product-card featured">hi</div>',
  );
  check('keeps product-card', /product-card/.test(pruned), pruned);
  check('keeps featured', /featured/.test(pruned), pruned);
  check('drops p-4', !/\bp-4\b/.test(pruned), pruned);
  check('drops bg-red-500', !/bg-red-500/.test(pruned), pruned);
}

// 5. data-* attributes must survive.
{
  console.log('\n── data-* preservation ──');
  const pruned = pruneForLlm('<span data-sku="XY123" data-price="9.99">buy</span>');
  check('data-sku kept', /data-sku="XY123"/.test(pruned), pruned);
  check('data-price kept', /data-price="9.99"/.test(pruned), pruned);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
