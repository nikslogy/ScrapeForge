import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Piscina } from 'piscina';
import type { OutputFormat } from '@scrapeforge/shared';
import type { ExtractionResult } from './pipeline-impl.js';
import type { ExtractPayload, WarmPayload, WorkerReply } from './pipeline-worker.js';

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
 * dependency that breaks when bundled.
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

function poolSize(env: NodeJS.ProcessEnv): number {
  const configured = Math.floor(Number(env.EXTRACTION_POOL_SIZE));
  // availableParallelism respects the CPU affinity mask (cpusets in
  // containers); cpus().length reports every host core.
  const fallback = os.availableParallelism() - 1;
  return Math.max(2, Math.min(configured > 0 ? configured : fallback, 8));
}

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

export interface ExtractionPoolConfig {
  /** EXTRACTION_POOL_SIZE: worker threads, 2–8 (default: CPUs − 1). */
  threads: number;
  /**
   * EXTRACTION_THREAD_MAX_OLD_MB (512): V8 old-space limit per thread. A
   * thread that exceeds it dies with ERR_WORKER_OUT_OF_MEMORY and is
   * replaced; without it each thread could grow to V8's default (~8 GB).
   */
  threadMaxOldMb: number;
  /** EXTRACTION_THREAD_MAX_TASKS (500): a thread is replaced after this many extractions. */
  threadMaxTasks: number;
  /**
   * EXTRACTION_THREAD_RECYCLE_HEAP_MB (75% of the old-space limit): a thread
   * whose heap in use after a task reaches this is replaced before it nears
   * the hard limit.
   */
  threadRecycleHeapMb: number;
  /**
   * EXTRACTION_TASK_TIMEOUT_MS (20000): limit on one extraction, from its
   * admission to the pool. On expiry the thread running it is terminated
   * (the only way to stop a runaway parse) and replaced.
   */
  taskTimeoutMs: number;
  /**
   * EXTRACTION_MAX_INPUT_BYTES (10 MiB): longer HTML is cut to this many
   * UTF-8 bytes before it is sent to a thread; the result has `truncated: true`.
   */
  maxInputBytes: number;
  /**
   * EXTRACTION_MAX_INPUT_ELEMENTS (100000): the thread's HTML parser stops
   * once it has created more elements than this (implied and reconstructed
   * ones count, so markup cannot get around it); the result has
   * `truncated: true`. Parse memory and time follow the element count
   * (~3 KB of heap and up to ~0.1 ms per element), which the byte limit
   * alone does not bound: 10 MB of tiny elements needs more than a 512 MB
   * heap. Realistic pages stay far below (a 10 MB article page has ~55,000).
   */
  maxInputElements: number;
  /** EXTRACTION_MAX_QUEUE (64): extractions waiting for a thread; more are rejected. */
  maxQueue: number;
  /**
   * EXTRACTION_QUEUE_TIMEOUT_MS (20000): limit on the wait for a thread. With
   * the task timeout it bounds a call: the queue drains at the pace of the
   * running tasks, which can each take up to the task timeout.
   */
  queueTimeoutMs: number;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.warn(`[extraction-pool] ignoring ${name}=${JSON.stringify(raw)}: expected an integer from ${min} to ${max}; using ${fallback}`);
    return fallback;
  }
  return value;
}

