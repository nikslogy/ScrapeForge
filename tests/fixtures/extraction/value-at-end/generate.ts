// Generates value-at-end/page.html: a ~6,000-word technical article whose
// version and license appear only in its final section, so an engine that
// truncates or samples the start of a long page misses them.
//
// Deterministic (seeded PRNG, no dates or randomness from the environment):
// the committed page.html must equal generatePage(); fixtures.test.ts checks
// that. Regenerate with:
//   npx tsx tests/fixtures/extraction/value-at-end/generate.ts

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TITLE = 'Building Ferrite: A Practical Guide to Embedded Time-Series Storage';
export const AUTHOR = 'Ines Valdivia';
export const VERSION = '3.14.2';
export const LICENSE = 'Apache-2.0';

const SEED = 0x5eed2026;
const PARAGRAPHS_PER_SECTION = 4;
const SENTENCES_PER_PARAGRAPH = 6;

const SECTIONS = [
  'Why another storage engine',
  'The write path',
  'Compaction',
  'Indexing time ranges',
  'Query planning',
  'Memory management',
  'Durability and recovery',
  'Replication',
  'Observability',
  'Benchmarks',
  'Operating Ferrite in production',
  'Migrating from older releases',
  'Lessons learned',
];

const COMPONENTS = [
  'write-ahead log', 'memtable', 'compaction scheduler', 'block cache', 'segment index',
  'query planner', 'retention worker', 'replication stream', 'checksum layer', 'bloom filter',
  'series catalog', 'flush coordinator',
];
const VERBS = ['buffers', 'flushes', 'merges', 'validates', 'batches', 'prefetches', 'throttles', 'rewrites', 'tracks', 'partitions'];
const OBJECTS = [
  'incoming points', 'sealed segments', 'hot partitions', 'cold blocks', 'series metadata', 'tombstones',
  'range scans', 'out-of-order writes', 'per-tenant quotas', 'dirty pages', 'label postings', 'downsampled rollups',
];
const QUALIFIERS = [
  'before they reach disk', 'once a segment crosses its size threshold', 'without blocking readers',
  'in fixed-size batches', 'on a background thread', 'when memory pressure rises', 'for each shard independently',
  'under sustained ingest', 'during crash recovery', 'at the end of every checkpoint interval',
];
const OBSERVATIONS = [
  'most of the latency came from waiting on fsync rather than from encoding',
  'small segments made compaction cheap but inflated the number of open files',
  'readers rarely touched data older than a week, so the cache policy could stay simple',
  'the slowest queries were almost always the ones scanning a wide label match',
  'backpressure needed to be visible to clients, or they retried and made things worse',
  'a predictable memory ceiling mattered more to operators than peak throughput',
  'delta-of-delta timestamps compressed regular scrapes to well under two bytes per point',
  'tests that injected torn writes found more bugs than any amount of code review',
  'splitting metadata from samples kept restarts fast even for very large databases',
  'operators wanted a single dial for durability, not five interacting settings',
];
const TRANSITIONS = ['In practice,', 'In our experience,', 'Early on,', 'Over time,', 'In hindsight,', 'Somewhat surprisingly,'];
const OLD_RELEASES = ['2.0', '2.4', '3.9', '3.13'];
const METRICS = ['p50 write latency', 'p99 query latency', 'recovery time', 'compaction throughput', 'resident memory'];
const UNITS: Record<string, string> = {
  'p50 write latency': 'microseconds',
  'p99 query latency': 'milliseconds',
  'recovery time': 'seconds',
  'compaction throughput': 'MB/s',
  'resident memory': 'MB',
};

/** mulberry32: tiny, fast, good enough for reproducible filler text. */
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

function sentenceMaker(rand: () => number): () => string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
  const kinds: Array<() => string> = [
    () => `The ${pick(COMPONENTS)} ${pick(VERBS)} ${pick(OBJECTS)} ${pick(QUALIFIERS)}.`,
    () => `${pick(TRANSITIONS)} ${pick(OBSERVATIONS)}.`,
    () => {
      const metric = pick(METRICS);
      return `On the reference machine, ${metric} stayed around ${10 + Math.floor(rand() * 890)} ${UNITS[metric]} while the ${pick(COMPONENTS)} ${pick(VERBS)} ${pick(OBJECTS)}.`;
    },
    () => `Releases before ${pick(OLD_RELEASES)} handled ${pick(OBJECTS)} differently, which is why the ${pick(COMPONENTS)} now ${pick(VERBS)} them ${pick(QUALIFIERS)}.`,
    () => `We considered letting the ${pick(COMPONENTS)} own this, but it already ${pick(VERBS)} ${pick(OBJECTS)} and adding more responsibility there made failure modes harder to reason about.`,
    () => `A useful rule of thumb is that ${pick(OBSERVATIONS)}, so measure before tuning the ${pick(COMPONENTS)}.`,
  ];
  return () => pick(kinds)();
}

