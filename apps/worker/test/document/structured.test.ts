import { describe, expect, it } from 'vitest';
import { DOCUMENT_LIMITS, buildSourceDocument, documentBuildInfo } from '../../src/extract/document/index.js';
import { cleanupJson, exceedsJsonDepth, parseJsonSafely } from '../../src/extract/document/json.js';
import { typeTail } from '../../src/extract/document/structured.js';
import type { StructuredDataItem } from '../../src/extract/types.js';
import { nextDataPage } from './fixtures.js';

function ld(json: string): string {
  return `<script type="application/ld+json">${json}</script>`;
}

function structuredOf(head: string, body = ''): StructuredDataItem[] {
  return buildSourceDocument(`<html><head>${head}</head><body>${body}</body></html>`, 'https://shop.example.com/p/1').structured;
}

describe('JSON-LD', () => {
  it('parses plain objects and flattens top-level arrays', () => {
    const items = structuredOf(ld('[{"@type":"Product","name":"A"},{"@type":"Organization","name":"B"}, 5, "x"]'));
    expect(items.map((i) => [i.source, i.type])).toEqual([['json-ld', 'Product'], ['json-ld', 'Organization']]);
  });

  it('flattens @graph and keeps a typed graph container', () => {
    const items = structuredOf(ld('{"@context":"https://schema.org","@type":"WebPage","name":"P","@graph":[{"@type":"Product"},{"@type":"Offer"}]}'));
    expect(items.map((i) => i.type)).toEqual(['WebPage', 'Product', 'Offer']);
    expect(items[0].data).not.toHaveProperty('@graph');
  });

  it('strips schema.org IRIs and array types down to the tail', () => {
    expect(typeTail('http://schema.org/Product')).toBe('Product');
    expect(typeTail(['https://schema.org/Book', 'Product'])).toBe('Book');
    expect(typeTail('schema:Offer')).toBe('Offer');
    expect(typeTail('https://schema.org/#Thing')).toBe('Thing');
    expect(typeTail(42)).toBeUndefined();
    expect(typeTail('')).toBeUndefined();
  });

  it('tolerates comment wrappers, trailing commas and raw newlines in strings', () => {
    const items = structuredOf([
      ld('<!-- {"@type":"Product","name":"Wrapped",} -->'),
      ld('//<![CDATA[\n{"@type":"Offer","price":"5",}\n//]]>'),
      ld('{"@type":"Article","headline":"Line one\nline two","tags":["a","b",],}'),
      ld('{"@type":"Event", <!-- inline comment --> "name":"E"}'),
    ].join(''));
    expect(items.map((i) => i.type)).toEqual(['Product', 'Offer', 'Article', 'Event']);
    expect((items[2].data as Record<string, unknown>).headline).toBe('Line one\nline two');
    expect((items[2].data as Record<string, unknown>).tags).toEqual(['a', 'b']);
  });

  it('skips hopeless JSON-LD and reports it', () => {
    const doc = buildSourceDocument(`<html><head>${ld('{"@type": "Product", name: unquoted}')}${ld('   ')}</head><body><p>ok</p></body></html>`, 'https://x.test/');
    expect(doc.structured).toEqual([]);
    expect(documentBuildInfo(doc).warnings.some((w) => w.startsWith('json_parse_failed: 1'))).toBe(true);
    expect(doc.text).toBe('ok');
  });

  it('never executes script content', () => {
    const g = globalThis as Record<string, unknown>;
    delete g.__pwned;
    structuredOf(ld('{"@type":"Thing","name":"x"}') + '<script>globalThis.__pwned = true</script><script type="application/ld+json">(function(){globalThis.__pwned=true})()</script>');
    expect(g.__pwned).toBeUndefined();
  });

  it('skips scripts over the size limit', () => {
    const big = `{"@type":"Product","pad":"${'x'.repeat(DOCUMENT_LIMITS.maxScriptChars)}"}`;
    const doc = buildSourceDocument(`<html><head>${ld(big)}${ld('{"@type":"Offer"}')}</head></html>`, 'https://x.test/');
    expect(doc.structured.map((s) => s.type)).toEqual(['Offer']);
    expect(documentBuildInfo(doc).warnings.some((w) => w.startsWith('script_too_large'))).toBe(true);
  });

  it('rejects absurdly deep JSON before it can break recursive consumers', () => {
    const deep = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
    const doc = buildSourceDocument(`<html><head>${ld(deep)}${ld(`{"@type":"Product","a":${'['.repeat(50)}1${']'.repeat(50)}}`)}</head></html>`, 'https://x.test/');
    expect(doc.structured.map((s) => s.type)).toEqual(['Product']);
    expect(() => JSON.stringify(doc)).not.toThrow();
  });

  it('caps the total number of structured items but keeps opengraph and meta', () => {
    const many = ld(JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ '@type': 'ListItem', position: i }))));
    const items = structuredOf(`${many}<meta property="og:title" content="T"><meta name="description" content="D">`);
    expect(items).toHaveLength(DOCUMENT_LIMITS.maxStructuredItems);
    expect(items.slice(-2).map((i) => i.source)).toEqual(['opengraph', 'meta']);
    expect(items.at(-1)?.id).toBe(`sd${DOCUMENT_LIMITS.maxStructuredItems - 1}`);
  });

  it('keeps a "__proto__" key as data when copying a typed @graph container', () => {
    const items = structuredOf(ld('{"@type":"WebPage","__proto__":{"polluted":true},"@graph":[{"@type":"Product"}]}'));
    const page = items[0].data as Record<string, unknown>;
    expect(Object.getPrototypeOf(page)).toBe(Object.prototype);
    expect(Object.hasOwn(page, '__proto__')).toBe(true);
    expect((page as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('accepts JSON-LD with a charset parameter and odd casing', () => {
    const items = structuredOf('<script type=" Application/LD+JSON; charset=utf-8 ">{"@type":"Recipe"}</script>');
    expect(items[0]?.type).toBe('Recipe');
  });

  it('is not fooled by __proto__ keys', () => {
    const items = structuredOf(ld('{"@type":"Product","__proto__":{"polluted":true}}'));
    expect(items[0].type).toBe('Product');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('embedded JSON', () => {
  const doc = buildSourceDocument(nextDataPage(), 'https://shop.example.com/p/trail-runner-3');

  it('parses __NEXT_DATA__ and other application/json scripts without executing JS', () => {
    const embedded = doc.structured.filter((s) => s.source === 'embedded-json');
    expect(embedded).toHaveLength(2);
    const next = embedded[0].data as { props: { pageProps: { product: { title: string; price: { amount: number } } } } };
    expect(next.props.pageProps.product.title).toBe('Trail Runner 3');
    expect(next.props.pageProps.product.price.amount).toBe(129.5);
    // Trailing comma tolerated in embedded JSON too.
    expect(embedded[1].data).toEqual({ featureFlags: { newCheckout: true } });
    expect(documentBuildInfo(doc).warnings.some((w) => w.startsWith('json_parse_failed: 1'))).toBe(true);
  });

  it('ignores JavaScript and import maps even when they look like JSON', () => {
    expect(JSON.stringify(doc.structured)).not.toContain('like json but is javascript');
    expect(JSON.stringify(doc.structured)).not.toContain('imports');
  });

  it('keeps visible content as blocks', () => {
    expect(doc.title).toBe('Trail Runner 3');
    expect(doc.blocks.map((b) => [b.kind, b.text])).toEqual([['heading', 'Trail Runner 3'], ['field', '$129.50']]);
  });
});

describe('microdata', () => {
  const body = `
    <div itemscope itemtype="https://schema.org/Product" itemid="urn:sku:1">
      <span itemprop="name">Kettle</span>
      <img itemprop="image" src="/img/kettle.jpg" alt="Kettle">
      <a itemprop="url" href="/p/kettle">link</a>
      <span itemprop="brand" itemscope itemtype="https://schema.org/Brand"><span itemprop="name">Acme</span></span>
      <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
        <meta itemprop="priceCurrency" content="EUR">
        <span itemprop="price" content="19.90">19,90 €</span>
        <link itemprop="availability" href="https://schema.org/InStock">
        <time itemprop="validFrom" datetime="2026-01-01">Jan 1</time>
      </div>
      <span itemprop="color">red</span><span itemprop="color">blue</span>
      <span itemprop="category keywords">  kitchen   tools </span>
      <div style="display:none" itemprop="description">Hidden but still machine data</div>
    </div>
    <div itemscope itemtype="https://schema.org/Review"><span itemprop="author">Bo</span></div>
    <span itemprop="orphan">no scope</span>
    <div itemscope></div>`;
  const items = structuredOf('', body).filter((s) => s.source === 'microdata');

  it('builds nested objects with typed values', () => {
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe('Product');
    expect(items[0].data).toEqual({
      '@type': 'Product',
      '@id': 'urn:sku:1',
      name: 'Kettle',
      image: 'https://shop.example.com/img/kettle.jpg',
      url: 'https://shop.example.com/p/kettle',
      brand: { '@type': 'Brand', name: 'Acme' },
      offers: {
        '@type': 'Offer',
        priceCurrency: 'EUR',
        price: '19.90',
        availability: 'https://schema.org/InStock',
        validFrom: '2026-01-01',
      },
      color: ['red', 'blue'],
      category: 'kitchen tools',
      keywords: 'kitchen tools',
      description: 'Hidden but still machine data',
    });
    expect(items[1]).toMatchObject({ type: 'Review', data: { '@type': 'Review', author: 'Bo' } });
  });

  it('treats property names like toString and constructor as plain data', () => {
    const md = structuredOf('', '<div itemscope><span itemprop="toString constructor">x</span><span itemprop="hasOwnProperty">y</span><span itemprop="__proto__">z</span></div>')
      .filter((s) => s.source === 'microdata');
    expect(md[0].data).toEqual({ toString: 'x', constructor: 'x', hasOwnProperty: 'y' });
    expect(JSON.stringify(md[0].data)).toBe('{"toString":"x","constructor":"x","hasOwnProperty":"y"}');
  });

  it('caps nesting depth without attaching deep props to outer items', () => {
    const depth = DOCUMENT_LIMITS.maxMicrodataDepth + 20;
    let html = '';
    for (let i = 0; i < depth; i++) html += `<div itemprop="child" itemscope itemtype="https://schema.org/T${i}"><span itemprop="level">${i}</span>`;
    html += '</div>'.repeat(depth);
    const top = structuredOf('', `<div itemscope itemtype="https://schema.org/Root">${html}</div>`).filter((s) => s.source === 'microdata');
    expect(top).toHaveLength(1);
    let node = top[0].data as Record<string, unknown>;
    let levels = 0;
    while (node.child) {
      expect(node.level === undefined || typeof node.level === 'string').toBe(true);
      node = node.child as Record<string, unknown>;
      levels++;
    }
    expect(levels).toBe(DOCUMENT_LIMITS.maxMicrodataDepth - 1);
    expect(() => JSON.stringify(top)).not.toThrow();
  });

  it('bounds text-valued properties on deeply nested itemprops', () => {
    const n = 3000;
    const nested = `<div itemscope>${'<div itemprop="p">t '.repeat(n)}${'</div>'.repeat(n)}</div>`;
    const t0 = performance.now();
    const md = structuredOf('', nested).filter((s) => s.source === 'microdata');
    expect(performance.now() - t0).toBeLessThan(5_000);
    const p = (md[0].data as Record<string, unknown>).p as string[];
    expect(p.length).toBeGreaterThan(0);
    expect(p.length).toBeLessThanOrEqual(100);
    for (const v of p) expect(v.length).toBeLessThanOrEqual(DOCUMENT_LIMITS.maxMicrodataTextChars);
  });
});

describe('OpenGraph and meta', () => {
  it('reads og:/product:/article: keys from property or name, first value wins', () => {
    const items = structuredOf(`
      <meta property="og:title" content=" First  title ">
      <meta property="og:title" content="Second title">
      <meta name="og:description" content="Desc via name">
      <meta property="article:published_time" content="2026-10-01T10:00:00Z">
      <meta property="twitter:card" content="summary">
      <meta property="og:empty" content="   ">
      <meta property="__proto__" content="x">
      <meta name="description" content="Standard description">
      <meta name="robots" content="index">
      <link rel="alternate canonical" href="https://shop.example.com/p/1?ref=x">`);
    expect(items.find((i) => i.source === 'opengraph')?.data).toEqual({
      'og:title': 'First title',
      'og:description': 'Desc via name',
      'article:published_time': '2026-10-01T10:00:00Z',
    });
    expect(items.find((i) => i.source === 'meta')?.data).toEqual({
      description: 'Standard description',
      canonical: 'https://shop.example.com/p/1?ref=x',
    });
  });

  it('emits nothing for pages without metadata', () => {
    expect(structuredOf('<title>t</title>', '<p>x</p>')).toEqual([]);
  });

  it('drops non-web canonical URLs', () => {
    const items = structuredOf('<link rel="canonical" href="javascript:alert(1)">');
    expect(items).toEqual([]);
  });
});

describe('JSON helpers', () => {
  it('cleans up trailing commas without touching string contents', () => {
    expect(JSON.parse(cleanupJson('{"a": "x, }", "b": [1, 2, ], }'))).toEqual({ a: 'x, }', b: [1, 2] });
    expect(JSON.parse(cleanupJson('{"a": "q\\"uote, ]",}'))).toEqual({ a: 'q"uote, ]' });
    expect(JSON.parse(cleanupJson('{"a": "<!-- not a comment -->"}'))).toEqual({ a: '<!-- not a comment -->' });
    expect(cleanupJson('{"a": 1 <!-- unterminated')).toBe('{"a": 1 ');
  });

  it('measures depth outside strings only', () => {
    expect(exceedsJsonDepth('[[[1]]]', 2)).toBe(true);
    expect(exceedsJsonDepth('[[[1]]]', 3)).toBe(false);
    expect(exceedsJsonDepth('{"a": "[[[[[[[["}', 1)).toBe(false);
    expect(exceedsJsonDepth('{"a": "\\"[[[["}', 1)).toBe(false);
  });

  it('parses strictly unless lenient', () => {
    expect(parseJsonSafely('{"a":1,}', 10, false)).toEqual({ ok: false });
    expect(parseJsonSafely('{"a":1,}', 10, true)).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonSafely('', 10, true)).toEqual({ ok: false });
    expect(parseJsonSafely('null', 10, true)).toEqual({ ok: true, value: null });
  });
});
