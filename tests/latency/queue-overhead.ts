/* eslint-disable no-console */
/**
 * Phase 0 latency investigation of the sync scrape path:
 * POST /v1/scrape → BullMQ "scrape-realtime" → worker → waitUntilFinished.
 *
 * Measures where the time goes with everything local (own Redis, local
 * fixture website, no internet). See tests/latency/README.md for results.
 *
 * Run (starts redis-server on LATENCY_REDIS_PORT if none answers, and shuts
 * it down again at the end if it started it):
 *   npx tsx tests/latency/queue-overhead.ts
 *
 * Environment (all optional):
 *   LATENCY_REDIS_PORT     6391
 *   LATENCY_DATE           YYYY-MM-DD used in the results file name (default: today, UTC)
 *   LATENCY_ONLY           comma-separated scenario letters, e.g. "B,D"
 *   LATENCY_QUEUE_N        measured jobs per concurrency level (B/C/D), default 500
 *   LATENCY_WARMUP         warm-up requests per run, default 50
 *   LATENCY_IDLE_SAMPLES   idle wake-up samples (E), default 8
 *   LATENCY_IDLE_MS        idle period before each E sample, default 10000
 *   LATENCY_EXTRACT_SMALL_N / LATENCY_EXTRACT_LARGE_N   (F) 300 / 50
 *   LATENCY_FETCH_N        (G) 300
 *   LATENCY_FULL_N         (H) 200
 *   LATENCY_BROWSER_N      browser-tier runs (I, H-classic), default 20
 *   LATENCY_CHROMIUM_PATH  Chromium binary for the browser tiers (default: newest
 *                          chromium-<rev> under PLAYWRIGHT_BROWSERS_PATH)
 */

import os from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { spawnFixtureServer, type FixtureHandle } from './lib/children.js';
import { compactPage, largePage, scrapeResult, seededRandom, smallPage } from './lib/fixtures.js';
import { findChromium } from './lib/chromium-path.js';
import { FifoGate } from './lib/fifo-gate.js';
import { PHASES, type QueuePhases, type RawQueueSample } from './lib/phases.js';
import { QueueHarness, type QueueHarnessOptions } from './lib/queue-harness.js';
import { ensureRedis, parseInfo, shutdownRedis } from './lib/redis-instance.js';
import { bullmqScriptNames, perUnit, tallyCommands, withCommandLog, type CommandCounts } from './lib/redis-monitor.js';
import { runLoad, sleep, type LoadResult } from './lib/runner.js';
import { formatSummary, roundSummary, summarize, summarizeFields, type Summary } from './lib/stats.js';
import { TIMES_FIELD, type ProcessorMode } from './lib/protocol.js';

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function intEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  return value;
}

function dateEnv(): string {
  const raw = process.env.LATENCY_DATE ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`LATENCY_DATE must be YYYY-MM-DD, got "${raw}"`);
  return raw;
}

if (process.env.NODE_ENV === 'production') {
  // The outbound guard refuses 127.0.0.1 in production, and this harness
  // must never loosen it there.
  throw new Error('Refusing to run the latency harness with NODE_ENV=production');
}

const CFG = {
  redisPort: intEnv('LATENCY_REDIS_PORT', 6391),
  date: dateEnv(),
  only: new Set((process.env.LATENCY_ONLY ?? 'A,B,C,D,E,F,G,H,I,Q').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)),
  queueN: intEnv('LATENCY_QUEUE_N', 500),
  warmup: intEnv('LATENCY_WARMUP', 50, 0),
  idleSamples: intEnv('LATENCY_IDLE_SAMPLES', 8, 0),
  idleMs: intEnv('LATENCY_IDLE_MS', 10_000),
  extractSmallN: intEnv('LATENCY_EXTRACT_SMALL_N', 300),
  // Large-page runs are capped: each 500 KB extraction leaves ~30 MB behind in
  // a pool thread, and 300 of them got this harness OOM-killed at 13.4 GB.
  extractLargeN: intEnv('LATENCY_EXTRACT_LARGE_N', 50),
  fetchN: intEnv('LATENCY_FETCH_N', 300),
  fullN: intEnv('LATENCY_FULL_N', 200),
  browserN: intEnv('LATENCY_BROWSER_N', 20),
  resultBytes: 50 * 1024,
  levels: [1, 5, 20],
};

// Fixture URLs are 127.0.0.1: allow them through the SSRF guard (development
// only; allowPrivateNetwork() ignores this in production).
process.env.SCRAPEFORGE_ALLOW_PRIVATE_NETWORK = '1';
process.env.NODE_ENV ??= 'development';
const CHILD_ENV: NodeJS.ProcessEnv = { ...process.env };

const RUN_ID = Date.now().toString(36);

// ─────────────────────────────────────────────────────────────
// Report shapes
// ─────────────────────────────────────────────────────────────

interface RunReport {
  label: string;
  concurrency: number;
  n: number;
  wallMs: number;
  throughputPerSec: number;
  errors: number;
  errorSamples: string[];
  /** Single-value runs (A, F, G). */
  latency?: Summary;
  /** Queue runs (B, C, D, H). */
  phases?: Record<string, Summary>;
  extra?: Record<string, unknown>;
}

