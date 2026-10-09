// Thin client-rendered shells must not pass as "complete short pages": the
// server sent header/footer chrome (and maybe a spinner or skeleton in the
// app's mount point, or site-wide JSON-LD) while the content is rendered by
// scripts. Accepted at T1, such a page is learned as good and the browser is
// never used for the site.
import { describe, expect, it } from 'vitest';
import { assessTier } from '../../src/engine/router.js';
import { analyzeHtml, calculateQualityScore } from '../../src/extraction/quality-scorer.js';

const URL_ = 'https://www.acme.example/p/1';
const gate = (html: string) => assessTier(html, 200, 1, 100, URL_);

// Realistic 1–1.3 KB SPA chrome: head with a module bundle, logo + nav, copyright footer.
const HEAD =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Trail Tent 2 – Acme Outdoor</title><meta name="description" content="Shop the Trail Tent 2 at Acme Outdoor Supply Company.">' +
  '<meta property="og:title" content="Trail Tent 2"><meta property="og:image" content="https://cdn.acme.example/og/tt2.jpg">' +
  '<link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest">' +
  '<link rel="preconnect" href="https://api.acme.example"><link rel="stylesheet" href="/assets/index-a81c3f.css">' +
  '<script type="module" crossorigin src="/assets/index-3f2a1b.js"></script></head><body>' +
  '<header class="site-header"><a class="logo" href="/">Acme Outdoor Supply Company</a><nav class="main-nav"><a href="/tents">Tents</a><a href="/packs">Packs</a><a href="/sale">Sale</a></nav></header>';
const FOOT = '<footer class="site-footer"><p>© 2026 Acme Outdoor Supply Company. All rights reserved.</p></footer></body></html>';

const CSS = '<style>body{font-family:system-ui,sans-serif;margin:3em auto;max-width:42em;color:#222}' +
  'h1{font-size:1.6em}a{color:#36c}footer{color:#777;font-size:.8em}</style>';
const head2 = `<!doctype html><html><head><title>Shop</title>${CSS}<script type="module" src="/assets/index-3f2a1b.js"></script></head><body><header><a href="/">Acme Outdoor Supply Company</a></header>`;
const foot2 = '<footer>© 2026 Acme Outdoor Supply Company. All rights reserved.</footer></body></html>';

const ORG_JSONLD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Acme Outdoor',
  url: 'https://www.acme.example',
  logo: 'https://www.acme.example/logo.png',
  sameAs: Array.from({ length: 14 }, (_, i) => `https://social-network-${i}.example.com/acme-official-account`),
  contactPoint: { '@type': 'ContactPoint', telephone: '+1-800-440-0680', contactType: 'customer service' },
});
const PRODUCT_JSONLD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Trail Tent 2',
  sku: 'TT2-GRN',
  description: 'A two-person, three-season backpacking tent with two doors, two vestibules and a 1.4 kg trail weight.',
  image: Array.from({ length: 8 }, (_, i) => `https://cdn.acme.example/media/tt2/${i}.jpg`),
  offers: { '@type': 'Offer', price: '199.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
  additionalProperty: Array.from({ length: 6 }, (_, i) => ({ '@type': 'PropertyValue', name: `spec ${i}`, value: `value ${i}` })),
});
const SKELETON = '<div class="Skeleton_block__k2P9d"><div class="Skeleton_line__w9E8r"></div></div>'.repeat(10);

const SHELLS: Record<string, string> = {
  'custom mount id, empty': `${HEAD}<div id="product-app"></div>${FOOT}`,
  '#root with a spinner child': `${HEAD}<div id="root"><div class="spinner" role="progressbar"></div></div>${FOOT}`,
  '#app with skeleton children': `${HEAD}<div id="app">${'<div class="skeleton-line"></div>'.repeat(8)}</div>${FOOT}`,
  '#app with a spinner child (small chrome)': `${head2}<div id="app"><div class="spinner"></div></div>${foot2}`,
  'mount id #main-content': `${head2}<div id="main-content"></div>${foot2}`,
  '#app holding only <noscript>': `${head2}<div id="app"><noscript>Enable JS</noscript></div>${foot2}`,
  'chrome + skeleton + site-wide JSON-LD': `<!doctype html><html><head><title>Trail Tent 2</title><script type="application/ld+json">${ORG_JSONLD}</script><script src="/_next/static/chunks/main.js" defer></script></head><body><div id="__next"><header><a href="/">Acme Outdoor</a></header><main>${SKELETON}</main><footer><p>© 2026 Acme Outdoor Supply Company. All rights reserved.</p></footer></div></body></html>`,
};

