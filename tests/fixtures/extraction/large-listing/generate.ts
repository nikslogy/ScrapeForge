// Generates large-listing/page.html and gold.json: a single category page with
// 600 product cards (unique names and SKUs; some on sale, some unrated), plus a
// "Recently viewed" rail of cards that are not part of the listing.
//
// Page and gold come from the same deterministic data (seeded PRNG), and
// fixtures.test.ts checks that the committed files equal generate(). Regenerate with:
//   npx tsx tests/fixtures/extraction/large-listing/generate.ts

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCT_COUNT = 600;
const SEED = 0x1a26e600;

export interface ListingRecord {
  name: string;
  sku: string;
  price: number;
  rating: number | null;
}

interface Card extends ListingRecord {
  slug: string;
  compareAt: number | null;
  reviewCount: number;
  badge: 'new' | 'low-stock' | null;
}

const ADJECTIVES = [
  'Alpine', 'Summit', 'Trailhead', 'Coastal', 'Ridge', 'Canyon', 'Glacier', 'Timber', 'Harbor', 'Meadow', 'Basecamp', 'Northwind',
  'Granite', 'Cedar', 'Juniper', 'Sierra', 'Tundra', 'Prairie', 'Driftwood', 'Highland', 'Lakeshore', 'Redwood', 'Saltmarsh', 'Wildfern',
];
const MATERIALS = ['Merino', 'Canvas', 'Down', 'Fleece', 'Ripstop', 'Waxed Cotton', 'Titanium', 'Bamboo', 'Recycled Nylon', 'Cork', 'Leather', 'Insulated'];
const NOUNS = [
  'Beanie', 'Daypack', 'Jacket', 'Vest', 'Water Bottle', 'Camp Mug', 'Sleeping Bag', 'Hammock', 'Rain Shell', 'Base Layer Top',
  'Hiking Sock', 'Duffel', 'Headlamp Strap', 'Trucker Hat', 'Glove', 'Neck Gaiter', 'Tote', 'Stuff Sack', 'Camp Blanket', 'Chalk Bag',
  'Belt', 'Wallet', 'Pullover', 'Anorak', 'Field Shirt', 'Trail Short', 'Gaiter', 'Pack Cover', 'Seat Pad', 'Tarp',
];
const CENTS = [0.99, 0.95, 0.5, 0];

// Not part of the listing; SKUs are checked against the generated ones.
const RECENTLY_VIEWED = [
  { name: 'Field Notes Pocket Journal (3-Pack)', sku: 'HP-000417', price: 14.95, rating: 4.8 },
  { name: 'Packable Sun Hoodie', sku: 'HP-000926', price: 58, rating: 4.4 },
  { name: 'Collapsible Silicone Camp Bowl', sku: 'HP-000133', price: 12.5, rating: null },
];

