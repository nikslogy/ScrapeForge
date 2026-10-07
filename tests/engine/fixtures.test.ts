// Integrity checks for the offline extraction corpus (tests/fixtures/extraction).
//
// These guard the labels, not the engine: every fixture loads, its schema is
// one the engine accepts with the declared shape, gold uses exactly the schema's
// fields and validates against it, and every non-derived gold value can be
// found on the page a human would see (or, for fields declared nonVisible, in
// the raw markup). A typo in gold.json or a decoy value labelled by mistake
// fails here before it can skew an accuracy number.

import * as cheerio from 'cheerio';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeSchema } from '../../apps/worker/src/extract/schema/index.js';
import { validateOutput } from '../../apps/worker/src/extract/validate/index.js';
import { generate as generateLargeListing, goldJson, PRODUCT_COUNT } from '../fixtures/extraction/large-listing/generate.js';
import { buildFixture, FIXTURES_DIR, fixtureIds, loadFixture, loadFixtures, type Fixture } from '../fixtures/extraction/load.js';
import { generatePage as generateValueAtEnd, LICENSE, VERSION } from '../fixtures/extraction/value-at-end/generate.js';
import { isAbsoluteHttpUrl, normalizeText, normalizeUrl, scalarKey, schemaFields, scoreExtraction } from './scoring.js';

const EXPECTED_IDS = [
  'book-pdp-jsonld',
  'book-pdp-plain',
  'books-listing',
  'electronics-pdp-sale',
  'saas-pricing',
  'news-article',
  'specs-comparison-table',
  'job-posting',
  'prompt-injection',
  'challenge-page',
  'missing-fields',
  'multilingual-de',
  'next-data',
  'value-at-end',
  'large-listing',
];

const fixtures = loadFixtures();
const byId = new Map(fixtures.map((f) => [f.id, f]));

function fixture(id: string): Fixture {
  const f = byId.get(id);
  if (!f) throw new Error(`fixture ${id} not loaded`);
  return f;
}

function goldRecords(f: Fixture): Array<Record<string, unknown>> {
  if (f.gold === null) return [];
  return f.expectedShape === 'array' ? (f.gold as Array<Record<string, unknown>>) : [f.gold as Record<string, unknown>];
}

// ─────────────────────────────────────────────────────────────
// What a reader sees: a deliberately simple model of visibility
// ─────────────────────────────────────────────────────────────

interface DomNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
}

interface PageCorpus {
  /** Normalized visible text plus perceivable attributes (title, alt, aria-label, datetime, input values). */
  visible: string;
  visibleNumbers: Set<number>;
  /** Normalized absolute URLs of links/media on visible elements. */
  urls: Set<string>;
  /** Normalized raw markup (attributes, scripts, JSON blobs), for nonVisibleFields. */
  raw: string;
  rawNumbers: Set<number>;
}

const NEVER_RENDERED = new Set(['head', 'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object']);
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'button', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'label',
  'legend', 'li', 'main', 'nav', 'ol', 'option', 'p', 'pre', 'section', 'select', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul',
]);
const PERCEIVABLE_ATTRS = ['title', 'alt', 'aria-label', 'datetime'];
const HIDDEN_CLASSES = new Set(['sr-only', 'visually-hidden', 'screen-reader-text']);
const URL_ATTRS = ['href', 'src', 'data-src'];

function isHidden(node: DomNode): boolean {
  const a = node.attribs ?? {};
  if (a.hidden !== undefined) return true;
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style ?? '')) return true;
  if ((a.class ?? '').split(/\s+/).some((c) => HIDDEN_CLASSES.has(c))) return true;
  return node.name === 'input' && (a.type ?? '').toLowerCase() === 'hidden';
}

