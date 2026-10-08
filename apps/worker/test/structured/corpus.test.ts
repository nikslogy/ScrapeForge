// Mapper regressions on the hand-labelled corpus (tests/fixtures/extraction)
// and the rules behind them: page-level OpenGraph/meta never becomes array
// records, text location fields get "City, ST" when they ask for it, and
// schema.org enumeration URLs are not "visible" text.

import { describe, expect, it } from 'vitest';
import { loadFixture, loadFixtures } from '../../../../tests/fixtures/extraction/load.js';
import { buildSourceDocument } from '../../src/extract/document/index.js';
import { normalizeSchema } from '../../src/extract/schema/index.js';
import { extractFromStructuredData, type StructuredMapResult } from '../../src/extract/structured/index.js';
import type { SourceDocument } from '../../src/extract/types.js';
import { ld, makeDoc, makeSchema, meta, og, raws } from './helpers.js';

function mapFixture(id: string, schema?: Record<string, unknown>): { result: StructuredMapResult; doc: SourceDocument } {
  const f = loadFixture(id);
  const doc = buildSourceDocument(f.html, f.url);
  return { result: extractFromStructuredData(doc, normalizeSchema(schema ?? f.schema)), doc };
}

/** Sources (json-ld, opengraph, ...) the values of a result were read from. */
function sourcesOf(result: StructuredMapResult, doc: SourceDocument): Set<string> {
  const byId = new Map(doc.structured.map((s) => [s.id, s.source]));
  return new Set(result.records.flatMap((r) => Object.values(r).map((v) => byId.get(v.structuredId) ?? '?')));
}

/** The record schema of an array fixture, as a flat (shape 'auto') shorthand/JSON schema. */
function flatSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const items = schema.type === 'array' ? schema.items : Object.values(schema)[0];
  const record = (Array.isArray(items) ? items[0] : items) as Record<string, unknown>;
  // Without "type": "object" a JSON Schema record is 'auto' like flat shorthand.
  const { type: _type, ...rest } = record;
  return rest;
}

describe('listing pages: page-level metadata never becomes records', () => {
  it.each([
    ['books-listing', 'Mystery | Books to Scrape'],
    ['saas-pricing', 'Fieldnote pricing'],
    ['large-listing', 'All Gear'],
  ])('%s (array schema): no fake record from og:title %j', (id, ogTitle) => {
    const { result, doc } = mapFixture(id);
    expect(normalizeSchema(loadFixture(id).schema).shape).toBe('array');
    expect(doc.structured.some((s) => s.source === 'opengraph')).toBe(true);
    expect(result.records).toEqual([]);
    expect(result.shape).toBeNull();
    expect(JSON.stringify(result)).not.toContain(ogTitle);
  });

  it.each([['books-listing'], ['saas-pricing'], ['large-listing']])('%s (flat auto schema): og:title does not decide "object"', (id) => {
    const schema = flatSchema(loadFixture(id).schema);
    expect(normalizeSchema(schema).shape).toBe('auto');
    const { result } = mapFixture(id, schema);
    expect(result.shape).toBeNull();
    expect(result.records).toEqual([]);
  });

  it('no array fixture gets a record from OpenGraph or meta', () => {
    for (const f of loadFixtures().filter((x) => x.expectedShape === 'array')) {
      const { result, doc } = mapFixture(f.id);
      const sources = sourcesOf(result, doc);
      expect(sources.has('opengraph') || sources.has('meta'), f.id).toBe(false);
    }
  });

  it('object pages still use OpenGraph where the type fits (prompt-injection: og:type product, no JSON-LD)', () => {
    const { result, doc } = mapFixture('prompt-injection');
    expect(result.shape).toBe('object');
    expect(raws(result.records[0]).title).toBe('Aurora Ceramic Pour-Over Coffee Set');
    expect(sourcesOf(result, doc)).toEqual(new Set(['opengraph']));
  });
});

describe('job-posting: location "City and state"', () => {
  it('composes addressLocality and addressRegion when the description asks for the state', () => {
    const { result } = mapFixture('job-posting');
    expect(result.shape).toBe('object');
    const location = result.records[0].location;
    expect(location).toMatchObject({
      raw: 'Austin, TX',
      pointer: '/jobLocation/address',
      visibleInPage: true,
      composedFrom: ['/jobLocation/address/addressLocality', '/jobLocation/address/addressRegion'],
    });
    expect(result.warnings.filter((w) => w.includes('location'))).toEqual([]);
  });

  const withLocation = (location: Record<string, unknown>) => {
    const schema = structuredClone(loadFixture('job-posting').schema) as { properties: Record<string, unknown> };
    schema.properties.location = location;
    return mapFixture('job-posting', schema).result.records[0].location;
  };

  it('keeps the city alone when only the city is asked for', () => {
    expect(withLocation({ type: 'string' }).raw).toBe('Austin');
    expect(withLocation({ type: 'string', description: 'Where the job is based' }).raw).toBe('Austin');
    expect(withLocation({ type: 'string', description: 'City, without the state' }).raw).toBe('Austin');
  });

  it('adds the country only when it is asked for', () => {
    const v = withLocation({ type: 'string', description: 'City, state and country' });
    expect(v.raw).toBe('Austin, TX, US');
    // Not printed that way on the page: reported, the engine treats it as unverified.
    expect(v.visibleInPage).toBe(false);
    expect(withLocation({ type: 'string', description: 'City and country' }).raw).toBe('Austin, US');
  });
});

