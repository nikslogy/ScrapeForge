import { buildSync } from 'esbuild';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Piscina from 'piscina';
import type { OutputFormat } from '@scrapeforge/shared';
import type { ExtractionResult } from './pipeline-impl.js';

export type { ExtractionResult } from './pipeline-impl.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Pre-bundle the worker entry to plain ESM so Piscina doesn't need to load
// tsx inside each worker thread. tsx-in-worker added ~400ms per request and
// made lazy thread spawning so slow that the pool effectively serialized
// on a single thread at concurrency > 1.
//
// esbuild.buildSync is synchronous and runs once at module load. Built deps
// stay external so Node resolves them from node_modules at runtime — much
// smaller bundle, identical behavior.
const bundleDir = resolve(__dirname, '..', '..', '.extraction-cache');
if (!existsSync(bundleDir)) mkdirSync(bundleDir, { recursive: true });
const bundlePath = resolve(bundleDir, 'pipeline-worker.mjs');

buildSync({
  entryPoints: [resolve(__dirname, 'pipeline-worker.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: bundlePath,
  external: [
    'jsdom',
    '@mozilla/readability',
    'turndown',
    'cheerio',
    'linkedom',
    '@scrapeforge/shared',
  ],
  sourcemap: 'inline',
  logLevel: 'warning',
});

const threads = Math.max(
  2,
  Math.min(
    Number(process.env.EXTRACTION_POOL_SIZE) || ((os.cpus().length || 4) - 1),
    8,
  ),
);

const pool = new Piscina({
  filename: bundlePath,
  // Pre-spawn the full pool so we never queue onto a single thread during
  // first-task warmup.
  minThreads: threads,
  maxThreads: threads,
  idleTimeout: 60_000,
});

pool.on('error', (err) => {
  console.error('[extraction-pool] worker error:', err);
});

console.log(
  `[extraction-pool] ready: threads=${threads} bundle=${bundlePath}`,
);

export async function extractContent(
  rawHtml: string,
  url: string,
  formats: OutputFormat[],
): Promise<ExtractionResult> {
  return pool.run({ rawHtml, url, formats });
}

export async function shutdownExtractionPool(): Promise<void> {
  await pool.destroy();
}
