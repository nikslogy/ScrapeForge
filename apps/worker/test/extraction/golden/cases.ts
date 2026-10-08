// Inputs for the golden comparison (capture.ts writes, golden.test.ts reads).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixtures } from '../../../../../tests/fixtures/extraction/load.js';
import { compactPage, largePage, smallPage } from '../../../../../tests/latency/lib/fixtures.js';

export const GOLDEN_DIR = dirname(fileURLToPath(import.meta.url));

export interface GoldenCase {
  id: string;
  source: 'corpus' | 'latency' | 'degenerate';
  url: string;
  html: string;
}

export interface GoldenOutput {
  extractionMethod?: string;
  title?: string;
  description?: string;
  markdown?: string;
  text?: string;
  html?: string;
}

export interface GoldenRecord {
  id: string;
  source: GoldenCase['source'];
  url: string;
  inputBytes: number;
  /** formats: markdown, text, html */
  all: GoldenOutput;
  /** formats: html only (title/description come from meta tags alone) */
  htmlOnly: Pick<GoldenOutput, 'extractionMethod' | 'title' | 'description'>;
}

export const ARTICLE_PAGE = `<!doctype html><html><head><title>Field Notes on Tide Pools</title>
<meta name="description" content="A short article about tide pools."></head>
<body><nav><a href="/">Home</a> <a href="/about">About</a></nav>
<article><h1>Field Notes on Tide Pools</h1>
<p>Tide pools are rocky depressions along the shore that hold seawater when the tide recedes. They host anemones, barnacles, sea stars and small fish that tolerate rapid swings in temperature and salinity.</p>
<p>Visiting at low tide reveals the richest variety of life. Step only on bare rock, never lift animals from their pools, and watch the incoming tide so you are not cut off from the shore.</p>
<p>Researchers use tide pools as natural laboratories for studying competition, predation and how communities recover after storms disturb the rocks.</p>
</article><footer>Copyright 2026</footer></body></html>`;

export function goldenFile(id: string): string {
  return resolve(GOLDEN_DIR, `${id}.json`);
}

export function readGolden(id: string): GoldenRecord {
  return JSON.parse(readFileSync(goldenFile(id), 'utf8')) as GoldenRecord;
}

export function goldenCases(): GoldenCase[] {
  const corpus: GoldenCase[] = loadFixtures().map((f) => ({
    id: `corpus-${f.id}`,
    source: 'corpus',
    url: f.url,
    html: f.html,
  }));
  const latency: GoldenCase[] = [
    { id: 'latency-small', source: 'latency', url: 'https://example.com/', html: smallPage() },
    { id: 'latency-compact', source: 'latency', url: 'https://example.com/', html: compactPage() },
    { id: 'latency-large', source: 'latency', url: 'https://example.com/', html: largePage() },
  ];
  const degenerate: GoldenCase[] = [
    { id: 'degenerate-article', source: 'degenerate', url: 'https://example.com/tide-pools', html: ARTICLE_PAGE },
    { id: 'degenerate-empty', source: 'degenerate', url: 'https://example.com/', html: '' },
    { id: 'degenerate-plain-text', source: 'degenerate', url: 'https://example.com/', html: 'just some text, no markup' },
    { id: 'degenerate-unclosed', source: 'degenerate', url: 'https://example.com/', html: '<div><p><span>dangling' },
    { id: 'degenerate-garbage', source: 'degenerate', url: 'https://example.com/', html: '\u0000\u0001<\u0002>￿' },
  ];
  return [...corpus, ...latency, ...degenerate];
}