describe('location composition rules', () => {
  const job = (address: unknown, extra: Record<string, unknown> = {}) =>
    makeDoc({
      text: 'Data Engineer\n\nAustin, TX\n\nParis, France',
      items: [ld({ '@type': 'JobPosting', title: 'Data Engineer', jobLocation: { '@type': 'Place', address }, ...extra })],
    });
  const cityState = makeSchema([{ name: 'location', description: 'City and state' }]);

  it('never guesses a part the data does not have', () => {
    const res = extractFromStructuredData(job({ '@type': 'PostalAddress', addressLocality: 'Austin' }), cityState);
    expect(res.records[0].location.raw).toBe('Austin');
    expect(res.records[0].location.composedFrom).toBeUndefined();
  });

  it('does not double a region already in the locality', () => {
    const res = extractFromStructuredData(job({ addressLocality: 'Austin, TX', addressRegion: 'TX' }), cityState);
    expect(res.records[0].location.raw).toBe('Austin, TX');
    expect(res.records[0].location.composedFrom).toBeUndefined();
  });

  it('reads a Country object by name and follows the first of several locations', () => {
    const doc = makeDoc({
      text: 'Paris, France',
      items: [
        ld({
          '@type': 'JobPosting',
          title: 'Chef',
          jobLocation: [
            { '@type': 'Place', address: { addressLocality: 'Paris', addressCountry: { '@type': 'Country', name: 'France' } } },
            { '@type': 'Place', address: { addressLocality: 'Lyon', addressCountry: 'FR' } },
          ],
        }),
      ],
    });
    const res = extractFromStructuredData(doc, makeSchema([{ name: 'location', description: 'City and country' }]));
    expect(res.records[0].location).toMatchObject({ raw: 'Paris, France', visibleInPage: true, pointer: '/jobLocation/0/address' });
    expect(res.warnings).toContain('multiple_values:location');
  });

  it('applies to city fields and event venues, not to numbers or other fields', () => {
    const event = makeDoc({
      text: 'Concert\n\nDenver, CO',
      items: [ld({ '@type': 'Event', name: 'Concert', location: { '@type': 'Place', name: 'Red Rocks', address: { addressLocality: 'Denver', addressRegion: 'CO' } } })],
    });
    const city = extractFromStructuredData(event, makeSchema([{ name: 'city', description: 'City and state, e.g. "Austin, TX"' }]));
    expect(city.records[0].city.raw).toBe('Denver, CO');
    // An event "location" is its venue name first; asking for the state composes the address instead.
    expect(raws(extractFromStructuredData(event, makeSchema(['location'])).records[0]).location).toBe('Red Rocks');
    expect(raws(extractFromStructuredData(event, makeSchema([{ name: 'location', description: 'city and state' }])).records[0]).location).toBe('Denver, CO');
    expect(raws(extractFromStructuredData(event, makeSchema([{ name: 'region', description: 'state' }])).records[0]).region).toBe('CO');
  });

  it('only fields that mean a location are composed ("location_state" is no known concept)', () => {
    const doc = job({ addressLocality: 'Austin', addressRegion: 'TX', addressCountry: 'US' });
    expect(extractFromStructuredData(doc, makeSchema([{ name: 'location_state' }])).records[0]?.location_state).toBeUndefined();
    const named = extractFromStructuredData(doc, makeSchema([{ name: 'jobLocation', description: 'location incl. state' }]));
    expect(raws(named.records[0])).toEqual({ jobLocation: 'Austin, TX' });
  });
});