/** mulberry32. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildCards(): Card[] {
  const rand = prng(SEED);
  const combos = ADJECTIVES.length * MATERIALS.length * NOUNS.length;
  // Partial Fisher-Yates over all name combinations: unique names by construction.
  const order = Array.from({ length: combos }, (_, i) => i);
  for (let i = 0; i < PRODUCT_COUNT; i++) {
    const j = i + Math.floor(rand() * (combos - i));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.slice(0, PRODUCT_COUNT).map((combo, i) => {
    const noun = NOUNS[combo % NOUNS.length];
    const material = MATERIALS[Math.floor(combo / NOUNS.length) % MATERIALS.length];
    const adjective = ADJECTIVES[Math.floor(combo / (NOUNS.length * MATERIALS.length))];
    const name = `${adjective} ${material} ${noun}`;
    // 104729 is prime and coprime with 900000, so i → SKU is injective for i < 900000.
    const sku = `HP-${((104729 * (i + 1)) % 900000) + 100000}`;
    const regular = round2(9 + Math.floor(rand() * 340) + CENTS[Math.floor(rand() * CENTS.length)]);
    const onSale = rand() < 1 / 6;
    const price = onSale ? round2(Math.floor(regular * (0.6 + rand() * 0.25)) + 0.99) : regular;
    const rated = rand() >= 0.14;
    const rating = rated ? round2(3 + Math.floor(rand() * 21) / 10) : null;
    const reviewCount = rated ? 1 + Math.floor(rand() * 2400) : 0;
    const b = rand();
    const badge = b < 0.05 ? 'new' : b < 0.1 ? 'low-stock' : null;
    return {
      name,
      sku,
      price,
      rating,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      compareAt: onSale && price < regular ? regular : null,
      reviewCount,
      badge,
    };
  });
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function stars(rating: number): string {
  const full = Math.round(rating);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

function cardHtml(c: Card, indent: string): string {
  const badges: string[] = [];
  if (c.compareAt !== null) badges.push(`<span class="badge badge--sale css-r8e2w1">Sale -${Math.round((1 - c.price / c.compareAt) * 100)}%</span>`);
  if (c.badge === 'new') badges.push('<span class="badge badge--new css-r8e2w1">New</span>');
  if (c.badge === 'low-stock') badges.push('<span class="badge badge--low css-r8e2w1">Only a few left</span>');
  const rating =
    c.rating === null
      ? '<div class="product-card__rating product-card__rating--empty">No reviews yet</div>'
      : `<div class="product-card__rating" aria-label="Rated ${c.rating} out of 5"><span class="stars" aria-hidden="true">${stars(c.rating)}</span> <span class="rating-value">${c.rating.toFixed(1)}</span> <span class="rating-count">(${c.reviewCount.toLocaleString('en-US')})</span></div>`;
  const price =
    c.compareAt === null
      ? `<span class="price">${money(c.price)}</span>`
      : `<span class="price price--sale">${money(c.price)}</span> <s class="price price--compare">${money(c.compareAt)}</s>`;
  const lines = [
    `<li class="grid__item css-k3j2h1">`,
    `  <article class="product-card css-9f8e7d" data-sku="${c.sku}">`,
    `    <a class="product-card__media" href="/products/${c.slug}" tabindex="-1"><img loading="lazy" src="/cdn/shop/products/${c.sku.toLowerCase()}_400x.jpg" alt="${c.name}" width="400" height="400"></a>`,
    badges.length > 0 ? `    <div class="product-card__badges">${badges.join(' ')}</div>` : '',
    `    <h3 class="product-card__title"><a href="/products/${c.slug}">${c.name}</a></h3>`,
    `    <p class="product-card__sku">SKU: ${c.sku}</p>`,
    `    ${rating}`,
    `    <div class="product-card__price">${price}</div>`,
    `    <button class="btn btn--add css-1a2b3c" type="button" data-sku="${c.sku}">Add to cart</button>`,
    `  </article>`,
    `</li>`,
  ];
  return lines.filter((l) => l !== '').map((l) => indent + l).join('\n');
}

export function generate(): { html: string; gold: ListingRecord[] } {
  const cards = buildCards();
  const skus = new Set(cards.map((c) => c.sku));
  if (skus.size !== cards.length) throw new Error('generated SKUs are not unique');
  for (const r of RECENTLY_VIEWED) if (skus.has(r.sku)) throw new Error(`recently viewed SKU ${r.sku} collides with the listing`);
  if (new Set(cards.map((c) => c.name)).size !== cards.length) throw new Error('generated names are not unique');

  const recent = RECENTLY_VIEWED.map((r) =>
    cardHtml({ ...r, slug: r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), compareAt: null, reviewCount: r.rating === null ? 0 : 57, badge: null }, '          '),
  ).join('\n');
  const under50 = cards.filter((c) => c.price < 50).length;
  const under150 = cards.filter((c) => c.price >= 50 && c.price < 150).length;
  const over150 = cards.length - under50 - under150;
  const onSale = cards.filter((c) => c.compareAt !== null).length;

  const html = `<!doctype html>
<html lang="en" class="js">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>All Gear &ndash; Harbor &amp; Pine Outfitters</title>
  <meta name="description" content="Shop all ${PRODUCT_COUNT} products from Harbor &amp; Pine Outfitters: packs, layers, camp kitchen and more.">
  <meta property="og:title" content="All Gear">
  <meta property="og:type" content="website">
  <link rel="canonical" href="https://www.harborandpine.com/collections/all-gear">
  <link rel="stylesheet" href="/cdn/shop/t/7/assets/base.css?v=6021">
  <script>window.Shopify = window.Shopify || {}; Shopify.shop = "harbor-and-pine.myshopify.com"; Shopify.currency = {"active":"USD","rate":"1.0"};</script>
  <script>window.dataLayer = window.dataLayer || []; dataLayer.push({"event":"view_item_list","item_list_id":"all-gear","items_count":${PRODUCT_COUNT}});</script>
</head>
<body class="template-collection">
  <div class="cookie-bar css-7c1x0z" role="dialog" aria-label="Cookie consent"><p>We use cookies to remember your cart and to understand how the store is used.</p><button type="button">Accept</button> <button type="button">Decline</button></div>
  <div class="announcement-bar">Free shipping on orders over $99 · Free returns within 30 days</div>
  <header class="header css-3f6h9j">
    <a class="header__logo" href="/">Harbor &amp; Pine Outfitters</a>
    <nav aria-label="Main"><a href="/collections/packs">Packs</a> <a href="/collections/apparel">Apparel</a> <a href="/collections/camp">Camp</a> <a href="/collections/sale">Sale</a> <a href="/pages/journal">Journal</a></nav>
    <a class="header__cart" href="/cart">Cart (0)</a>
  </header>
  <main id="MainContent" class="collection css-5k8m2n">
    <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <span>All Gear</span></nav>
    <h1 class="collection__title">All Gear</h1>
    <div class="collection__toolbar">
      <p class="collection__count">Showing 1&ndash;${PRODUCT_COUNT} of ${PRODUCT_COUNT} products</p>
      <label for="SortBy">Sort by</label>
      <select id="SortBy" name="sort_by"><option value="manual" selected>Featured</option><option value="price-ascending">Price, low to high</option><option value="price-descending">Price, high to low</option></select>
    </div>
    <div class="collection__layout">
      <aside class="facets css-0p2o4i" aria-label="Filters">
        <h2>Filter</h2>
        <fieldset><legend>Price</legend>
          <label><input type="checkbox" name="price" value="0-50"> Under $50 (${under50})</label>
          <label><input type="checkbox" name="price" value="50-150"> $50 &ndash; $150 (${under150})</label>
          <label><input type="checkbox" name="price" value="150-"> $150 and up (${over150})</label>
        </fieldset>
        <fieldset><legend>Deals</legend><label><input type="checkbox" name="sale" value="1"> On sale (${onSale})</label></fieldset>
        <section class="recently-viewed" aria-labelledby="rv-h">
          <h2 id="rv-h">Recently viewed</h2>
          <ul class="recently-viewed__list">
${recent}
          </ul>
        </section>
      </aside>
      <ul id="product-grid" class="grid product-grid css-2b4d6f" role="list">
${cards.map((c) => cardHtml(c, '        ')).join('\n')}
      </ul>
    </div>
  </main>
  <footer class="footer css-9a1s3d">
    <p>&copy; 2026 Harbor &amp; Pine Outfitters. Prices in USD.</p>
    <nav><a href="/policies/shipping-policy">Shipping</a> &middot; <a href="/policies/refund-policy">Returns</a> &middot; <a href="/policies/privacy-policy">Privacy</a></nav>
  </footer>
  <script src="/cdn/shop/t/7/assets/global.js?v=6021" defer></script>
</body>
</html>
`;
  const gold = cards.map(({ name, sku, price, rating }) => ({ name, sku, price, rating }));
  return { html, gold };
}

export function goldJson(gold: ListingRecord[]): string {
  return `${JSON.stringify(gold, null, 1)}\n`;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { html, gold } = generate();
  writeFileSync(new URL('./page.html', import.meta.url), html);
  writeFileSync(new URL('./gold.json', import.meta.url), goldJson(gold));
}
