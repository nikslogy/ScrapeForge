import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Piscina } from 'piscina';
import type { OutputFormat } from '@scrapeforge/shared';
import type { ExtractionResult } from './pipeline-impl.js';
import type { ExtractPayload } from './pipeline-worker.js';

export type { ExtractionResult } from './pipeline-impl.js';

/**
 * How worker threads load the extraction handler.
 *
 * - `compiled`: running from dist (`node dist/worker.js`). The compiled
 *   `pipeline-worker.js` next to this module is plain ESM that worker threads
 *   import directly. esbuild (a devDependency) is never loaded.
 * - `bundled`: running from TypeScript sources (tsx, vitest). Worker threads
 *   would need tsx's loader, which added ~400ms per request and made lazy
 *   thread spawning so slow the pool effectively serialized on one thread,
 *   so the entry is bundled to plain ESM once at startup instead.
 */
export type WorkerEntryMode = 'compiled' | 'bundled';

export interface WorkerEntry {
  mode: WorkerEntryMode;
  /** compiled: the file threads load. bundled: the TypeScript entry to bundle. */
  file: string;
}

/** Pure decision, exported for tests: which worker entry fits this module's own URL. */
export function resolveWorkerEntry(moduleUrl: string): WorkerEntry {
  const modulePath = fileURLToPath(moduleUrl);
  const dir = dirname(modulePath);
  return /\.[cm]?ts$/.test(modulePath)
    ? { mode: 'bundled', file: resolve(dir, 'pipeline-worker.ts') }
    : { mode: 'compiled', file: resolve(dir, 'pipeline-worker.js') };
}

// Host + PID names the owning process. PIDs alone collide when several
// containers bind-mount one source tree (each may run the worker as PID 7),
// and a PID liveness check is only meaningful for processes on this host.
const BUNDLE_OWNER = `${os.hostname().replace(/[^A-Za-z0-9.-]/g, '_').slice(0, 64)}-${process.pid}`;
const BUNDLE_FILE = /^pipeline-worker-(.+)-(\d+)\.mjs(?:\.tmp)?$/;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Bundles are per-process and removed on exit, but a process killed by a
// signal it doesn't handle never runs its exit hook. Sweep this host's
// leftovers from dead processes so the cache dir doesn't grow across dev
// restarts. Other hosts' files are never touched: their PIDs mean nothing here.
function sweepStaleBundles(dir: string): void {
  const host = BUNDLE_OWNER.slice(0, BUNDLE_OWNER.lastIndexOf('-'));
  for (const name of readdirSync(dir)) {
    const match = BUNDLE_FILE.exec(name);
    if (!match || match[1] !== host) continue;
    const pid = Number(match[2]);
    if (pid === process.pid || isProcessAlive(pid)) continue;
    try { unlinkSync(resolve(dir, name)); } catch { /* raced with another sweeper */ }
  }
}

/**
 * Bundles the TypeScript worker entry to one ESM file (dev/test only).
 * Packages stay external so Node resolves them from node_modules at runtime:
 * a much smaller bundle with identical behavior, and no risk of inlining a
 * dependency (jsdom) that breaks when bundled.
 */