export function readExtractionPoolConfig(env: NodeJS.ProcessEnv = process.env): ExtractionPoolConfig {
  const threadMaxOldMb = intFromEnv(env, 'EXTRACTION_THREAD_MAX_OLD_MB', 512, 64, 65_536);
  return {
    threads: poolSize(env),
    threadMaxOldMb,
    threadMaxTasks: intFromEnv(env, 'EXTRACTION_THREAD_MAX_TASKS', 500, 1, 10_000_000),
    threadRecycleHeapMb: intFromEnv(env, 'EXTRACTION_THREAD_RECYCLE_HEAP_MB', Math.floor(threadMaxOldMb * 0.75), 1, threadMaxOldMb),
    taskTimeoutMs: intFromEnv(env, 'EXTRACTION_TASK_TIMEOUT_MS', 20_000, 100, 3_600_000),
    maxInputBytes: intFromEnv(env, 'EXTRACTION_MAX_INPUT_BYTES', 10 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
    maxInputElements: intFromEnv(env, 'EXTRACTION_MAX_INPUT_ELEMENTS', 100_000, 100, 100_000_000),
    maxQueue: intFromEnv(env, 'EXTRACTION_MAX_QUEUE', 64, 0, 1_000_000),
    queueTimeoutMs: intFromEnv(env, 'EXTRACTION_QUEUE_TIMEOUT_MS', 20_000, 1, 3_600_000),
  };
}

/**
 * Cuts `html` to at most `maxBytes` UTF-8 bytes without splitting a
 * character. HTML parsers recover from the cut (an unclosed tag at the end).
 */
export function truncateHtmlInput(html: string, maxBytes: number): { html: string; truncated: boolean } {
  // UTF-8 needs at most 3 bytes per UTF-16 code unit: most pages skip the count.
  if (html.length * 3 <= maxBytes || Buffer.byteLength(html, 'utf8') <= maxBytes) {
    return { html, truncated: false };
  }
  const { read } = new TextEncoder().encodeInto(html, new Uint8Array(maxBytes));
  return { html: html.slice(0, read), truncated: true };
}

// ─────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────

export type ExtractionErrorCode =
  | 'EXTRACTION_TIMEOUT'
  | 'EXTRACTION_QUEUE_FULL'
  | 'EXTRACTION_QUEUE_TIMEOUT'
  | 'EXTRACTION_POOL_CLOSED'
  | 'EXTRACTION_OUT_OF_MEMORY'
  | 'EXTRACTION_FAILED';

export class ExtractionError extends Error {
  constructor(readonly code: ExtractionErrorCode, message: string, options?: { cause?: unknown }) {
    super(`[extraction-pool] ${message}`, options);
    this.name = 'ExtractionError';
  }
}

/** Same name as Piscina's AbortError, which callers already match on. */
function abortError(signal: AbortSignal): Error {
  const err = new Error('[extraction-pool] extraction aborted', { cause: signal.reason });
  err.name = 'AbortError';
  return err;
}

// ─────────────────────────────────────────────────────────────
// FIFO admission
// ─────────────────────────────────────────────────────────────

interface Waiter {
  admit: () => void;
  reject: (err: Error) => void;
  /** Removes the abort listener and clears the wait timer. */
  release: () => void;
  settled: boolean;
}

/**
 * Admits at most `limit` tasks at a time, strictly in arrival order, with at
 * most `maxWaiting` waiting. Piscina 5.1.4's own queue is unfair when
 * saturated: each time a thread frees up it re-appends the task it could not
 * place to the tail (`_onWorkerAvailable` → `_distributeTask`), so the oldest
 * waiting task keeps rotating to the back (p99 9x worse at 20 in flight, see
 * tests/latency/README.md). With `limit` = threads its queue stays empty.
 */
export class FifoAdmission {
  private active = 0;
  private live = 0;
  private queue: Waiter[] = [];
  private head = 0;
  private closedWith: Error | null = null;

  constructor(readonly limit: number, readonly maxWaiting: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be an integer >= 1, got ${limit}`);
    if (!Number.isInteger(maxWaiting) || maxWaiting < 0) throw new RangeError(`maxWaiting must be an integer >= 0, got ${maxWaiting}`);
  }

  get inFlight(): number {
    return this.active;
  }

  get waiting(): number {
    return this.live;
  }

  /** Entries in the internal queue array, including abandoned ones (for tests). */
  get heldEntries(): number {
    return this.queue.length - this.head;
  }

  /**
   * Runs `fn` once a slot is free. Rejects without running it when the queue
   * is full, `signal` aborts while waiting, or no slot frees up within
   * `maxWaitMs` (EXTRACTION_QUEUE_TIMEOUT).
   */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal, maxWaitMs?: number): Promise<T> {
    if (this.closedWith) throw this.closedWith;
    if (signal?.aborted) throw abortError(signal);
    // Joining behind existing waiters even when a slot looks free keeps FIFO strict.
    if (this.active < this.limit && this.live === 0) {
      this.active++;
    } else {
      if (this.live >= this.maxWaiting) {
        throw new ExtractionError('EXTRACTION_QUEUE_FULL', `queue is full (${this.maxWaiting} waiting for ${this.limit} threads)`);
      }
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const leave = (err: Error) => {
          if (waiter.settled) return;
          waiter.settled = true;
          waiter.release();
          this.live--;
          this.dropLeftWaiters();
          reject(err);
        };
        const onAbort = () => leave(abortError(signal!));
        const waiter: Waiter = {
          admit: resolve,
          reject,
          release: () => {
            signal?.removeEventListener('abort', onAbort);
            clearTimeout(timer);
          },
          settled: false,
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (maxWaitMs !== undefined) {
          timer = setTimeout(() => leave(new ExtractionError(
            'EXTRACTION_QUEUE_TIMEOUT',
            `no thread became free within ${maxWaitMs} ms (${this.limit} busy)`,
          )), maxWaitMs);
          timer.unref();
        }
        this.queue.push(waiter);
        this.live++;
      });
    }
    try {
      return await fn();
    } finally {
      this.handOver();
    }
  }

  /** Rejects everything waiting and every later run(). */
  close(err: Error): void {
    this.closedWith = err;
    for (let w = this.next(); w; w = this.next()) w.reject(err);
  }

  private handOver(): void {
    const next = this.next();
    // The slot passes straight to the oldest waiter; `active` is unchanged.
    if (next) next.admit();
    else this.active--;
  }

  private next(): Waiter | undefined {
    while (this.head < this.queue.length) {
      const w = this.queue[this.head]!;
      this.queue[this.head++] = undefined as unknown as Waiter;
      if (w.settled) continue; // aborted while waiting
      w.settled = true;
      w.release();
      this.live--;
      this.compact();
      return w;
    }
    this.compact();
    return undefined;
  }

  /**
   * Waiters that left (aborted, timed out) stay in the array until handOver
   * passes them; drop them once they dominate, so a stream of abandoned
   * waits behind one long task cannot grow it without bound.
   */
  private dropLeftWaiters(): void {
    if (this.queue.length - this.head > 2 * this.live + 32) {
      this.queue = this.queue.slice(this.head).filter((w) => !w.settled);
      this.head = 0;
    }
  }

  private compact(): void {
    if (this.head === this.queue.length) {
      this.queue = [];
      this.head = 0;
    } else if (this.head > 1024 && this.head * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Pool
// ─────────────────────────────────────────────────────────────

export interface ExtractionPoolInfo {
  mode: WorkerEntryMode;
  /** The file worker threads load. */
  entry: string;
  threads: number;
}

type ExtractionPool = Piscina<ExtractPayload | WarmPayload, WorkerReply>;
type LoadBalancer = NonNullable<NonNullable<ConstructorParameters<typeof Piscina>[0]>['loadBalancer']>;
type PoolWorker = Parameters<LoadBalancer>[1][number];

const MB = 1024 * 1024;
const WARM_UP_TIMEOUT_MS = 120_000;

const config = readExtractionPoolConfig();

/** Threads being replaced: they get no new tasks and are terminated once idle. */
const retiring = new Set<number>();
/**
 * Threads that reported ready (loaded and warmed). Piscina offers threads
 * that are still loading to the balancer when another thread frees up; a
 * task placed there waits ~0.6 s for the load to finish.
 */
const readyThreads = new Set<number>();
/** Live views of the workers, as last passed to the balancer (current usage). */
const workersById = new Map<number, PoolWorker>();
let replacementsPending = 0;

const stats = { completed: 0, timedOut: 0, queueTimedOut: 0, outOfMemory: 0, recycledThreads: 0 };

/** Piscina's LeastBusyBalancer (one task per thread) over ready, non-retiring threads. */
const balancer: LoadBalancer = (task, workers) => {
  for (const worker of workers) workersById.set(worker.id, worker);
  let candidate: PoolWorker | null = null;
  let checkpoint = 1;
  for (const worker of workers) {
    if (retiring.has(worker.id) || !readyThreads.has(worker.id)) continue;
    if (worker.currentUsage === 0) return worker;
    if (worker.isRunningAbortableTask) continue;
    if (task.isAbortable === false && worker.currentUsage < checkpoint) {
      candidate = worker;
      checkpoint = worker.currentUsage;
    }
  }
  return candidate;
};

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

  const { threads } = config;
  const pool: ExtractionPool = new Piscina<ExtractPayload | WarmPayload, WorkerReply>({
    filename,
    // Pre-spawn the full pool so we never queue onto a single thread during
    // first-task warmup.
    minThreads: threads,
    maxThreads: threads,
    idleTimeout: 60_000,
    resourceLimits: { maxOldGenerationSizeMb: config.threadMaxOldMb },
    loadBalancer: balancer,
  });
  pool.on('error', (err: unknown) => {
    console.error('[extraction-pool] worker error:', err);
  });
  // Emitted for the initial threads right away (Piscina hands them tasks
  // while they load) and for replacements once they have loaded and warmed up.
  pool.on('workerCreate', (worker: PoolWorker) => {
    readyThreads.add(worker.id);
    replacementsPending = Math.max(0, replacementsPending - 1);
  });
  // The destroyed worker's id already reads -1 (Node resets threadId on
  // exit), and it leaves pool.threads only after this event.
  pool.on('workerDestroy', () => queueMicrotask(forgetExitedThreads));

  console.log(
    `[extraction-pool] ready: threads=${threads} mode=${entry.mode} entry=${filename} ` +
      `maxOldMb=${config.threadMaxOldMb} maxTasks=${config.threadMaxTasks} recycleHeapMb=${config.threadRecycleHeapMb} ` +
      `timeoutMs=${config.taskTimeoutMs} maxInputBytes=${config.maxInputBytes} maxInputElements=${config.maxInputElements} maxQueue=${config.maxQueue} queueTimeoutMs=${config.queueTimeoutMs}`,
  );
  return { pool, info: { mode: entry.mode, entry: filename, threads } };
}

// Top-level await keeps the old fail-fast contract: a missing build or broken
// bundle fails the worker at import time, not on its first job.
const { pool, info } = await createPool();

export const extractionPoolInfo: Readonly<ExtractionPoolInfo> = Object.freeze(info);

const admission = new FifoAdmission(config.threads, config.maxQueue);

let destroyed: Promise<void> | null = null;

function poolClosedError(): ExtractionError {
  return new ExtractionError('EXTRACTION_POOL_CLOSED', 'pool is shut down');
}

function recycle(threadId: number, reason: string): void {
  retiring.add(threadId);
  stats.recycledThreads++;
  console.log(`[extraction-pool] replacing thread ${threadId} (${reason})`);
  terminateIfIdle(threadId);
}

function terminateIfIdle(threadId: number): void {
  // Busy: it may have been handed a queued task before it was marked
  // retiring. The balancer gives it nothing more; this runs again when that
  // task completes.
  if ((workersById.get(threadId)?.currentUsage ?? 0) > 0) return;
  const worker = pool.threads.find((t) => t.threadId === threadId);
  if (!worker) {
    retiring.delete(threadId);
    return;
  }
  replacementsPending++;
  // Piscina sees the exit, drops the thread and starts a replacement.
  worker.terminate().catch(() => { /* already exiting */ });
}

/** Drops bookkeeping for threads that are no longer in the pool. */
function forgetExitedThreads(): void {
  const live = new Set(pool.threads.map((t) => t.threadId));
  for (const id of retiring) if (!live.has(id)) retiring.delete(id);
  for (const id of readyThreads) if (!live.has(id)) readyThreads.delete(id);
  for (const id of workersById.keys()) if (!live.has(id)) workersById.delete(id);
}

let heapLimitChecked = false;

/**
 * --max-old-space-size (often set through NODE_OPTIONS) overrides worker
 * resourceLimits for every isolate in the process. The per-thread limit then
 * does not apply and only heap-based replacement bounds a thread.
 */
function checkHeapLimit(reply: WorkerReply): void {
  if (heapLimitChecked) return;
  heapLimitChecked = true;
  const limitMb = Math.round(reply.heapLimitBytes / MB);
  // The limit also covers the young generation (48 MB by default for workers).
  if (limitMb > config.threadMaxOldMb + 256) {
    console.warn(
      `[extraction-pool] thread heap limit is ${limitMb} MB, not the configured ${config.threadMaxOldMb} MB: ` +
        '--max-old-space-size (NODE_OPTIONS?) overrides worker resourceLimits. Threads are still replaced ' +
        `once their heap in use reaches ${config.threadRecycleHeapMb} MB after a task.`,
    );
  }
}

/** Runs before the task's admission slot is released, so recycling decisions see an idle thread. */
function afterTask(reply: WorkerReply): void {
  checkHeapLimit(reply);
  forgetExitedThreads();
  const id = reply.threadId;
  if (retiring.has(id)) {
    terminateIfIdle(id);
    return;
  }
  const heapMb = reply.heapUsedBytes / MB;
  if (heapMb >= config.threadRecycleHeapMb) {
    recycle(id, `heap in use ${Math.round(heapMb)} MB >= ${config.threadRecycleHeapMb} MB`);
  } else if (reply.tasks >= config.threadMaxTasks && retiring.size + replacementsPending === 0) {
    // One count-based replacement at a time: threads under even load reach
    // the count together, and replacing them all at once would leave no
    // thread to serve for the ~1 s a replacement takes to load.
    recycle(id, `${reply.tasks} tasks`);
  }
}

function isOutOfMemory(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ERR_WORKER_OUT_OF_MEMORY';
}

async function runInPool(
  payload: ExtractPayload | WarmPayload,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<WorkerReply> {
  // Our own controller and timer, cleared on completion: AbortSignal.timeout()
  // keeps its signal (and Piscina's listener, which holds the task and its
  // HTML) alive until the timer fires.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  try {
    const reply = await pool.run(payload, { signal: controller.signal });
    afterTask(reply);
    return reply;
  } catch (err) {
    if (destroyed) throw poolClosedError();
    if (timedOut) {
      stats.timedOut++;
      throw new ExtractionError('EXTRACTION_TIMEOUT', `extraction timed out after ${timeoutMs} ms; its thread was replaced`, { cause: err });
    }
    if (signal?.aborted) throw abortError(signal);
    if (isOutOfMemory(err)) {
      stats.outOfMemory++;
      throw new ExtractionError(
        'EXTRACTION_OUT_OF_MEMORY',
        `extraction exceeded the ${config.threadMaxOldMb} MB thread heap limit; its thread was replaced`,
        { cause: err },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ExtractionError('EXTRACTION_FAILED', `extraction failed: ${message}`, { cause: err });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Every thread loads and warms itself before reporting ready (see
// pipeline-worker.ts). One check per thread, submitted while all threads
// are idle, lands on each of them and resolves once all are warm.
const warmUp: Promise<void> = Promise.all(
  Array.from({ length: config.threads }, () =>
    admission.run(() => runInPool({ warm: true }, WARM_UP_TIMEOUT_MS, undefined)),
  ),
).then(() => undefined);
warmUp.catch((err: unknown) => {
  console.error('[extraction-pool] warm-up failed:', err instanceof Error ? err.message : err);
});

/**
 * Resolves once every thread has loaded the extraction code and run a
 * warm-up page, so the first job does not pay ~1.2 s of module loading.
 * Started at import; await it before taking jobs. Rejects if a thread fails
 * to start.
 */
export function warmExtractionPool(): Promise<void> {
  return warmUp;
}

export interface ExtractContentOptions {
  /** Aborts a queued extraction, or terminates the thread running it. */
  signal?: AbortSignal;
  /** Overrides EXTRACTION_TASK_TIMEOUT_MS for this call. */
  timeoutMs?: number;
  /** Overrides EXTRACTION_QUEUE_TIMEOUT_MS for this call. */
  queueTimeoutMs?: number;
}

/** setTimeout's maximum; longer delays fire after 1 ms instead. */
const MAX_TIMER_MS = 2_147_483_647;

function positiveMs(name: string, value: number): number {
  if (typeof value !== 'number' || !(value > 0) || !Number.isFinite(value)) {
    throw new RangeError(`[extraction-pool] ${name} must be a positive number, got ${value}`);
  }
  return Math.min(value, MAX_TIMER_MS);
}

/**
 * Extracts markdown / text / html, title and description in a worker
 * thread. Rejects with an `ExtractionError` (`code` tells timeouts, a full
 * queue, memory exhaustion and shutdown apart) or an `AbortError`; settles
 * within `queueTimeoutMs` + `timeoutMs`.
 */
export async function extractContent(
  rawHtml: string,
  url: string,
  formats: OutputFormat[],
  options: ExtractContentOptions = {},
): Promise<ExtractionResult> {
  // Piscina re-spawns threads for tasks submitted after destroy(), which
  // would leak threads that keep the process alive past shutdown.
  if (destroyed) throw poolClosedError();
  if (typeof rawHtml !== 'string') throw new TypeError('[extraction-pool] rawHtml must be a string');
  if (typeof url !== 'string') throw new TypeError('[extraction-pool] url must be a string');
  if (!Array.isArray(formats)) throw new TypeError('[extraction-pool] formats must be an array');
  const timeoutMs = positiveMs('timeoutMs', options.timeoutMs ?? config.taskTimeoutMs);
  const queueTimeoutMs = positiveMs('queueTimeoutMs', options.queueTimeoutMs ?? config.queueTimeoutMs);

  const { html, truncated } = truncateHtmlInput(rawHtml, config.maxInputBytes);
  const { signal } = options;
  return admission.run(async () => {
    const payload = { rawHtml: html, url, formats, maxElements: config.maxInputElements };
    const reply = await runInPool(payload, timeoutMs, signal);
    stats.completed++;
    if (reply.error !== undefined || !reply.result) {
      throw new ExtractionError('EXTRACTION_FAILED', `extraction failed: ${reply.error ?? 'no result'}`);
    }
    return truncated && !reply.result.truncated ? { ...reply.result, truncated: true } : reply.result;
  }, signal, queueTimeoutMs).catch((err: unknown) => {
    if ((err as ExtractionError | null)?.code === 'EXTRACTION_QUEUE_TIMEOUT') stats.queueTimedOut++;
    throw err;
  });
}

export interface ExtractionPoolStats {
  threads: number;
  /** Thread ids currently in the pool (replacements get new ids). */
  threadIds: number[];
  inFlight: number;
  queued: number;
  completed: number;
  timedOut: number;
  queueTimedOut: number;
  outOfMemory: number;
  recycledThreads: number;
}

export function getExtractionPoolStats(): ExtractionPoolStats {
  return {
    threads: config.threads,
    threadIds: pool.threads.map((t) => t.threadId),
    inFlight: admission.inFlight,
    queued: admission.waiting,
    ...stats,
  };
}

export function shutdownExtractionPool(): Promise<void> {
  if (!destroyed) {
    admission.close(poolClosedError());
    // A thread terminated by a timeout or a replacement can report its exit
    // after destroy() has finished; Piscina's exit handler then tops the pool
    // back up to minThreads, starting threads nobody will stop (and that
    // fail to load once the bundle is removed). Piscina 5 exposes no other
    // switch for that.
    pool.options.minThreads = 0;
    destroyed = pool.destroy().finally(() => {
      if (info.mode === 'bundled') {
        try { unlinkSync(info.entry); } catch { /* already gone */ }
      }
    });
  }
  return destroyed;
}