const results: Record<string, unknown> = {};
const scenarioErrors: Record<string, string> = {};

function label(concurrency: number): string {
  return concurrency === 1 ? 'sequential' : `concurrency ${concurrency}`;
}

function runReport<T>(name: string, concurrency: number, load: LoadResult<T>, latency?: Summary): RunReport {
  return {
    label: name,
    concurrency,
    n: load.results.length,
    wallMs: Math.round(load.wallMs),
    throughputPerSec: Math.round(load.throughputPerSec * 10) / 10,
    errors: load.errors.length,
    errorSamples: load.errors.slice(0, 3).map((e) => e.message),
    latency: latency ? roundSummary(latency) : undefined,
  };
}

function log(line: string): void {
  console.log(line);
}

/** Times `fn` and returns the latency in ms (sub-ms resolution). */
async function timed(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

function timedSync(fn: () => unknown): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

async function latencyRuns(
  name: string,
  levels: readonly number[],
  n: number,
  warmup: number,
  fn: () => Promise<unknown>,
): Promise<RunReport[]> {
  const runs: RunReport[] = [];
  for (const c of levels) {
    const load = await runLoad({ total: n, concurrency: c, warmup, task: () => timed(fn) });
    const report = runReport(`${name} ${label(c)}`, c, load, summarize(load.results));
    log(`  ${report.label.padEnd(40)} ${formatSummary(report.latency!, 'ms', 3)}${report.errors ? `  errors=${report.errors}` : ''}`);
    runs.push(report);
  }
  return runs;
}

// ─────────────────────────────────────────────────────────────
// A. Baselines
// ─────────────────────────────────────────────────────────────

async function scenarioA(): Promise<unknown> {
  log('\nA. Baselines');
  const noop = async (): Promise<void> => {};
  const noopRuns = await latencyRuns('no-op async call', CFG.levels, 20_000, 1_000, noop);

  const redis = new Redis(CFG.redisPort, '127.0.0.1', { maxRetriesPerRequest: null });
  try {
    const pingRuns = await latencyRuns('redis PING', CFG.levels, 2_000, 200, () => redis.ping());

    // QueueEvents JSON.parses every completed job's return value; worker.ts
    // stringifies the result 3x (cache, result key, SSE complete) plus BullMQ's own.
    const result = scrapeResult('job_x', 'https://example.com/', CFG.resultBytes);
    const text = JSON.stringify(result);
    const stringifyMs = summarize(Array.from({ length: 500 }, () => timedSync(() => JSON.stringify(result))));
    const parseMs = summarize(Array.from({ length: 500 }, () => timedSync(() => JSON.parse(text))));
    log(`  JSON.stringify ${text.length} B result          ${formatSummary(stringifyMs, 'ms', 3)}`);
    log(`  JSON.parse ${text.length} B result              ${formatSummary(parseMs, 'ms', 3)}`);
    return {
      description: 'In-process no-op async call; Redis PING round trip on the harness Redis; JSON cost of a ~50 KB ScrapeResult.',
      noop: noopRuns,
      redisPing: pingRuns,
      json: { resultBytes: text.length, stringify: roundSummary(stringifyMs), parse: roundSummary(parseMs) },
    };
  } finally {
    redis.disconnect();
  }
}

// ─────────────────────────────────────────────────────────────
// Queue scenarios (B, C, D, E, H)
// ─────────────────────────────────────────────────────────────

const SCRIPT_NAMES = bullmqScriptNames();

interface RedisFootprint {
  usedMemoryDeltaBytes: number;
  jobsProcessed: number;
  bytesPerJob: number;
  eventsStreamLength: number;
  eventsStreamBytes: number | null;
  jobHashBytes: number | null;
  resultKeyBytes: number | null;
}

async function usedMemory(redis: Redis): Promise<number> {
  return Number(parseInfo(await redis.info('memory')).used_memory ?? Number.NaN);
}

async function memoryUsage(redis: Redis, key: string): Promise<number | null> {
  const bytes = (await redis.call('MEMORY', 'USAGE', key, 'SAMPLES', '0')) as number | null;
  return bytes ?? null;
}

async function footprint(redis: Redis, queueName: string, before: number, jobs: number, sampleJobId?: string): Promise<RedisFootprint> {
  const after = await usedMemory(redis);
  const eventsKey = `bull:${queueName}:events`;
  return {
    usedMemoryDeltaBytes: after - before,
    jobsProcessed: jobs,
    bytesPerJob: jobs > 0 ? Math.round((after - before) / jobs) : 0,
    eventsStreamLength: Number(await redis.xlen(eventsKey)),
    eventsStreamBytes: await memoryUsage(redis, eventsKey),
    jobHashBytes: sampleJobId ? await memoryUsage(redis, `bull:${queueName}:${sampleJobId}`) : null,
    resultKeyBytes: sampleJobId ? await memoryUsage(redis, `result:${sampleJobId}`) : null,
  };
}

interface QueueScenarioSpec {
  key: string;
  description: string;
  mode: ProcessorMode;
  priority: boolean;
  url: string;
  cacheTtl: number;
  levels: readonly number[];
  n: number;
  /** Warm-up jobs per level (default CFG.warmup). */
  warmup?: number;
  /** Jobs run with MONITOR attached to count Redis commands (timings discarded). */
  commandSampleJobs: number;
  /** Redis keys deleted before the scenario (e.g. the router's domain strategy). */
  resetKeys?: string[];
  browserExecutablePath?: string;
}

function harnessOptions(spec: QueueScenarioSpec): QueueHarnessOptions {
  return {
    redisPort: CFG.redisPort,
    queueName: `latency-${spec.key}-${RUN_ID}`,
    mode: spec.mode,
    priority: spec.priority,
    resultBytes: CFG.resultBytes,
    url: spec.url,
    cacheTtl: spec.cacheTtl,
    env: CHILD_ENV,
    browserExecutablePath: spec.browserExecutablePath,
  };
}

function phaseLine(name: string, phases: Record<string, Summary>): string {
  const p = (k: string, f: keyof Summary) => {
    const v = phases[k]?.[f];
    return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : 'n/a';
  };
  return (
    `  ${name.padEnd(34)} total p50 ${p('total', 'p50')} p95 ${p('total', 'p95')} p99 ${p('total', 'p99')} max ${p('total', 'max')} | ` +
    `enq ${p('enqueue', 'p50')} pickup ${p('pickup', 'p50')} proc ${p('process', 'p50')} ` +
    `finalize ${p('finalize', 'p50')} notify ${p('notify', 'p50')} (p50 ms)`
  );
}

/** Per-job processor details the 'full' worker embeds (route/extract time, tier). */
function fullModeExtras(samples: readonly RawQueueSample[]): Record<string, unknown> {
  const tiers: Record<string, number> = {};
  for (const s of samples) {
    const t = String(s.proc.tierUsed ?? 'unknown');
    tiers[t] = (tiers[t] ?? 0) + 1;
  }
  const byTier = new Map<string, number[]>();
  let attempts = 0;
  for (const s of samples) {
    for (const a of s.proc.attempts ?? []) {
      attempts++;
      const key = `T${a.tier} ${a.outcome}`;
      byTier.set(key, [...(byTier.get(key) ?? []), a.ms]);
    }
  }
  return {
    routeMs: roundSummary(summarize(samples.map((s) => s.proc.routeMs ?? Number.NaN))),
    extractMs: roundSummary(summarize(samples.map((s) => s.proc.extractMs ?? Number.NaN))),
    tierUsed: tiers,
    attemptsPerJob: samples.length ? Math.round((attempts / samples.length) * 100) / 100 : 0,
    attemptMs: Object.fromEntries([...byTier].map(([k, ms]) => [k, roundSummary(summarize(ms))])),
  };
}

async function countCommands(harness: QueueHarness, jobs: number): Promise<CommandCounts | null> {
  if (jobs <= 0) return null;
  const { entries } = await withCommandLog(CFG.redisPort, async () => {
    for (let i = 0; i < jobs; i++) await harness.trip();
  });
  return perUnit(tallyCommands(entries, SCRIPT_NAMES), jobs);
}

async function queueScenario(spec: QueueScenarioSpec): Promise<unknown> {
  log(`\n${spec.key}. ${spec.description}`);
  const admin = new Redis(CFG.redisPort, '127.0.0.1', { maxRetriesPerRequest: null });
  if (spec.resetKeys?.length) await admin.del(...spec.resetKeys);
  const warmup = spec.warmup ?? CFG.warmup;
  let harness: QueueHarness;
  try {
    harness = await QueueHarness.open(harnessOptions(spec));
  } catch (err) {
    admin.disconnect();
    throw err;
  }
  try {
    log(`  clock offset worker−producer ${harness.clock.offsetMs.toFixed(3)} ms (rtt ${harness.clock.rttMs.toFixed(3)} ms)`);
    if (Object.keys(harness.worker.importMs).length) {
      log(`  worker child import ms: ${JSON.stringify(roundRecord(harness.worker.importMs))}`);
    }
    const memBefore = await usedMemory(admin);

    // First job after the producer and worker are connected but nothing has
    // run yet: the "first request after boot" case.
    const cold = await harness.trip();
    const coldPhases = (await harness.phases([cold]))[0];
    log(`  cold first job: ${describePhases(coldPhases)}`);

    let processed = 1;
    let lastJobId = cold.jobId;
    const runs: RunReport[] = [];
    for (const c of spec.levels) {
      const load = await runLoad({ total: spec.n, concurrency: c, warmup, task: () => harness.trip() });
      processed += spec.n + warmup;
      const phases = await harness.phases(load.results);
      const report = runReport(label(c), c, load);
      report.phases = summarizeFields(phases, PHASES);
      if (spec.mode === 'full') report.extra = fullModeExtras(load.results);
      const missing = phases.filter((p) => !Number.isFinite(p.finalize)).length;
      if (missing) report.extra = { ...report.extra, missingCompletedEvents: missing };
      lastJobId = load.results.at(-1)?.jobId ?? lastJobId;
      log(phaseLine(`${label(c)} (${report.throughputPerSec}/s)`, report.phases) + (report.errors ? ` errors=${report.errors}` : ''));
      if (report.extra && spec.mode === 'full') log(`    ${JSON.stringify(report.extra)}`);
      runs.push(report);
    }

    const memory = await footprint(admin, harnessOptions(spec).queueName, memBefore, processed, lastJobId);
    log(`  redis footprint: ${JSON.stringify(memory)}`);
    const commandsPerJob = await countCommands(harness, spec.commandSampleJobs);
    if (commandsPerJob) {
      log(`  redis commands per job: client ${commandsPerJob.clientTotal} (${JSON.stringify(commandsPerJob.client)})`);
    }
    return {
      description: spec.description,
      queueOptions: {
        add: {
          priority: spec.priority ? 1 : 'none',
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 3600 },
          removeOnFail: { age: 86400 },
        },
        worker: { concurrency: 5, stalledInterval: 15_000, maxStalledCount: 2, drainDelay: '5 s (BullMQ default)' },
        waitUntilFinishedTimeoutMs: 60_000,
        processor: spec.mode,
        cacheTtl: spec.cacheTtl,
        url: spec.url,
        browserTiers: Boolean(spec.browserExecutablePath),
        warmupPerLevel: warmup,
      },
      clock: roundRecord({ ...harness.clock }),
      workerImportMs: roundRecord(harness.worker.importMs),
      coldFirstJob: roundRecord(coldPhases),
      runs,
      redisFootprint: memory,
      redisCommandsPerJob: commandsPerJob,
      workerFailures: harness.worker.failures.slice(0, 5),
      workerErrors: harness.worker.errors.slice(0, 5),
    };
  } finally {
    try {
      await harness.close();
    } finally {
      admin.disconnect();
    }
  }
}

