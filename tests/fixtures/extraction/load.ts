// Loader for the offline extraction corpus.
//
// Each fixture is a directory next to this file holding page.html (a saved
// page), meta.json (URL, customer schema, expectations) and gold.json (the
// hand-labelled expected output after normalization). index.json lists the
// fixtures in a stable order; a directory that is not listed is not loaded.
//
// Files are read synchronously and re-read on every call: the corpus is about
// 1 MB (most of it the generated 600-card listing), reading it takes a few
// milliseconds, and handing out fresh objects means a caller that mutates gold
// or schema cannot corrupt another test's view of it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ExpectedShape = 'object' | 'array';
export type ExpectedStatus = 'complete' | 'partial' | 'failed';

export interface Fixture {
  id: string;
  /** Absolute path of the fixture directory. */
  dir: string;
  /** Plausible public URL the page was "saved" from; base for relative links. */
  url: string;
  category: string;
  description: string;
  /** Customer schema exactly as a customer would send it (shorthand or JSON Schema). */
  schema: Record<string, unknown>;
  expectedShape: ExpectedShape;
  /** Array fixtures: record field used to match output records to gold records. */
  recordKey?: string;
  expectStatus: ExpectedStatus;
  notes: string;
  tags: string[];
  /**
   * Fields whose gold value legitimately does not appear in the visible text
   * (a star rating only present as a CSS class, a SKU only present in
   * embedded JSON). The corpus check looks for these in the raw HTML instead.
   */
  nonVisibleFields?: string[];
  html: string;
  /** Object, array of records, or null (nothing extractable, e.g. a challenge page). */
  gold: unknown;
}

/** Empty arrays mean "no filter", like an absent property. */
export interface FixtureFilter {
  /** Only these ids, in this order. Unknown ids throw (a typo must not silently test nothing). */
  ids?: string[];
  /** Keep fixtures carrying at least one of these tags. */
  tags?: string[];
  /** Drop fixtures carrying any of these tags. Applied after `tags`. */
  excludeTags?: string[];
}

interface IndexEntry {
  id: string;
}

export const FIXTURES_DIR = fileURLToPath(new URL('.', import.meta.url));

const SHAPES: ReadonlySet<string> = new Set(['object', 'array']);
// A misspelt key ("nonVisibleField") would otherwise be ignored without a trace.
const META_KEYS: ReadonlySet<string> = new Set([
  'id', 'url', 'category', 'description', 'schema', 'expectedShape', 'recordKey', 'expectStatus', 'notes', 'tags', 'nonVisibleFields',
]);
const STATUSES: ReadonlySet<string> = new Set(['complete', 'partial', 'failed']);
// Ids become directory names; keep them to a safe, path-free alphabet.
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Ids listed in index.json, in corpus order. */
export function fixtureIds(): string[] {
  const index = readJson(join(FIXTURES_DIR, 'index.json'));
  if (!isPlainObject(index) || !Array.isArray(index.fixtures)) {
    throw new Error('index.json must be an object with a "fixtures" array');
  }
  return index.fixtures.map((entry: unknown, i: number) => {
    const id = isPlainObject(entry) ? (entry as Partial<IndexEntry>).id : undefined;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error(`index.json fixtures[${i}] has an invalid id`);
    return id;
  });
}

export function loadFixtures(filter: FixtureFilter = {}): Fixture[] {
  const all = fixtureIds();
  let ids: string[];
  if (filter.ids && filter.ids.length > 0) {
    const known = new Set(all);
    const unknown = filter.ids.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`unknown fixture id(s): ${unknown.join(', ')}`);
    ids = [...new Set(filter.ids)];
  } else {
    ids = all;
  }
  let fixtures = ids.map(loadFixture);
  if (filter.tags && filter.tags.length > 0) {
    const wanted = new Set(filter.tags);
    fixtures = fixtures.filter((f) => f.tags.some((t) => wanted.has(t)));
  }
  if (filter.excludeTags && filter.excludeTags.length > 0) {
    const unwanted = new Set(filter.excludeTags);
    fixtures = fixtures.filter((f) => !f.tags.some((t) => unwanted.has(t)));
  }
  return fixtures;
}

/** Loads and validates one fixture directory. Throws with the fixture id on malformed files. */
export function loadFixture(id: string): Fixture {
  if (!ID_PATTERN.test(id)) throw new Error(`invalid fixture id ${JSON.stringify(id)}`);
  const dir = join(FIXTURES_DIR, id);
  const meta = readJson(join(dir, 'meta.json'));
  return buildFixture(id, dir, meta, readFileSync(join(dir, 'page.html'), 'utf8'), readJson(join(dir, 'gold.json')));
}

/** Validates parsed meta.json and assembles the fixture (no I/O, so malformed metas are testable). */
export function buildFixture(id: string, dir: string, meta: unknown, html: string, gold: unknown): Fixture {
  const fail = (msg: string): never => {
    throw new Error(`${id}: meta.json ${msg}`);
  };
  if (!isPlainObject(meta)) return fail('must be an object');

  const unknownKeys = Object.keys(meta).filter((k) => !META_KEYS.has(k));
  if (unknownKeys.length > 0) fail(`has unknown key(s): ${unknownKeys.join(', ')}`);
  if (meta.id !== id) fail(`id ${JSON.stringify(meta.id)} does not match its directory`);
  const url = requireString(meta, 'url', fail);
  if (!/^https:\/\//.test(url) || !URL.canParse(url)) fail('url must be an absolute https URL');
  if (!isPlainObject(meta.schema)) fail('schema must be an object');
  const expectedShape = requireString(meta, 'expectedShape', fail);
  if (!SHAPES.has(expectedShape)) fail(`expectedShape must be one of ${[...SHAPES].join('|')}`);
  const expectStatus = requireString(meta, 'expectStatus', fail);
  if (!STATUSES.has(expectStatus)) fail(`expectStatus must be one of ${[...STATUSES].join('|')}`);
  if (!isStringArray(meta.tags)) fail('tags must be an array of strings');
  if (meta.recordKey !== undefined && typeof meta.recordKey !== 'string') fail('recordKey must be a string');
  if ((expectedShape === 'array') !== (meta.recordKey !== undefined)) fail('recordKey is required for array fixtures and only for them');
  if (meta.nonVisibleFields !== undefined && !isStringArray(meta.nonVisibleFields)) {
    fail('nonVisibleFields must be an array of strings');
  }

  const fixture: Fixture = {
    id,
    dir,
    url,
    category: requireString(meta, 'category', fail),
    description: requireString(meta, 'description', fail),
    schema: meta.schema as Record<string, unknown>,
    expectedShape: expectedShape as ExpectedShape,
    expectStatus: expectStatus as ExpectedStatus,
    notes: requireString(meta, 'notes', fail),
    tags: meta.tags as string[],
    html,
    gold,
  };
  if (typeof meta.recordKey === 'string') fixture.recordKey = meta.recordKey;
  if (meta.nonVisibleFields !== undefined) fixture.nonVisibleFields = meta.nonVisibleFields as string[];
  return fixture;
}

function readJson(path: string): unknown {
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

function requireString(obj: Record<string, unknown>, key: string, fail: (msg: string) => never): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim() === '') return fail(`${key} must be a non-empty string`);
  return value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