describe('client-rendered shells with server-rendered chrome', () => {
  it.each(Object.entries(SHELLS))('%s is rejected', (_name, html) => {
    const v = gate(html);
    expect(v.ok, JSON.stringify(calculateQualityScore(html, 200, 1, 100).signals)).toBe(false);
    expect(v.score).toBeLessThan(0.55);
  });

  it('a skeleton beside a little content is not rescued by site-wide JSON-LD, but is by page data', () => {
    const body = (data: string) =>
      `<!doctype html><html><head><title>Trail Tent 2</title><script type="application/ld+json">${data}</script>` +
      `<script src="/static/app.js" defer></script></head><body><main><h1>Trail Tent 2</h1><p>Two-person backpacking tent, $199.00 with free shipping.</p>` +
      `${'<div class="placeholder-block"><div class="placeholder-line"></div></div>'.repeat(60)}</main></body></html>`;
    expect(gate(body(ORG_JSONLD)).ok).toBe(false);
    expect(gate(body(PRODUCT_JSONLD)).ok).toBe(true);
  });

  it('measures the text outside site chrome', () => {
    const a = analyzeHtml(
      '<header><a href="/">Logo</a><div><header>Nested</header>More</div></header><nav><a href="/x">One</a></nav>' +
        '<main><header><h1>Title</h1></header><p>Body text</p><footer>Posted today</footer></main>' +
        '<div role="contentinfo"><div>©</div> 2026</div><img role="banner" src="/b.png"><p>After</p><footer>Foot</footer>',
    );
    expect(a.mainTextLen).toBe('Title Body text Posted today After'.length);
    expect(a.textLen).toBeGreaterThan(a.mainTextLen);
  });

  it('a loading placeholder in the mount point is unfinished unless page data came with it', () => {
    const page = (extra: string) =>
      `<!doctype html><html><head><title>Trail Tent 2</title><script defer src="/static/js/main.js"></script></head><body>` +
      '<div id="root"><h1>Trail Tent 2</h1><p>Two-person backpacking tent with two doors and two vestibules.</p>' +
      `<div class="pdp-gallery" aria-busy="true"></div></div>${extra}</body></html>`;
    expect(analyzeHtml(page('')).loadingMountPoint).toBe(true);
    const v = gate(page(''));
    expect(v.ok).toBe(false);
    expect(v.ok ? '' : v.reason).toContain('Loading placeholder in the app mount point');
    expect(gate(page(`<script type="application/ld+json">${PRODUCT_JSONLD}</script>`)).ok).toBe(true);
    // The same markup outside a mount point is not judged a loading app.
    expect(analyzeHtml(page('').replace('id="root"', 'class="wrap"')).loadingMountPoint).toBe(false);
    for (const attrs of ['class="Spinner--lg"', 'role="progressbar"', "aria-busy='true'", 'class="pdp skeleton"']) {
      expect(analyzeHtml(`<div id="app"><div ${attrs}></div></div>`).loadingMountPoint, attrs).toBe(true);
    }
    expect(analyzeHtml('<div id="app"></div><div class="spinner"></div>').loadingMountPoint).toBe(false);
  });

  it('site scaffolding JSON-LD is not page data; entities are', () => {
    const ld = (data: unknown) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
    expect(analyzeHtml(ld(JSON.parse(ORG_JSONLD))).dataBytes).toBe(0);
    expect(analyzeHtml(ld({ '@context': 'https://schema.org', '@type': ['WebSite'], url: 'https://x.example', potentialAction: { '@type': 'SearchAction' } })).dataBytes).toBe(0);
    const yoast = { '@context': 'https://schema.org', '@graph': [{ '@type': 'CollectionPage' }, { '@type': 'BreadcrumbList' }, { '@type': 'WebSite' }, { '@type': 'Organization' }, { '@type': 'ImageObject' }] };
    expect(analyzeHtml(ld(yoast)).dataBytes).toBe(0);
    const withArticle = { ...yoast, '@graph': [...yoast['@graph'], { '@type': 'Article', headline: 'x' }] };
    expect(analyzeHtml(ld(withArticle)).dataBytes).toBe(JSON.stringify(withArticle).length);
    expect(analyzeHtml(ld(JSON.parse(PRODUCT_JSONLD))).dataBytes).toBe(PRODUCT_JSONLD.length);
    // Unreadable JSON-LD and other JSON data still count.
    expect(analyzeHtml('<script type="application/ld+json">{"@type":"Organization",}</script>').dataBytes).toBe('{"@type":"Organization",}'.length);
    expect(analyzeHtml('<script type="application/json">{"@type":"Organization"}</script>').dataBytes).toBe('{"@type":"Organization"}'.length);
  });
});

describe('thin server-rendered pages that run scripts stay accepted', () => {
  it.each([
    ['content in main between header and footer', `${HEAD}<main><h1>Trail Tent 2</h1><p>Two-person backpacking tent with two doors, $199.00.</p></main>${FOOT}`],
    ['content in a plain div', `${head2}<div class="content"><h1>Opening hours</h1><p>Monday to Friday from nine until half past five.</p></div>${foot2}`],
    ['an article header is content, not site chrome', `${head2}<article><header><h1>Release notes 2.4</h1><p>Published 3 March 2026 by the core team.</p></header><p>Fixed a crash.</p></article>${foot2}`],
    ['a filled mount point with header and footer inside', `<!doctype html><html><head><title>Changelog</title><script defer src="/static/js/main.js"></script></head><body><div id="root"><header><a href="/">Acme</a></header><main><h1>Changelog</h1><p>Version 3.2 adds dark mode, faster search and offline drafts.</p></main><footer>© 2026 Acme</footer></div></body></html>`],
    ['a spinner outside the mount point', `${head2}<div class="page-loader"></div><main><h1>Opening hours</h1><p>Monday to Friday from nine until half past five.</p></main>${foot2}`],
  ])('%s', (_name, html) => {
    expect(gate(html)).toEqual({ ok: true, score: expect.any(Number) });
  });
});
