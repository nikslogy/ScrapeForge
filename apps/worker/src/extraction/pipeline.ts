import { buildSync } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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

// Per-PID bundle path + atomic rename. Prevents two worker processes
// (e.g. tsx-watch reload leaving an orphan, or the old + new process
// briefly overlapping) from racing on the same file and leaving a
// half-written bundle → Piscina crashes with
// "No handler function exported from pipeline-worker.mjs".
const bundlePath = resolve(bundleDir, `pipeline-worker-${process.pid}.mjs`);
const tmpBundlePath = `${bundlePath}.tmp`;

buildSync({
  entryPoints: [resolve(__dirname, 'pipeline-worker.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: tmpBundlePath,
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

// Sanity-check the bundle before Piscina tries to load it — catches the
// "export default not emitted" class of issue at startup rather than on
// the first job, and makes the error message actionable.
const bundleSource = readFileSync(tmpBundlePath, 'utf8');
if (!/export\s*{[^}]*\bas\s+default\b[^}]*}|export\s+default\b/.test(bundleSource)) {
  throw new Error(
    `[extraction-pool] Bundle at ${tmpBundlePath} is missing a default export ` +
      `(pipeline-worker.ts must \`export default\` a handler function).`,
  );
}

// Atomic rename: Piscina only ever sees a fully-written file.
renameSync(tmpBundlePath, bundlePath);

// Best-effort cleanup of our own bundle on graceful shutdown so we don't
// pollute the cache dir across restarts.
for (const sig of ['SIGINT', 'SIGTERM', 'beforeExit'] as const) {
  process.once(sig, () => {
    try { unlinkSync(bundlePath); } catch { /* already gone */ }
  });
}

// Silence an unused-import warning when some of these aren't triggered.
void writeFileSync;

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