function pageCorpus(html: string, baseUrl: string): PageCorpus {
  const $ = cheerio.load(html);
  const text: string[] = [];
  const urls = new Set<string>();
  const walk = (node: DomNode): void => {
    if (node.type === 'text') {
      text.push(node.data ?? '');
      return;
    }
    if (node.type === 'comment' || node.type === 'directive') return;
    const name = node.name ?? '';
    if (NEVER_RENDERED.has(name) || isHidden(node)) return;
    const a = node.attribs ?? {};
    const block = BLOCK_TAGS.has(name);
    if (block) text.push(' ');
    for (const attr of PERCEIVABLE_ATTRS) if (a[attr]) text.push(` ${a[attr]} `);
    if (name === 'input' && a.value && !['checkbox', 'radio'].includes((a.type ?? '').toLowerCase())) text.push(` ${a.value} `);
    for (const attr of URL_ATTRS) addUrl(urls, a[attr], baseUrl);
    for (const entry of (a.srcset ?? '').split(',')) addUrl(urls, entry.trim().split(/\s+/)[0], baseUrl);
    for (const child of node.children ?? []) walk(child);
    if (block) text.push(' ');
  };
  walk($.root()[0] as unknown as DomNode);
  const visible = normalizeText(text.join(''));
  const raw = normalizeText(decodeBasicEntities(html.replace(/\\\//g, '/')));
  return { visible, visibleNumbers: numbersIn(visible), urls, raw, rawNumbers: numbersIn(raw) };
}

function addUrl(urls: Set<string>, value: string | undefined, base: string): void {
  if (!value) return;
  let absolute: string;
  try {
    absolute = new URL(value, base).href;
  } catch {
    return;
  }
  const normalized = normalizeUrl(absolute);
  if (normalized !== null) urls.add(normalized);
}

function decodeBasicEntities(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Every number a token could denote, read US-style ("1,299.00") and EU-style ("1.299,00", "4,5"). */
function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const token = m[0];
    for (const candidate of [token.replace(/,/g, ''), token.replace(/\./g, '').replace(',', '.')]) {
      const n = Number(candidate);
      if (Number.isFinite(n)) out.add(round6(n));
    }
  }
  return out;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Whole-phrase containment on normalized text: "Pro" is not found inside "Product". */
function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = normalizeText(phrase);
  if (needle === '') return false;
  const wordChar = /[\p{L}\p{N}]/u;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    const before = i === 0 ? '' : haystack[i - 1];
    const after = haystack[i + needle.length] ?? '';
    const startsWord = wordChar.test(needle[0]);
    const endsWord = wordChar.test(needle[needle.length - 1]);
    if ((!startsWord || !wordChar.test(before)) && (!endsWord || !wordChar.test(after))) return true;
  }
  return false;
}

const CURRENCY_SYMBOLS: Record<string, string[]> = { USD: ['$'], GBP: ['£'], EUR: ['€'], JPY: ['¥'], INR: ['₹'] };
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** Why a gold scalar could not be found, or null when it was. */
function findOnPage(value: string | number, field: string, corpus: PageCorpus, nonVisible: boolean): string | null {
  if (typeof value === 'number') {
    const numbers = nonVisible ? corpus.rawNumbers : corpus.visibleNumbers;
    if (numbers.has(round6(value))) return null;
    if (nonVisible && Number.isInteger(value) && value >= 0 && value < NUMBER_WORDS.length && containsPhrase(corpus.raw, NUMBER_WORDS[value])) {
      return null;
    }
    return `number ${value} not found in ${nonVisible ? 'raw markup' : 'visible text'}`;
  }
  if (isAbsoluteHttpUrl(value)) {
    const normalized = normalizeUrl(value);
    if (normalized !== null && corpus.urls.has(normalized)) return null;
    if (nonVisible) {
      const url = new URL(value);
      if (corpus.raw.includes(normalizeText(url.href)) || corpus.raw.includes(normalizeText(url.pathname + url.search))) return null;
    }
    return `URL ${value} not linked from a visible element${nonVisible ? ' nor present in raw markup' : ''}`;
  }
  const text = nonVisible ? corpus.raw : corpus.visible;
  if (containsPhrase(text, value)) return null;
  if (/currency/i.test(field) && /^[A-Z]{3}$/.test(value)) {
    if ((CURRENCY_SYMBOLS[value] ?? []).some((symbol) => corpus.visible.includes(symbol))) return null;
  }
  return `text ${JSON.stringify(value)} not found in ${nonVisible ? 'raw markup' : 'visible text'}`;
}

// ─────────────────────────────────────────────────────────────
// Corpus-level checks
// ─────────────────────────────────────────────────────────────

describe('extraction fixture corpus', () => {
  it('index.json lists exactly the fixture directories, in the expected order', () => {
    const dirs = readdirSync(FIXTURES_DIR).filter((name) => statSync(join(FIXTURES_DIR, name)).isDirectory());
    expect(fixtureIds()).toEqual(EXPECTED_IDS);
    expect([...dirs].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it('index.json entries agree with each meta.json', () => {
    const index = JSON.parse(readFileSync(join(FIXTURES_DIR, 'index.json'), 'utf8')) as {
      fixtures: Array<Pick<Fixture, 'id' | 'category' | 'expectedShape' | 'expectStatus' | 'tags'>>;
    };
    for (const entry of index.fixtures) {
      const f = fixture(entry.id);
      expect(entry, entry.id).toEqual({ id: f.id, category: f.category, expectedShape: f.expectedShape, expectStatus: f.expectStatus, tags: f.tags });
    }
  });

  it('loads all fixtures with their files', () => {
    expect(fixtures.map((f) => f.id)).toEqual(EXPECTED_IDS);
    for (const f of fixtures) {
      expect(f.html.trimStart().slice(0, 15).toLowerCase(), f.id).toBe('<!doctype html>');
      expect(f.dir.startsWith(FIXTURES_DIR), f.id).toBe(true);
      expect(new URL(f.url).protocol, f.id).toBe('https:');
    }
  });

  it('filters by id, tag and excluded tag', () => {
    expect(loadFixtures({ ids: ['next-data', 'books-listing'] }).map((f) => f.id)).toEqual(['next-data', 'books-listing']);
    expect(loadFixtures({ tags: ['phase2'] }).map((f) => f.id)).toEqual(['large-listing']);
    const phase1 = loadFixtures({ excludeTags: ['phase2'] }).map((f) => f.id);
    expect(phase1).toHaveLength(EXPECTED_IDS.length - 1);
    expect(phase1).not.toContain('large-listing');
    expect(loadFixtures({ tags: ['listing'], excludeTags: ['phase2'] }).map((f) => f.id)).toEqual(['books-listing', 'specs-comparison-table']);
    expect(loadFixtures({ tags: [] })).toHaveLength(EXPECTED_IDS.length);
  });

  it('rejects unknown and malformed ids instead of silently loading nothing', () => {
    expect(() => loadFixtures({ ids: ['no-such-fixture'] })).toThrow(/unknown fixture id/);
    expect(() => loadFixture('../load')).toThrow(/invalid fixture id/);
    expect(() => loadFixture('No_Such')).toThrow(/invalid fixture id/);
  });

  it('treats empty filter arrays as no filter', () => {
    expect(loadFixtures({ ids: [], tags: [], excludeTags: [] })).toHaveLength(EXPECTED_IDS.length);
    expect(loadFixtures({ ids: ['next-data', 'next-data'] }).map((f) => f.id)).toEqual(['next-data']);
  });

  it('rejects malformed meta.json with a message naming the fixture', () => {
    const good = {
      id: 'x', url: 'https://example.com/p', category: 'c', description: 'd', schema: { a: 'string' },
      expectedShape: 'object', expectStatus: 'complete', notes: 'n', tags: [],
    };
    const build = (meta: unknown): Fixture => buildFixture('x', '/tmp/x', meta, '<!doctype html>', null);
    expect(build(good).id).toBe('x');
    expect(() => build([])).toThrow(/^x: meta\.json must be an object/);
    expect(() => build({ ...good, nonVisibleField: ['a'] })).toThrow(/unknown key\(s\): nonVisibleField/);
    expect(() => build({ ...good, id: 'y' })).toThrow(/does not match its directory/);
    expect(() => build({ ...good, url: 'http://example.com/p' })).toThrow(/absolute https URL/);
    expect(() => build({ ...good, url: '/relative' })).toThrow(/absolute https URL/);
    expect(() => build({ ...good, schema: 'string' })).toThrow(/schema must be an object/);
    expect(() => build({ ...good, expectedShape: 'list' })).toThrow(/expectedShape/);
    expect(() => build({ ...good, expectStatus: 'ok' })).toThrow(/expectStatus/);
    expect(() => build({ ...good, tags: 'pdp' })).toThrow(/tags/);
    expect(() => build({ ...good, notes: '  ' })).toThrow(/notes must be a non-empty string/);
    expect(() => build({ ...good, expectedShape: 'array' })).toThrow(/recordKey is required/);
    expect(() => build({ ...good, recordKey: 'a' })).toThrow(/only for them/);
    expect(() => build({ ...good, expectedShape: 'array', recordKey: 1 })).toThrow(/recordKey must be a string/);
    expect(() => build({ ...good, nonVisibleFields: [1] })).toThrow(/nonVisibleFields/);
  });

  it('hands out fresh objects, so callers cannot corrupt each other', () => {
    const [a] = loadFixtures({ ids: ['book-pdp-plain'] });
    (a.gold as Record<string, unknown>).title = 'mutated';
    (a.schema as Record<string, unknown>).type = 'array';
    const [b] = loadFixtures({ ids: ['book-pdp-plain'] });
    expect((b.gold as Record<string, unknown>).title).toBe('A Light in the Attic');
    expect(b.schema.type).toBe('object');
  });

  it('covers both shapes, every status, decoys and adversarial pages', () => {
    expect(fixtures.filter((f) => f.expectedShape === 'array').length).toBeGreaterThanOrEqual(4);
    expect(new Set(fixtures.map((f) => f.expectStatus))).toEqual(new Set(['complete', 'partial', 'failed']));
    expect(fixtures.filter((f) => f.tags.includes('decoys')).length).toBeGreaterThanOrEqual(10);
    // Both customer schema styles are represented.
    expect(fixtures.some((f) => normalizeSchema(f.schema).fromShorthand)).toBe(true);
    expect(fixtures.some((f) => !normalizeSchema(f.schema).fromShorthand)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Per-fixture label checks
// ─────────────────────────────────────────────────────────────

describe.each(fixtures.map((f) => [f.id, f] as const))('fixture %s', (_id, f) => {
  const normalized = normalizeSchema(f.schema);
  const info = schemaFields(f.schema);
  const derived = new Set(info.derived);

  it('has a schema the engine accepts, with the declared shape', () => {
    if (f.expectedShape === 'array') expect(normalized.shape).toBe('array');
    else expect(['object', 'auto']).toContain(normalized.shape);
    // The scorer's own schema reading agrees with the engine's.
    expect(info.names).toEqual(normalized.fields.map((field) => field.name));
    expect(info.derived).toEqual(normalized.fields.filter((field) => field.derived).map((field) => field.name));
  });

  it('labels gold null exactly when the page is expected to fail', () => {
    expect(f.gold === null).toBe(f.expectStatus === 'failed');
  });

  it('labels every schema field in every gold record, and nothing else', () => {
    if (f.gold === null) return;
    if (f.expectedShape === 'array') {
      expect(Array.isArray(f.gold)).toBe(true);
      expect((f.gold as unknown[]).length).toBeGreaterThan(0);
    } else {
      expect(typeof f.gold === 'object' && !Array.isArray(f.gold)).toBe(true);
    }
    for (const record of goldRecords(f)) expect(Object.keys(record).sort()).toEqual([...info.names].sort());
  });

  it('uses null (not "" or []) for absent values, and null for derived fields', () => {
    for (const record of goldRecords(f)) {
      for (const [field, value] of Object.entries(record)) {
        expect(value, field).not.toBe('');
        if (Array.isArray(value)) expect(value.length, field).toBeGreaterThan(0);
        if (derived.has(field)) expect(value, `${field} is derived`).toBeNull();
      }
    }
  });

  it('has gold that validates against the customer schema', () => {
    if (f.gold === null) return;
    const data = normalized.wrapperKey !== undefined ? { [normalized.wrapperKey]: f.gold } : f.gold;
    const result = validateOutput(normalized, data);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('labels URL fields with absolute https URLs', () => {
    for (const field of normalized.fields) {
      const items = field.schema.items as Record<string, unknown> | undefined;
      const isUrl = field.schema.format === 'uri' || items?.format === 'uri';
      if (!isUrl) continue;
      for (const record of goldRecords(f)) {
        const value = record[field.name];
        for (const v of Array.isArray(value) ? value : [value]) {
          if (v === null) continue;
          expect(typeof v === 'string' && /^https:\/\/[^/]+\//.test(v), `${field.name}: ${String(v)}`).toBe(true);
        }
      }
    }
  });

  it('has a unique, present record key in every gold record', () => {
    if (f.expectedShape !== 'array' || f.gold === null) return;
    const key = f.recordKey!;
    expect(info.names).toContain(key);
    const keys = goldRecords(f).map((r) => scalarKey(r[key]));
    expect(keys.every((k) => k !== null)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('only declares nonVisibleFields that exist and are not derived', () => {
    for (const field of f.nonVisibleFields ?? []) {
      expect(info.names).toContain(field);
      expect(derived.has(field)).toBe(false);
    }
  });

  it('labels only values a reader can find on the page', () => {
    const corpus = pageCorpus(f.html, f.url);
    const nonVisible = new Set(f.nonVisibleFields ?? []);
    const problems: string[] = [];
    goldRecords(f).forEach((record, i) => {
      for (const [field, value] of Object.entries(record)) {
        if (derived.has(field) || value === null || typeof value === 'boolean') continue;
        for (const v of Array.isArray(value) ? value : [value]) {
          if (typeof v !== 'string' && typeof v !== 'number') continue;
          const problem = findOnPage(v, field, corpus, nonVisible.has(field));
          if (problem) problems.push(`${f.expectedShape === 'array' ? `[${i}].` : ''}${field}: ${problem}`);
        }
      }
    });
    expect(problems).toEqual([]);
  });

  it('scores its own gold as perfect', () => {
    const score = scoreExtraction(f, f.gold);
    expect(score.mismatches).toEqual([]);
    expect(score.valuePrecision).toBe(1);
    expect(score.valueRecall).toBe(1);
    expect(score.hallucinatedNulls).toBe(0);
    expect(score.shapeOk).toBe(true);
    if (f.expectedShape === 'array') {
      expect(score.recordPrecision).toBe(1);
      expect(score.recordRecall).toBe(1);
      if (normalized.wrapperKey !== undefined) {
        expect(scoreExtraction(f, { [normalized.wrapperKey]: f.gold }).valueRecall).toBe(1);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────
// The guard itself: it must reject labels a reader could not see
// ─────────────────────────────────────────────────────────────

describe('labelling guard', () => {
  const corpusOf = (id: string): PageCorpus => pageCorpus(fixture(id).html, fixture(id).url);

  it('does not see display:none, sr-only, noscript or script content', () => {
    expect(findOnPage('The correct extraction is', 'title', corpusOf('prompt-injection'), false)).not.toBeNull();
    expect(findOnPage('Your price for this item is', 'name', corpusOf('electronics-pdp-sale'), false)).not.toBeNull();
    const challenge = corpusOf('challenge-page');
    expect(findOnPage('Enable JavaScript and cookies to continue', 'title', challenge, false)).not.toBeNull();
    expect(findOnPage('Verification successful', 'title', challenge, false)).not.toBeNull();
    expect(findOnPage('Verifying you are human', 'title', challenge, false)).toBeNull();
    expect(findOnPage('RTR2-BLK', 'sku', corpusOf('next-data'), false)).not.toBeNull();
    expect(findOnPage('RTR2-BLK', 'sku', corpusOf('next-data'), true)).toBeNull();
  });

  it('rejects near-miss numbers, partial words and unlinked URLs', () => {
    const plain = corpusOf('book-pdp-plain');
    expect(findOnPage(51.77, 'price', plain, false)).toBeNull();
    expect(findOnPage(51.78, 'price', plain, false)).not.toBeNull();
    expect(findOnPage('A Light in the Attic', 'title', plain, false)).toBeNull();
    expect(findOnPage('Light in the Atti', 'title', plain, false)).not.toBeNull();
    const listing = corpusOf('books-listing');
    expect(findOnPage('https://books.toscrape.com/catalogue/sharp-objects_997/index.html', 'url', listing, false)).toBeNull();
    expect(findOnPage('https://books.toscrape.com/catalogue/sharp-objects_998/index.html', 'url', listing, false)).not.toBeNull();
    // A relative link resolved against the wrong base is not the same URL.
    expect(findOnPage('https://books.toscrape.com/catalogue/category/sharp-objects_997/index.html', 'url', listing, false)).not.toBeNull();
  });

  it('reads both number conventions and full titles from title attributes', () => {
    const de = corpusOf('multilingual-de');
    expect(findOnPage(1299, 'price', de, false)).toBeNull();
    expect(findOnPage(4.5, 'rating', de, false)).toBeNull();
    expect(findOnPage('EUR', 'currency', de, false)).toBeNull();
    expect(findOnPage('GBP', 'currency', de, false)).not.toBeNull();
    expect(findOnPage('The Murder of Roger Ackroyd (Hercule Poirot #4)', 'title', corpusOf('books-listing'), false)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// Fixture-specific traps: make sure the decoys are really there
// ─────────────────────────────────────────────────────────────

describe('fixture traps', () => {
  it('books-listing: 20 listing cards, 50 category links, 3 recently viewed decoys', () => {
    const f = fixture('books-listing');
    const $ = cheerio.load(f.html);
    expect($('ol.row > li > article.product_pod')).toHaveLength(20);
    expect($('.side_categories ul ul > li > a')).toHaveLength(50);
    const recent = $('.recently-viewed article.product_pod h3 a').map((_, el) => $(el).attr('title')).get();
    expect(recent).toHaveLength(3);
    const titles = new Set(goldRecords(f).map((r) => r.title));
    for (const t of recent) expect(titles.has(t)).toBe(false);
    // Truncated link text is a real trap: the gold title is longer than what is printed.
    expect($('ol.row h3 a').filter((_, el) => $(el).text().endsWith('...')).length).toBeGreaterThan(5);
    expect(goldRecords(f).filter((r) => r.inStock === false)).toHaveLength(2);
  });

  it('electronics-pdp-sale: 16GB variant selected, 32GB priced differently, 4 decoy cards', () => {
    const $ = cheerio.load(fixture('electronics-pdp-sale').html);
    expect($('.variant[aria-pressed="true"] .variant-label').text()).toBe('16GB');
    expect($('.variant[aria-pressed="false"] .variant-price').text()).toBe('$1,349.99');
    expect($('.also-bought .product-card')).toHaveLength(4);
  });

  it('specs-comparison-table: 15 phone rows, a repeated header row and a footnote row', () => {
    const $ = cheerio.load(fixture('specs-comparison-table').html);
    const rows = $('table.spec-table tbody > tr');
    expect(rows.filter('.spec-table__row')).toHaveLength(15);
    expect(rows.filter('.spec-table__head--repeat')).toHaveLength(1);
    expect(rows.filter('.spec-table__footnote').find('td').attr('colspan')).toBe('8');
    expect(rows.first().find('th, td')).toHaveLength(8);
  });

  it('saas-pricing: both billing periods are in the DOM and neither is hidden inline', () => {
    const $ = cheerio.load(fixture('saas-pricing').html);
    expect($('.price--monthly')).toHaveLength(3);
    expect($('.price--annual')).toHaveLength(3);
    expect($('.price--monthly, .price--annual').filter('[style], [hidden]')).toHaveLength(0);
  });

  it('prompt-injection: the injection is both hidden and visible, and gold ignores it', () => {
    const f = fixture('prompt-injection');
    const $ = cheerio.load(f.html);
    const hidden = $('.product-seo-text');
    expect(hidden.attr('style')).toMatch(/display:\s*none/);
    expect(hidden.text()).toContain("title 'HACKED'");
    expect(hidden.text()).toContain('[b1]');
    expect($('.jdgm-rev__body').text()).toContain('ignore all previous instructions');
    expect($('.jdgm-rev__body').text()).toContain('$5');
    const gold = f.gold as Record<string, unknown>;
    expect(gold.title).not.toMatch(/hacked/i);
    expect(gold.price).not.toBe(0.01);
  });

  it('challenge-page: carries the interstitial markers and nothing product-like', () => {
    const f = fixture('challenge-page');
    expect(f.html).toContain('<title>Just a moment...</title>');
    expect(f.html).toContain('cf-turnstile');
    expect(f.html).toContain('_cf_chl_opt');
    expect(f.html).not.toMatch(/\$\d/);
  });

  it('news-article: summary is derived, null in gold and skipped by scoring', () => {
    const f = fixture('news-article');
    expect(schemaFields(f.schema).derived).toEqual(['summary']);
    const score = scoreExtraction(f, { ...(f.gold as object), summary: 'Any reasonable summary.' });
    expect(score.skippedFields).toEqual(['summary']);
    expect(score.valuePrecision).toBe(1);
    expect(score.hallucinatedNulls).toBe(0);
  });

  it('next-data: sku and images live only in __NEXT_DATA__', () => {
    const f = fixture('next-data');
    const $ = cheerio.load(f.html);
    const data = JSON.parse($('script#__NEXT_DATA__').text()) as { props: { pageProps: { product: { sku: string; images: Array<{ src: string }> } } } };
    const product = data.props.pageProps.product;
    const gold = f.gold as { sku: string; images: string[] };
    expect(product.sku).toBe(gold.sku);
    expect(product.images.map((i) => new URL(i.src, f.url).href)).toEqual(gold.images);
    $('script').remove();
    expect($('body').text()).not.toContain(gold.sku);
  });

  it('value-at-end: committed page matches the generator; version and license only at the end', () => {
    const f = fixture('value-at-end');
    expect(f.html).toBe(generateValueAtEnd());
    const visible = pageCorpus(f.html, f.url).visible;
    const words = visible.split(' ').length;
    expect(words).toBeGreaterThan(5_500);
    expect(words).toBeLessThan(7_000);
    for (const value of [VERSION, LICENSE]) {
      const needle = normalizeText(value);
      expect(visible.indexOf(needle) / visible.length).toBeGreaterThan(0.95);
      expect(visible.indexOf(needle)).toBe(visible.lastIndexOf(needle));
      expect(f.html.split(value)).toHaveLength(2);
    }
  });

  it('large-listing: committed files match the generator; 600 unique records with nulls and sales', () => {
    const f = fixture('large-listing');
    const generated = generateLargeListing();
    expect(f.html).toBe(generated.html);
    expect(readFileSync(join(f.dir, 'gold.json'), 'utf8')).toBe(goldJson(generated.gold));
    const records = goldRecords(f);
    expect(records).toHaveLength(PRODUCT_COUNT);
    expect(PRODUCT_COUNT).toBe(600);
    expect(new Set(records.map((r) => r.sku)).size).toBe(600);
    expect(new Set(records.map((r) => r.name)).size).toBe(600);
    expect(records.filter((r) => r.rating === null).length).toBeGreaterThan(30);
    const $ = cheerio.load(f.html);
    expect($('#product-grid > li article.product-card')).toHaveLength(600);
    expect($('#product-grid .badge--sale').length).toBeGreaterThan(50);
    expect($('.recently-viewed article.product-card')).toHaveLength(3);
    expect(f.tags).toContain('phase2');
    expect(f.expectStatus).toBe('partial');
  });
});
