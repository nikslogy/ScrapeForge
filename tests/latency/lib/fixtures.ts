// Deterministic test payloads: two example.com-shaped pages, a ~500 KB content
// page, and a ~50 KB scrape result like the one the worker stores and returns.
// Seeded so every run (and every machine) measures identical inputs.

/** mulberry32: tiny seeded PRNG, good enough for filler text. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'data engine latency queue worker request page content market report value ' +
  'system network price product review service customer process window result ' +
  'analysis policy region record growth signal update table detail summary ' +
  'quality release feature support history archive source model index budget'
).split(' ');

function sentence(rand: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rand() * WORDS.length)]);
  const s = out.join(' ');
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
}

function paragraph(rand: () => number): string {
  const n = 3 + Math.floor(rand() * 4);
  return Array.from({ length: n }, () => sentence(rand, 8 + Math.floor(rand() * 10))).join(' ');
}

/**
 * The classic example.com page (1,256 bytes, served for many years): HTML is
 * over 1 KB but visible text is ~200 chars. That combination is what the
 * router's quality gate (quality-scorer.ts) penalises as a likely stub page.
 */
export function smallPage(): string {
  return `<!doctype html>
<html>
<head>
    <title>Example Domain</title>

    <meta charset="utf-8" />
    <meta http-equiv="Content-type" content="text/html; charset=utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style type="text/css">
    body {
        background-color: #f0f0f2;
        margin: 0;
        padding: 0;
        font-family: -apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", "Open Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
        
    }
    div {
        width: 600px;
        margin: 5em auto;
        padding: 2em;
        background-color: #fdfdff;
        border-radius: 0.5em;
        box-shadow: 2px 3px 7px 2px rgba(0,0,0,0.02);
    }
    a:link, a:visited {
        color: #38488f;
        text-decoration: none;
    }
    @media (max-width: 700px) {
        div {
            margin: 0 auto;
            width: auto;
        }
    }
    </style>    
</head>

<body>
<div>
    <h1>Example Domain</h1>
    <p>This domain is for use in illustrative examples in documents. You may use this
    domain in literature without prior coordination or asking for permission.</p>
    <p><a href="https://www.iana.org/domains/example">More information...</a></p>
</div>
</body>
</html>
`;
}

/**
 * A compact (< 1 KB) page in the style of the newer, minified example.com:
 * same content shape, but under the 1 KB threshold where the quality gate's
 * short-page carve-out applies.
 */
export function compactPage(): string {
  return (
    '<!doctype html><html lang="en"><head><title>Example Domain</title>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{background:#eee;width:60vw;margin:15vh auto;font-family:system-ui,sans-serif}' +
    'h1{font-size:1.5em}div{opacity:0.8}a:link,a:visited{color:#348}</style><body><div>' +
    '<h1>Example Domain</h1><p>This domain is for use in documentation examples without needing ' +
    'permission. Avoid use in operations.<p><a href="https://iana.org/domains/example">Learn more</a>' +
    '</div></body></html>'
  );
}

/**
 * Content-heavy page of at least `targetBytes` UTF-8 bytes: large inline
 * state script, navigation, a long article with headings, lists and tables,
 * and a footer, the mix that real news/e-commerce pages ship.
 */
export function largePage(targetBytes = 500 * 1024, seed = 42): string {
  if (!Number.isInteger(targetBytes) || targetBytes < 1) {
    throw new RangeError(`targetBytes must be a positive integer, got ${targetBytes}`);
  }
  const rand = seededRandom(seed);
  const head = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<title>Quarterly Market Report: Engine Latency and Queue Throughput</title>',
    '<meta name="description" content="A long-form report used as a large extraction fixture.">',
    '<meta property="og:title" content="Quarterly Market Report">',
  ];
  // About a fifth of the budget is inline JSON state, as SPAs embed.
  const state = Array.from({ length: Math.max(1, Math.floor(targetBytes / 5 / 120)) }, (_, i) => ({
    id: i,
    sku: `SKU-${(i * 7919) % 100000}`,
    label: sentence(rand, 6),
    price: Math.round(rand() * 100000) / 100,
  }));
  head.push(`<script>window.__STATE__=${JSON.stringify(state)};</script>`);
  head.push('</head><body>');

  const nav = ['<header><nav><ul>'];
  for (let i = 0; i < 60; i++) nav.push(`<li><a href="/section/${i}">${WORDS[i % WORDS.length]} ${i}</a></li>`);
  nav.push('</ul></nav></header><main><article><h1>Quarterly Market Report</h1>');

  const footer = '</article></main><footer><p>Footer text and legal links.</p></footer></body></html>';
  const parts = [...head, ...nav];
  let bytes = Buffer.byteLength(parts.join('')) + Buffer.byteLength(footer);
  let section = 0;
  while (bytes < targetBytes) {
    const chunk: string[] = [`<h2>Section ${++section}: ${sentence(rand, 4)}</h2>`];
    for (let p = 0; p < 4; p++) chunk.push(`<p>${paragraph(rand)}</p>`);
    if (section % 3 === 0) {
      chunk.push('<ul>');
      for (let li = 0; li < 5; li++) chunk.push(`<li>${sentence(rand, 6)}</li>`);
      chunk.push('</ul>');
    }
    if (section % 5 === 0) {
      chunk.push('<table><tr><th>Item</th><th>Value</th></tr>');
      for (let r = 0; r < 6; r++) chunk.push(`<tr><td>${sentence(rand, 2)}</td><td>${(rand() * 1000).toFixed(2)}</td></tr>`);
      chunk.push('</table>');
    }
    const html = chunk.join('');
    parts.push(html);
    bytes += Buffer.byteLength(html);
  }
  parts.push(footer);
  return parts.join('');
}

/**
 * A completed ScrapeResult of roughly `targetBytes` when JSON-encoded, the
 * object worker.ts returns from the processor (BullMQ stores it as the job's
 * returnvalue), writes to `result:{jobId}` and `cache:*`, and publishes in
 * the SSE `complete` event.
 */
export function scrapeResult(jobId: string, url: string, targetBytes = 50 * 1024): Record<string, unknown> {
  if (!Number.isInteger(targetBytes) || targetBytes < 0) {
    throw new RangeError(`targetBytes must be a non-negative integer, got ${targetBytes}`);
  }
  const rand = seededRandom(7);
  const base = {
    jobId,
    url,
    status: 'completed',
    statusCode: 200,
    content: { markdown: '' },
    metadata: {
      tierUsed: 1,
      proxyTier: 'none',
      latencyMs: 0,
      cached: false,
      qualityScore: 0.9,
      extractionMethod: 'readability',
      title: 'Quarterly Market Report',
      description: 'A long-form report used as a large extraction fixture.',
      costBreakdown: { compute: 0.00001, proxy: 0, captcha: 0, llm: 0, total: 0.00001 },
    },
  };
  const overhead = Buffer.byteLength(JSON.stringify(base));
  const lines: string[] = ['# Quarterly Market Report'];
  let size = overhead + lines[0].length;
  while (size < targetBytes) {
    const line = `\n\n${paragraph(rand)}`;
    lines.push(line);
    size += Buffer.byteLength(JSON.stringify(line)) - 2;
  }
  base.content.markdown = lines.join('');
  return base;
}