function roundRecord<T extends object>(rec: T, digits = 3): Record<string, number> {
  const f = 10 ** digits;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === 'number') out[k] = Math.round(v * f) / f;
  }
  return out;
}

function describePhases(p: QueuePhases): string {
  return PHASES.map((k) => `${k} ${Number.isFinite(p[k]) ? p[k].toFixed(2) : 'n/a'}`).join(', ') + ' ms';
}

// ─────────────────────────────────────────────────────────────
// E. Idle wake-up
// ─────────────────────────────────────────────────────────────

async function scenarioE(): Promise<unknown> {
  log(`\nE. Idle wake-up: worker and QueueEvents idle ~${CFG.idleMs} ms, then one job (x${CFG.idleSamples})`);
  const spec: QueueScenarioSpec = {
    key: 'E',
    description: 'idle wake-up',
    mode: 'noop',
    priority: true,
    url: 'https://example.com/',
    cacheTtl: 0,
    levels: [],
    n: 0,
    commandSampleJobs: 0,
  };
  const harness = await QueueHarness.open(harnessOptions(spec));
  try {
    for (let i = 0; i < 20; i++) await harness.trip();
    // Jitter (±150 ms, seeded) moves the arrival across the BZPOPMIN
    // (drainDelay 5 s) and QueueEvents XREAD (10 s) timeout boundaries.
    const rand = seededRandom(1234);
    const samples: { idleMs: number; phases: QueuePhases }[] = [];
    for (let i = 0; i < CFG.idleSamples; i++) {
      const idleMs = CFG.idleMs + Math.round(rand() * 300 - 150);
      await sleep(idleMs);
      const raw = await harness.trip();
      const phases = (await harness.phases([raw]))[0];
      samples.push({ idleMs, phases });
      log(`  idle ${idleMs} ms → ${describePhases(phases)}`);
    }
    const summary = summarizeFields(samples.map((s) => s.phases), PHASES);
    return {
      description: 'Worker (drainDelay 5 s BZPOPMIN) and QueueEvents (XREAD BLOCK 10 s) idle before each job; noop processor, priority 1.',
      idleMsTarget: CFG.idleMs,
      samples: samples.map((s) => ({ idleMs: s.idleMs, ...roundRecord(s.phases) })),
      phases: summary,
    };
  } finally {
    await harness.close();
  }
}

