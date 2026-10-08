import { getHeapStatistics } from 'node:v8';
import { threadId } from 'node:worker_threads';
import type { OutputFormat } from '@scrapeforge/shared';
import { extractContent, type ExtractionResult } from './pipeline-impl.js';

export interface ExtractPayload {
  rawHtml: string;
  url: string;
  formats: OutputFormat[];
  /** EXTRACTION_MAX_INPUT_ELEMENTS; absent: no element budget. */
  maxElements?: number;
}

/** Readiness check sent once per thread by warmExtractionPool(). */
export interface WarmPayload {
  warm: true;
}

export interface WorkerReply {
  /** Absent for warm-up checks and failed extractions. */
  result?: ExtractionResult;
  /** Message of an error the extraction threw; the thread stays usable. */
  error?: string;
  threadId: number;
  /** Extractions this thread has run, this one included. */
  tasks: number;
  /** V8 heap in use after the task (garbage included). */
  heapUsedBytes: number;
  /** The thread's V8 heap limit; differs from the configured one under --max-old-space-size. */
  heapLimitBytes: number;
}

// A small article with a nav, a footer and a link-only block: runs the
// whole chain (meta, JSON-LD, Readability, markdown, noise removal, html)
// plus the largest-block path, which converts through turndown's parser.
const WARM_ARTICLE = `<!doctype html><html><head><title>Warm-up article</title>
<meta name="description" content="Pool warm-up page."><script type="application/ld+json">{"@type":"WebPage"}</script></head>
<body><nav><a href="/">Home</a></nav><article><h1>Warm-up article</h1>
<p>Extraction threads load cheerio, linkedom, Readability and turndown, then run this page once so the first real job does not pay for module loading and cold code paths.</p>
<p>The page has <em>inline</em> markup, <a href="/x">a link</a>, a list and a table so the common markdown rules run at least once.</p>
<ul><li>one</li><li>two</li></ul><table><tr><td>a</td><td>b</td></tr></table>
<p>Readability needs a few paragraphs of text before it accepts a page as an article, which this one now has.</p></article>
<footer>Footer</footer></body></html>`;
const WARM_BLOCK = '<!doctype html><html><head><title>Warm</title></head><body><div><h1>Warm</h1><p>Short page for the largest-block path, long enough to pass its hundred character threshold easily.</p></div></body></html>';

let tasks = 0;

// Piscina imports this module before a thread reports ready, so this runs on
// every thread (initial and replacement) before it is given a job.
try {
  await extractContent(WARM_ARTICLE, 'https://warm-up.invalid/article', ['markdown', 'text', 'html']);
  await extractContent(WARM_BLOCK, 'https://warm-up.invalid/block', ['markdown']);
} catch (err) {
  console.warn('[extraction-pool] thread warm-up extraction failed:', err instanceof Error ? err.message : err);
}

function reply(extra: Pick<WorkerReply, 'result' | 'error'> = {}): WorkerReply {
  const heap = getHeapStatistics();
  return { ...extra, threadId, tasks, heapUsedBytes: heap.used_heap_size, heapLimitBytes: heap.heap_size_limit };
}

export default async function extractInWorker(payload: ExtractPayload | WarmPayload): Promise<WorkerReply> {
  if ('warm' in payload) return reply();
  tasks++;
  try {
    const limits = payload.maxElements === undefined ? {} : { maxElements: payload.maxElements };
    return reply({ result: await extractContent(payload.rawHtml, payload.url, payload.formats, limits) });
  } catch (err) {
    return reply({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
}