async function bundleWorkerEntry(entryTs: string, cacheDir: string): Promise<string> {
  // Dynamic import: dist never reaches this code, so production installs
  // without devDependencies never need esbuild.
  const { build } = await import('esbuild');

  mkdirSync(cacheDir, { recursive: true });
  sweepStaleBundles(cacheDir);

  // Per-process path + atomic rename. Prevents two worker processes (a
  // tsx-watch reload leaving an orphan, or old and new process briefly
  // overlapping) from racing on one file and leaving a half-written bundle,
  // which makes Piscina fail with "No handler function exported".
  const bundlePath = resolve(cacheDir, `pipeline-worker-${BUNDLE_OWNER}.mjs`);
  const tmpPath = `${bundlePath}.tmp`;

  await build({
    entryPoints: [entryTs],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: tmpPath,
    packages: 'external',
    sourcemap: 'inline',
    logLevel: 'warning',
  });

  // Catch a missing default export at startup with an actionable message
  // rather than as an opaque Piscina error on the first job.
  const source = readFileSync(tmpPath, 'utf8');
  if (!/export\s*{[^}]*\bas\s+default\b[^}]*}|export\s+default\b/.test(source)) {
    throw new Error(
      `[extraction-pool] Bundle at ${tmpPath} is missing a default export ` +
        `(${basename(entryTs)} must \`export default\` a handler function).`,
    );
  }
  renameSync(tmpPath, bundlePath);

  // 'exit' rather than signal listeners: a SIGINT listener would disable
  // Node's default exit-on-Ctrl-C for scripts that import this module.
  process.once('exit', () => {
    try { unlinkSync(bundlePath); } catch { /* already gone */ }
  });
  return bundlePath;
}

function poolSize(): number {
  const configured = Math.floor(Number(process.env.EXTRACTION_POOL_SIZE));
  // availableParallelism respects the CPU affinity mask (cpusets in
  // containers); cpus().length reports every host core.
  const fallback = os.availableParallelism() - 1;
  return Math.max(2, Math.min(configured > 0 ? configured : fallback, 8));
}

export interface ExtractionPoolInfo {
  mode: WorkerEntryMode;
  /** The file worker threads load. */
  entry: string;
  threads: number;
}

type ExtractionPool = Piscina<ExtractPayload, ExtractionResult>;

async function createPool(): Promise<{ pool: ExtractionPool; info: ExtractionPoolInfo }> {
  const entry = resolveWorkerEntry(import.meta.url);
  let filename: string;
  if (entry.mode === 'compiled') {
    if (!existsSync(entry.file)) {
      throw new Error(
        `[extraction-pool] Compiled worker entry ${entry.file} not found. ` +
          'Build the worker with `npm run build -w apps/worker`.',
      );
    }
    filename = entry.file;
  } else {
    const cacheDir = resolve(dirname(entry.file), '..', '..', '.extraction-cache');
    filename = await bundleWorkerEntry(entry.file, cacheDir);
  }

  const threads = poolSize();
  const pool = new Piscina<ExtractPayload, ExtractionResult>({
    filename,
    // Pre-spawn the full pool so we never queue onto a single thread during
    // first-task warmup.
    minThreads: threads,
    maxThreads: threads,
    idleTimeout: 60_000,
  });
  pool.on('error', (err: unknown) => {
    console.error('[extraction-pool] worker error:', err);
  });

  console.log(`[extraction-pool] ready: threads=${threads} mode=${entry.mode} entry=${filename}`);
  return { pool, info: { mode: entry.mode, entry: filename, threads } };
}

// Top-level await keeps the old fail-fast contract: a missing build or broken
// bundle fails the worker at import time, not on its first job.
const { pool, info } = await createPool();

export const extractionPoolInfo: Readonly<ExtractionPoolInfo> = Object.freeze(info);

let destroyed: Promise<void> | null = null;

export async function extractContent(
  rawHtml: string,
  url: string,
  formats: OutputFormat[],
  options: { signal?: AbortSignal } = {},
): Promise<ExtractionResult> {
  // Piscina re-spawns threads for tasks submitted after destroy(), which
  // would leak threads that keep the process alive past shutdown.
  if (destroyed) throw new Error('[extraction-pool] pool is shut down');
  // An aborted task that is already running terminates its thread, which
  // Piscina replaces: the only way to stop a runaway parse.
  return pool.run({ rawHtml, url, formats }, { signal: options.signal ?? null });
}

export function shutdownExtractionPool(): Promise<void> {
  destroyed ??= pool.destroy().finally(() => {
    if (info.mode === 'bundled') {
      try { unlinkSync(info.entry); } catch { /* already gone */ }
    }
  });
  return destroyed;
}