describe('schema.org enumeration URLs', () => {
  it('book-pdp-jsonld: a text availability field keeps the URL, not visible, with its label', () => {
    const { result } = mapFixture('book-pdp-jsonld');
    expect(result.records[0].availability).toMatchObject({ raw: 'https://schema.org/InStock', visibleInPage: false, enumLabel: 'InStock' });
    expect(result.warnings).toContain('structured_value_not_visible:availability');
  });

  it('a boolean field reads the meaning: visible when the page shows it', () => {
    const { result } = mapFixture('book-pdp-jsonld', { type: 'object', properties: { inStock: { type: 'boolean' } } });
    expect(result.records[0].inStock).toMatchObject({ raw: 'https://schema.org/InStock', visibleInPage: true, enumLabel: 'InStock' });
  });

  it('multilingual-de: "Auf Lager" is not "in stock" to the visibility check', () => {
    const { result } = mapFixture('multilingual-de');
    expect(result.records[0].inStock).toMatchObject({ enumLabel: 'InStock', visibleInPage: false });
  });

  it('a URL field may hold the enumeration URL as such', () => {
    const doc = makeDoc({
      text: 'Anvil\n\nIn stock',
      items: [ld({ '@type': 'Product', name: 'Anvil', offers: { '@type': 'Offer', price: '9', availability: 'https://schema.org/InStock' } })],
      attrs: [{ href: 'https://schema.org/InStock' }],
    });
    const res = extractFromStructuredData(doc, makeSchema([{ name: 'availabilityUrl', description: 'availability' }, { name: 'availability', type: 'unknown' }]));
    expect(res.records[0].availabilityUrl).toMatchObject({ visibleInPage: true, enumLabel: 'InStock' });
    expect(res.records[0].availability).toMatchObject({ visibleInPage: false, enumLabel: 'InStock' });
  });

  it('plain codes are not enumeration URLs', () => {
    const doc = makeDoc({ text: 'Engineer\n\nFull-time', items: [ld({ '@type': 'JobPosting', title: 'Engineer', employmentType: 'FULL_TIME' })] });
    const res = extractFromStructuredData(doc, makeSchema(['employmentType']));
    expect(res.records[0].employmentType).toMatchObject({ raw: 'FULL_TIME', visibleInPage: true });
    expect(res.records[0].employmentType.enumLabel).toBeUndefined();
  });
});

describe('array and auto shapes without a list', () => {
  const productPage = (extra: ReturnType<typeof ld>[] = []) =>
    makeDoc({
      text: 'Anvil 3000\n\n$199.99',
      items: [og({ 'og:type': 'website', 'og:title': 'Anvils | Acme' }), meta({ description: 'Anvils' }), ...extra],
    });
  const fields = ['title', { name: 'price', type: 'number' as const }];

  it('array: OpenGraph/meta alone give nothing', () => {
    const res = extractFromStructuredData(productPage(), makeSchema(fields, 'array'));
    expect(res).toMatchObject({ shape: null, records: [] });
  });

  it('array: site scaffolding (WebSite, Organization) is not a listing of one', () => {
    const res = extractFromStructuredData(
      productPage([ld({ '@type': 'WebSite', name: 'Acme', url: 'https://shop.example.com/' }), ld({ '@type': 'Organization', name: 'Acme Inc' })]),
      makeSchema(fields, 'array'),
    );
    expect(res.records).toEqual([]);
  });

  it('array: a content entity of the requested kind is still a one-record array', () => {
    const res = extractFromStructuredData(productPage([ld({ '@type': 'Product', name: 'Anvil 3000', offers: { price: '199.99' } })]), makeSchema(fields, 'array'));
    expect(res.shape).toBe('array');
    expect(res.records.map(raws)).toEqual([{ title: 'Anvil 3000', price: '199.99' }]);
  });

  it('array: an article is not a record of a product-shaped schema', () => {
    const res = extractFromStructuredData(productPage([ld({ '@type': 'Article', headline: 'Best anvils of 2026' })]), makeSchema(fields, 'array'));
    expect(res.records).toEqual([]);
  });

  it('auto: product fields on a page that only has og:type website → no decision', () => {
    expect(extractFromStructuredData(productPage(), makeSchema(fields, 'auto'))).toMatchObject({ shape: null, records: [] });
  });

  it('auto: generic page fields, or og:type matching the fields, still read OpenGraph', () => {
    const generic = extractFromStructuredData(productPage(), makeSchema(['title', 'description'], 'auto'));
    expect(generic.shape).toBe('object');
    expect(raws(generic.records[0])).toEqual({ title: 'Anvils | Acme', description: 'Anvils' });
    const article = makeDoc({ text: 'Big News\n\nBy Ann Lee', items: [og({ 'og:type': 'article', 'og:title': 'Big News', 'article:author': 'Ann Lee' })] });
    const res = extractFromStructuredData(article, makeSchema(['title', 'author'], 'auto'));
    expect(res.shape).toBe('object');
    expect(raws(res.records[0])).toEqual({ title: 'Big News', author: 'Ann Lee' });
  });

  it('object: unchanged, OpenGraph is the fallback record', () => {
    const res = extractFromStructuredData(productPage(), makeSchema(fields, 'object'));
    expect(res.shape).toBe('object');
    expect(raws(res.records[0]).title).toBe('Anvils | Acme');
  });
});
