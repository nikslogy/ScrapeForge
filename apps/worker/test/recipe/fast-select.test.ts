import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { type DomElement, type DomNode, isElement } from '../../src/extract/recipe/dom.js';
import { compileFastSelector } from '../../src/extract/recipe/fast-select.js';
import { listingHtml, pdpHtml } from './fixtures.js';

/** All descendants of `scope` matching via the fast matcher, in document order. */
function fastAll(scope: DomNode, selector: string): DomNode[] {
  const fast = compileFastSelector(selector);
  if (!fast) throw new Error(`not fast: ${selector}`);
  const test = fast.within(scope);
  const out: DomNode[] = [];
  const walk = (node: DomNode): void => {
    for (const c of (node as DomNode & { children?: DomNode[] }).children ?? []) {
      if (!isElement(c)) continue;
      if (test(c)) out.push(c);
      walk(c);
    }
  };
  walk(scope);
  return out;
}

function cheerioAll($: cheerio.CheerioAPI, scope: DomNode, selector: string): DomNode[] {
  return $(scope as never).find(selector).toArray() as unknown as DomNode[];
}

const SELECTORS = [
  'p', 'P', 'p.price_color', 'h3 a', 'h3 > a', '> div', '> div > a', '> h3 > a', 'div a', 'article a', 'li a', 'body p',
  '*', 'a[title]', 'a[href]', '[class]', 'p[class="price_color"]', 'img[alt]', 'i', 'i:nth-child(2)', 'i:nth-of-type(2n+1)',
  'i:nth-last-child(1)', 'i:first-child', 'i:last-child', 'i:only-child', 'i:first-of-type', 'i:last-of-type',
  'i:only-of-type', 'li:nth-child(-n+3)', 'li:nth-child(odd)', 'li:nth-child(even)', 'li:nth-of-type(3)',
  'li:nth-last-of-type(2)', 'tr:nth-child(2) > td', 'tr:nth-child( 2n + 1 ) td', 'td', 'th + td', '.star-rating',
  '.Three', '.three', 'p.star-rating.Three', '.instock.availability', 'div.product_price p', 'div div p', 'ul li a',
  '#product_description', 'div#product_description', 'button[type="SUBMIT"]', 'button[type=submit]',
  'button[data-loading-text="Adding..."]', 'form button', 'section ol li article h3 a',
];

describe('compileFastSelector', () => {
  it('declines selectors outside the fast subset', () => {
    for (const sel of ['a, b', 'a + b', 'a ~ b', 'a:not(.x)', 'a:is(.x)', 'li:has(a)', '[href^="x"]', '[x="a" i]', 'a\\:b', '', ':scope > a', 'a b c d e f g', 'p:empty']) {
      expect(compileFastSelector(sel), sel).toBeNull();
    }
  });

  it('matches exactly what cheerio find() returns (listing and product pages)', () => {
    for (const html of [listingHtml(), pdpHtml()]) {
      const $ = cheerio.load(html);
      const scopes: DomNode[] = [
        $.root()[0] as unknown as DomNode,
        ...($('article, div, li, ol, section, table, tr, form').toArray() as unknown as DomNode[]).slice(0, 60),
      ];
      for (const sel of SELECTORS) {
        if (!compileFastSelector(sel)) continue;
        for (const scope of scopes) {
          expect(fastAll(scope, sel), `${sel} in <${(scope as DomElement).name ?? 'root'}>`).toEqual(cheerioAll($, scope, sel));
        }
      }
    }
  });

  it('matches cheerio on case rules for tags, ids, classes and attribute values', () => {
    const $ = cheerio.load('<div><p class="x X" data-x="A" id="Main" TYPE="Submit" lang="EN" rel="NoFollow">a</p><input type="TEXT"><P>b</P></div>');
    const scope = $('div')[0] as unknown as DomNode;
    for (const sel of ['[CLASS]', '[Data-X]', 'P.x', 'p.X', '#Main', '#main', '[data-x="a"]', '[data-x="A"]', '[type="submit"]', '[lang="en"]', '[rel=nofollow]', 'input[type=text]', 'DIV P', '[ID=Main]', 'p', '[constructor]', '[__proto__]']) {
      expect(fastAll(scope, sel), sel).toEqual(cheerioAll($, scope, sel));
    }
  });

  it('agrees with cheerio on random trees and random selectors', () => {
    let seed = 12345;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const tags = ['div', 'p', 'span', 'a', 'li', 'ul'];
    const classes = ['x', 'y', 'z', 'X'];
    const build = (depth: number): string => {
      const n = depth > 4 ? 0 : rand(4);
      let out = '';
      for (let i = 0; i < n; i++) {
        const tag = tags[rand(tags.length)];
        const cls = rand(2) ? ` class="${classes[rand(4)]}${rand(2) ? ` ${classes[rand(4)]}` : ''}"` : '';
        const attr = rand(3) === 0 ? ` data-k="${rand(3)}"` : '';
        out += rand(3) === 0 ? 'text ' : '';
        out += `<${tag}${cls}${attr}>${build(depth + 1)}</${tag}>`;
      }
      return out;
    };
    const compound = (): string => {
      let s = rand(3) ? tags[rand(tags.length)] : '';
      if (rand(2)) s += `.${classes[rand(4)]}`;
      if (rand(4) === 0) s += `[data-k${rand(2) ? `="${rand(3)}"` : ''}]`;
      if (rand(5) === 0) s += [':first-child', ':last-child', ':nth-child(2n+1)', ':nth-of-type(2)', ':only-child'][rand(5)];
      return s || '*';
    };
    for (let doc = 0; doc < 25; doc++) {
      const $ = cheerio.load(`<div id="root">${build(0)}${build(0)}</div>`);
      const scopes = $('#root, #root *').toArray().slice(0, 30) as unknown as DomNode[];
      for (let q = 0; q < 40; q++) {
        const parts = Array.from({ length: 1 + rand(3) }, compound);
        let sel = rand(4) === 0 ? '> ' : '';
        parts.forEach((p, i) => {
          sel += i === 0 ? p : `${rand(2) ? ' > ' : ' '}${p}`;
        });
        for (const scope of scopes) {
          expect(fastAll(scope, sel), sel).toEqual(cheerioAll($, scope, sel));
        }
      }
    }
  });
});