// ─────────────────────────────────────────────────────────────
// F. Extraction (Piscina pool + in-thread)
// ─────────────────────────────────────────────────────────────

const rssMB = (): number => Math.round(process.memoryUsage().rss / 2 ** 20);

async function scenarioF(): Promise<unknown> {
  log('\nF. Extraction: apps/worker/src/extraction/pipeline.ts extractContent');
  const small = smallPage();
  const large = largePage();
  const url = 'https://example.com/';
  log(`  pages: small ${Buffer.byteLength(small)} B, large ${Buffer.byteLength(large)} B`);

  // Process RSS (pool threads live in this process) after each step: large
  // pages leave memory behind in the pool threads (see README), so the
  // growth is recorded rather than assumed.
  const rss: Record<string, number> = { start: rssMB() };
  const t0 = performance.now();
  const pipeline = await import('../../apps/worker/src/extraction/pipeline.js');
  const importMs = performance.now() - t0;
  const threads = pipeline.extractionPoolInfo.threads;

  let startup: Record<string, unknown>;
  let pooled: RunReport[];
  let gated: RunReport[];
  let samples: { small: { extractionMethod?: string; markdown?: string }; large: { extractionMethod?: string; markdown?: string } };
  try {
    // Immediately after import: threads are spawned but still loading jsdom & co.
    const firstCallMs = await timed(() => pipeline.extractContent(small, url, ['markdown']));
    const burstMs = await timed(() =>
      Promise.all(Array.from({ length: threads * 2 }, () => pipeline.extractContent(small, url, ['markdown']))),
    );
    log(`  import ${importMs.toFixed(1)} ms (esbuild bundle + pool), first call ${firstCallMs.toFixed(1)} ms, then burst of ${threads * 2}: ${burstMs.toFixed(1)} ms; threads=${threads} mode=${pipeline.extractionPoolInfo.mode}`);
    startup = {
      importMs: Math.round(importMs * 10) / 10,
      firstCallMs: Math.round(firstCallMs * 10) / 10,
      burstAfterFirstMs: Math.round(burstMs * 10) / 10,
      threads,
      mode: pipeline.extractionPoolInfo.mode,
    };

    pooled = await latencyRuns('pool small', CFG.levels, CFG.extractSmallN, 30, () => pipeline.extractContent(small, url, ['markdown']));
    rss.afterSmallRuns = rssMB();
    // Same load with excess tasks held in a FIFO gate (<= threads inside
    // Piscina): isolates the cost of Piscina's queue ordering at saturation.
    const gate = new FifoGate(threads);
    gated = await latencyRuns('pool small via FIFO gate', [20], CFG.extractSmallN, 30, () =>
      gate.run(() => pipeline.extractContent(small, url, ['markdown'])),
    );
    pooled.push(...(await latencyRuns('pool large', [1, 5], CFG.extractLargeN, 5, () => pipeline.extractContent(large, url, ['markdown']))));
    rss.afterLargeRuns = rssMB();
    gated.push(
      ...(await latencyRuns('pool large via FIFO gate', [5], CFG.extractLargeN, 5, () =>
        gate.run(() => pipeline.extractContent(large, url, ['markdown'])),
      )),
    );
    rss.afterGatedLargeRuns = rssMB();
    samples = {
      small: await pipeline.extractContent(small, url, ['markdown']),
      large: await pipeline.extractContent(large, url, ['markdown']),
    };
  } finally {
    // Before the main-thread runs: the pool threads hold what they retained.
    await pipeline.shutdownExtractionPool();
  }
  rss.afterPoolShutdown = rssMB();
  log(`  process RSS MB: ${JSON.stringify(rss)}`);

  // Same code on the main thread: the difference to the pool is dispatch
  // and structured-clone cost; the module import is what every pool thread
  // pays at startup.
  const ti = performance.now();
  const impl = await import('../../apps/worker/src/extraction/pipeline-impl.js');
  const implImportMs = performance.now() - ti;
  const direct = [
    ...(await latencyRuns('in-thread small', [1], Math.min(CFG.extractSmallN, 200), 20, () => impl.extractContent(small, url, ['markdown']))),
    ...(await latencyRuns('in-thread large', [1], Math.min(CFG.extractLargeN, 30), 3, () => impl.extractContent(large, url, ['markdown']))),
  ];
  const components = await extractionComponents(small, large, url);

  return {
    description: 'extractContent via the Piscina pool (markdown), small ~1 KB example.com-like page and ~500 KB content page; plus the same implementation on the main thread and its main components.',
    pageBytes: { small: Buffer.byteLength(small), large: Buffer.byteLength(large) },
    startup: { ...startup, implModuleImportMs: Math.round(implImportMs * 10) / 10 },
    extractionMethod: { small: samples.small.extractionMethod, large: samples.large.extractionMethod },
    markdownBytes: { small: samples.small.markdown?.length ?? 0, large: samples.large.markdown?.length ?? 0 },
    processRssMB: rss,
    pooled,
    fifoGated: gated,
    inThread: direct,
    components,
  };
}