const CODE_SAMPLES = [
  `[storage]\npath = "/var/lib/ferrite"\nsegment_size_mb = 64\nwal_sync = "batch"\n\n[compaction]\nthreads = 4\nmax_l0_segments = 8`,
  `$ ferrite inspect --segments /var/lib/ferrite\nSEGMENT        SERIES   POINTS      SIZE\n000184.seg     12,408   48,201,377  61 MB\n000185.seg     12,411   48,199,020  61 MB`,
  `let db = Ferrite::open("/var/lib/ferrite")?;\ndb.write("cpu_usage", &[("host", "web-1")], ts, 0.42)?;\nlet rows = db.query("cpu_usage{host=\\"web-1\\"}", last_hours(6))?;`,
];

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function generatePage(): string {
  const rand = prng(SEED);
  const sentence = sentenceMaker(rand);
  const paragraph = (): string => Array.from({ length: SENTENCES_PER_PARAGRAPH }, sentence).join(' ');

  const sections = SECTIONS.map((heading, i) => {
    const paragraphs = Array.from({ length: PARAGRAPHS_PER_SECTION }, () => `      <p>${escapeHtml(paragraph())}</p>`);
    if (i === 3) {
      // A license decoy in the middle: a dependency's license, not the project's.
      paragraphs.push('      <p>The bundled compression codec is a vendored copy of an MIT-licensed library; we track upstream releases and re-vendor it when needed.</p>');
    }
    if (i % 4 === 1) {
      paragraphs.splice(2, 0, `      <pre><code>${escapeHtml(CODE_SAMPLES[(i >> 2) % CODE_SAMPLES.length])}</code></pre>`);
    }
    return `    <section id="${slug(heading)}">\n      <h2>${escapeHtml(heading)}</h2>\n${paragraphs.join('\n')}\n    </section>`;
  });

  const toc = [...SECTIONS, 'Release information']
    .map((h) => `          <li><a href="#${slug(h)}">${escapeHtml(h)}</a></li>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(TITLE)} · Ferrite Engineering Blog</title>
  <meta name="description" content="How Ferrite stores, compacts and queries time-series data on a single node, and what we learned running it in production.">
  <meta name="author" content="${escapeHtml(AUTHOR)}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${escapeHtml(TITLE)}">
  <meta property="og:image" content="https://ferrite-db.dev/blog/img/storage-guide-cover.png">
  <link rel="canonical" href="https://ferrite-db.dev/blog/building-ferrite-embedded-time-series-storage/">
  <link rel="stylesheet" href="/assets/blog.6f2e1d.css">
  <script defer data-domain="ferrite-db.dev" src="https://plausible.io/js/script.js"></script>
  <script>window.__BLOG__ = {"post":"building-ferrite-embedded-time-series-storage","readingMinutes":28,"tags":["storage","internals","rust"]};</script>
</head>
<body class="post-page">
  <div class="cookie-notice css-2h8k1m" role="dialog" aria-label="Cookie notice">This site uses privacy-friendly analytics and no tracking cookies. <button type="button">OK</button></div>
  <header class="site-header css-5t1v9q">
    <a class="brand" href="/">Ferrite</a>
    <nav aria-label="Main"><a href="/docs/">Docs</a> <a href="/blog/">Blog</a> <a href="/community/">Community</a> <a href="https://github.com/ferrite-db/ferrite">GitHub</a></nav>
  </header>
  <main class="post css-8q0w3e">
    <article>
      <header class="post-header">
        <p class="post-kicker"><a href="/blog/category/internals/">Internals</a></p>
        <h1 class="post-title">${escapeHtml(TITLE)}</h1>
        <p class="post-byline">By <a href="/blog/authors/ines-valdivia/" rel="author">${escapeHtml(AUTHOR)}</a> · June 3, 2026 · 28 min read</p>
      </header>
      <nav class="toc css-1m4n7b" aria-label="Table of contents">
        <h2>Contents</h2>
        <ol>
${toc}
        </ol>
      </nav>
      <p class="lede">Ferrite is an embeddable time-series storage engine: a library you link into your service rather than a server you run next to it. This guide walks through how it stores, compacts and queries data, why each piece looks the way it does, and what broke along the way.</p>
${sections.join('\n')}
    <section id="release-information" class="release-info">
      <h2>Release information</h2>
      <p>Everything described in this guide ships in the current stable release.</p>
      <ul class="release-facts">
        <li><strong>Version:</strong> ${VERSION}</li>
        <li><strong>License:</strong> ${LICENSE}</li>
        <li><strong>Minimum supported Rust version:</strong> 1.79</li>
        <li><strong>Platforms:</strong> Linux (x86_64, aarch64), macOS</li>
      </ul>
      <p>Thanks to Tomasz Wierzbicki and Amara Osei for reviewing drafts of this guide.</p>
    </section>
    </article>
  </main>
  <footer class="site-footer css-0z6x2c">
    <p>Ferrite is an open-source project. Content on this site is available under CC BY 4.0 unless noted otherwise.</p>
    <nav><a href="/blog/feed.xml">RSS</a> · <a href="/privacy/">Privacy</a></nav>
  </footer>
</body>
</html>
`;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  writeFileSync(new URL('./page.html', import.meta.url), generatePage());
}