/** Costs of the pieces pipeline-impl.ts chains together, on the main thread. */
async function extractionComponents(small: string, large: string, url: string): Promise<unknown> {
  const cheerio = await import('cheerio');
  const { JSDOM } = await import('jsdom');
  const { Readability } = await import('@mozilla/readability');
  const { default: TurndownService } = await import('turndown');
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

  // `sample` returns its own duration so setup (e.g. building a DOM) can be excluded.
  const measureSelf = (n: number, sample: () => number) => {
    for (let i = 0; i < Math.min(5, n); i++) sample();
    return roundSummary(summarize(Array.from({ length: n }, sample)));
  };
  const measure = (n: number, fn: () => unknown) => measureSelf(n, () => timedSync(fn));
  const out: Record<string, unknown> = {};
  for (const [name, html, n] of [['small', small, 100], ['large', large, 20]] as const) {
    const article = new Readability(new JSDOM(html, { url }).window.document).parse();
    out[name] = {
      cheerioLoad: measure(n, () => cheerio.load(html)),
      jsdomConstruct: measure(n, () => new JSDOM(html, { url }).window.close()),
      readabilityParse: measureSelf(n, () => {
        const dom = new JSDOM(html, { url });
        const ms = timedSync(() => new Readability(dom.window.document).parse());
        dom.window.close();
        return ms;
      }),
      turndownOfArticle: article ? measure(n, () => turndown.turndown(article.content)) : null,
    };
    log(`  components ${name}: ${JSON.stringify(Object.fromEntries(Object.entries(out[name] as Record<string, Summary | null>).map(([k, v]) => [k, v?.p50])))} (p50 ms)`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// G. Tier 1 fetch
// ─────────────────────────────────────────────────────────────

async function scenarioG(fixture: FixtureHandle): Promise<unknown> {
  log(`\nG. Tier 1 fetch against local fixture ${fixture.baseUrl}`);
  const smallUrl = `${fixture.baseUrl}/small`;
  const largeUrl = `${fixture.baseUrl}/large`;

  const t0 = performance.now();
  const tier1 = await import('../../apps/worker/src/engine/tier1-http.js');
  const importMs = performance.now() - t0;

  const coldMs = await timed(() => tier1.tier1Fetch(smallUrl));
  const check = await tier1.tier1Fetch(largeUrl);
  log(`  import ${importMs.toFixed(1)} ms; first request (new Impit client + TCP connect) ${coldMs.toFixed(2)} ms; large status ${check.statusCode} ${check.html.length} chars`);

  const tier1Runs = [
    ...(await latencyRuns('tier1Fetch small', CFG.levels, CFG.fetchN, 30, () => tier1.tier1Fetch(smallUrl))),
    ...(await latencyRuns('tier1Fetch large', CFG.levels, CFG.fetchN, 10, () => tier1.tier1Fetch(largeUrl))),
  ];

  // Same request without the redirect/SSRF wrapper and header merging.
  const { Impit } = await import('impit');
  const impit = new Impit({ followRedirects: false });
  const rawImpit = await latencyRuns('raw impit small', [1], CFG.fetchN, 30, async () => (await impit.fetch(smallUrl)).text());
  const nodeFetch = await latencyRuns('node fetch (undici) small', [1], CFG.fetchN, 30, async () => (await fetch(smallUrl)).text());

  const guard = await guardCost();
  return {
    description: 'tier1Fetch (Impit + fetchWithSafeRedirects) of the local fixture over plain HTTP on loopback. No DNS, no TLS, no internet RTT.',
    importMs: Math.round(importMs * 10) / 10,
    coldFirstRequestMs: Math.round(coldMs * 100) / 100,
    tier1: tier1Runs,
    baselines: [...rawImpit, ...nodeFetch],
    guard,
  };
}

/**
 * CPU cost of the SSRF check the API (checkPublicUrl) and tier1Fetch
 * (assertPublicUrl per hop) run, with DNS replaced by an in-memory answer:
 * real DNS latency cannot be measured without a network.
 */
async function guardCost(): Promise<unknown> {
  const shared = await import('@scrapeforge/shared');
  shared.setOutboundPolicyForTests({ lookup: async () => ['93.184.215.14'] });
  try {
    const cached = await latencyRuns('assertPublicUrl (cache hit)', [1], 5_000, 500, () =>
      shared.assertPublicUrl('https://example.com/', { allowPrivate: false }),
    );
    const uncached = await latencyRuns('assertPublicUrl (lookup, no cache)', [1], 5_000, 500, () =>
      shared.assertPublicUrl('https://example.com/', { allowPrivate: false, lookup: async () => ['93.184.215.14'] }),
    );
    return { cacheHit: cached[0], perCallLookup: uncached[0], note: 'DNS latency itself is not measurable offline; verdicts are cached 30 s per hostname (packages/shared/src/net.ts).' };
  } finally {
    shared.setOutboundPolicyForTests(null);
  }
}

// ─────────────────────────────────────────────────────────────
// Q. Router acceptance of example.com-shaped pages
// ─────────────────────────────────────────────────────────────

/**
 * Deterministic check of the router's T1/T2 acceptance gate
 * (isValidContent + calculateQualityScore >= 0.55, router.ts assessTier) on
 * the fixture pages. A rejected page escalates to the browser tiers.
 */
async function scenarioQ(): Promise<unknown> {
  log('\nQ. Router acceptance gate (router.ts assessTier) on the fixture pages');
  const { isValidContent } = await import('../../apps/worker/src/engine/tier1-http.js');
  const { calculateQualityScore } = await import('../../apps/worker/src/extraction/quality-scorer.js');
  const threshold = 0.55; // router.ts MIN_TIER_ACCEPT_QUALITY (not exported)
  const out: Record<string, unknown> = {};
  for (const [name, html] of [['classic example.com (small)', smallPage()], ['compact example.com', compactPage()], ['large', largePage()]] as const) {
    const valid = isValidContent(html, 200, 'https://example.com/');
    const quality = calculateQualityScore(html, 200, 1, 300);
    const accepted = valid && quality.score >= threshold;
    out[name] = { bytes: Buffer.byteLength(html), isValidContent: valid, score: quality.score, signals: quality.signals, acceptedAtT1: accepted };
    log(`  ${name.padEnd(30)} ${String(Buffer.byteLength(html)).padStart(7)} B  score ${quality.score}  ${accepted ? 'accepted at T1' : `REJECTED → escalates (${quality.signals[0]})`}`);
  }
  return { description: 'T1/T2 acceptance decision for each fixture page (threshold 0.55).', threshold, pages: out };
}

// ─────────────────────────────────────────────────────────────
// I. Browser tier (tier4Fetch) against the local fixture
// ─────────────────────────────────────────────────────────────

async function scenarioI(fixture: FixtureHandle, chromium: string | null): Promise<unknown> {
  log('\nI. Browser tier: tier4-browser.ts tier4Fetch / tier4-stealth.ts tier4StealthFetch on the local fixture');
  if (!chromium) {
    log('  skipped: no Chromium binary found (set LATENCY_CHROMIUM_PATH)');
    return { skipped: 'no Chromium binary found' };
  }
  const { openBrowserPool } = await import('./lib/browser.js');
  const t0 = performance.now();
  const pool = await openBrowserPool(chromium);
  const poolInitMs = performance.now() - t0;
  try {
    const tier4 = await import('../../apps/worker/src/engine/tier4-browser.js');
    const stealth = await import('../../apps/worker/src/engine/tier4-stealth.js');
    const withContext = async <T>(fn: (ctx: Awaited<ReturnType<typeof pool.acquire>>) => Promise<T>): Promise<T> => {
      const ctx = await pool.acquire();
      try {
        return await fn(ctx);
      } finally {
        pool.release(ctx);
      }
    };
    const n = CFG.browserN;
    const url = (page: string) => `${fixture.baseUrl}/${page}`;
    const opts = { timeout: 60_000, blockResources: true };
    log(`  chromium ${chromium}; BrowserPool init (launch + 3 warm contexts) ${poolInitMs.toFixed(0)} ms`);

    // Navigation alone, same pooled contexts: the floor the fixed waits sit on.
    const bare = await latencyRuns('bare goto+content compact', [1], n, 3, () =>
      withContext(async (ctx) => {
        const page = await ctx.newPage();
        try {
          await page.goto(url('compact'), { waitUntil: 'domcontentloaded' });
          return await page.content();
        } finally {
          await page.close();
        }
      }),
    );
    const runs = [
      ...(await latencyRuns('tier4Fetch compact', [1, 5], n, 3, () => withContext((ctx) => tier4.tier4Fetch(url('compact'), ctx, opts)))),
      ...(await latencyRuns('tier4Fetch classic', [1], n, 3, () => withContext((ctx) => tier4.tier4Fetch(url('small'), ctx, opts)))),
      ...(await latencyRuns('tier4Fetch large', [1], n, 3, () => withContext((ctx) => tier4.tier4Fetch(url('large'), ctx, opts)))),
      ...(await latencyRuns('tier4StealthFetch compact', [1], Math.min(n, 10), 2, () =>
        withContext((ctx) => stealth.tier4StealthFetch(url('compact'), ctx, opts)),
      )),
    ];
    return {
      description: 'Browser tiers with the worker BrowserPool (Chromium from the local Playwright cache, may differ from the revision patchright pins). Local HTTP fixture: no network RTT, no third-party sub-resources.',
      chromium,
      poolInitMs: Math.round(poolInitMs),
      bareNavigation: bare,
      runs,
    };
  } finally {
    await pool.shutdown();
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

function packageVersion(name: string): string | null {
  try {
    return (JSON.parse(readFileSync(resolve(REPO_ROOT, 'node_modules', name, 'package.json'), 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

async function runScenario(key: string, fn: () => Promise<unknown>): Promise<void> {
  if (!CFG.only.has(key[0])) return;
  try {
    results[key] = await fn();
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    scenarioErrors[key] = message.slice(0, 2000);
    console.error(`  scenario ${key} failed: ${message}`);
  }
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const startedRedis = await ensureRedis(CFG.redisPort);
  const admin = new Redis(CFG.redisPort, '127.0.0.1', { maxRetriesPerRequest: null });
  const redisInfo = parseInfo(await admin.info('server'));
  admin.disconnect();
  let fixture: FixtureHandle | undefined;

  const cpus = os.cpus();
  const meta = {
    date: CFG.date,
    startedAt: startedAt.toISOString(),
    machine: {
      os: `${os.type()} ${os.release()} (${os.platform()}/${os.arch()})`,
      cpuModel: cpus[0]?.model ?? 'unknown',
      cpus: cpus.length,
      availableParallelism: os.availableParallelism(),
      totalMemGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
      loadAvgAtStart: os.loadavg().map((x) => Math.round(x * 100) / 100),
    },
    node: process.version,
    versions: {
      bullmq: packageVersion('bullmq'),
      ioredis: packageVersion('ioredis'),
      piscina: packageVersion('piscina'),
      impit: packageVersion('impit'),
      jsdom: packageVersion('jsdom'),
      redis: redisInfo.redis_version ?? null,
    },
    redis: { port: CFG.redisPort, startedByHarness: startedRedis, persistence: 'off (--save "" --appendonly no) when started by the harness' },
    config: { ...CFG, only: [...CFG.only] },
  };
  log(`Latency harness ${CFG.date}: node ${process.version}, ${cpus.length}x ${meta.machine.cpuModel}, redis ${meta.versions.redis} on :${CFG.redisPort}`);

  try {
    fixture = await spawnFixtureServer(CHILD_ENV);
    const queueSpec = (key: string, description: string, mode: ProcessorMode, priority: boolean): QueueScenarioSpec => ({
      key,
      description,
      mode,
      priority,
      url: 'https://example.com/',
      cacheTtl: 3600,
      levels: CFG.levels,
      n: CFG.queueN,
      commandSampleJobs: 20,
    });

    await runScenario('A', scenarioA);
    // B and D alternate twice so a drift over time cannot masquerade as a priority effect.
    for (const pass of [1, 2]) {
      await runScenario(`B${pass}`, () => queueScenario(queueSpec(`B${pass}`, `BullMQ round trip, noop processor, priority 1 (pass ${pass})`, 'noop', true)));
      await runScenario(`D${pass}`, () => queueScenario(queueSpec(`D${pass}`, `BullMQ round trip, noop processor, NO priority (pass ${pass})`, 'noop', false)));
    }
    await runScenario('C', () =>
      queueScenario(queueSpec('C', "BullMQ round trip, processor does worker.ts's Redis traffic (5x updateProgress, 4 SSE publishes, router domain GET/GET/SET, ~50 KB cache + result SETs, ~50 KB return value)", 'redis-sim', true)),
    );
    await runScenario('E', scenarioE);
    await runScenario('F', scenarioF);
    await runScenario('G', () => scenarioG(fixture!));
    await runScenario('Q', scenarioQ);
    const chromium = findChromium();
    await runScenario('I', () => scenarioI(fixture!, chromium));

    // The router keeps a per-hostname strategy in Redis; every H run starts
    // from an unknown domain, as a first scrape of a new site would.
    const fullSpec = (
      key: string,
      page: 'compact' | 'large' | 'small',
      levels: number[],
      n: number,
      browser?: string,
    ): QueueScenarioSpec => ({
      key,
      description:
        `Full worker path, ${page} page from the local fixture: real SmartRouter (${browser ? 'browser tiers enabled' : 'browser tiers disabled'}), ` +
        'real Piscina extraction, worker.ts Redis traffic; cacheTtl 0 like the tests/perf tier1-example scenario',
      mode: 'full',
      priority: true,
      url: `${fixture!.baseUrl}/${page}`,
      cacheTtl: 0,
      levels,
      n,
      warmup: browser ? 5 : page === 'large' ? 10 : CFG.warmup,
      commandSampleJobs: browser ? 5 : 20,
      resetKeys: [`domain:${new URL(fixture!.baseUrl).hostname}`],
      browserExecutablePath: browser,
    });
    await runScenario('H-compact', () => queueScenario(fullSpec('Hcompact', 'compact', CFG.levels, CFG.fullN)));
    await runScenario('H-large', () => queueScenario(fullSpec('Hlarge', 'large', [1, 5], Math.min(CFG.fullN, CFG.extractLargeN))));
    if (chromium) {
      await runScenario('H-classic', () => queueScenario(fullSpec('Hclassic', 'small', [1, 5], CFG.browserN, chromium)));
    } else if (CFG.only.has('H')) {
      scenarioErrors['H-classic'] = 'not measured: no Chromium binary found (set LATENCY_CHROMIUM_PATH)';
    }
  } finally {
    await fixture?.stop();
    if (startedRedis) shutdownRedis(CFG.redisPort);
  }

  const finishedAt = new Date();
  const out = {
    meta: { ...meta, finishedAt: finishedAt.toISOString(), durationSec: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000) },
    notes: {
      timestamps: 'Producer and worker run in separate processes; worker timestamps are corrected by the measured clock offset (see each scenario.clock).',
      phases: 'enqueue = Queue.add; pickup = add resolved → processor start; process = processor body; finalize = processor end → worker completed event (moveToFinished); notify = completed → waitUntilFinished resolved; afterProcess = finalize + notify; overhead = total − process.',
      field: TIMES_FIELD,
    },
    scenarios: results,
    scenarioErrors,
  };
  const file = resolve(REPO_ROOT, 'tests', 'latency', 'results', `queue-overhead-${CFG.date}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  log(`\nWrote ${file}`);
  if (Object.keys(scenarioErrors).length) {
    log(`Scenarios with errors: ${Object.keys(scenarioErrors).join(', ')}`);
    process.exitCode = 1;
  }
}

main().then(
  // Piscina/Impit/ioredis handles can keep the loop alive after a failed scenario.
  () => process.exit(process.exitCode ?? 0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
