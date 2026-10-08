/* eslint-disable no-console */
/**
 * Retained-memory probe for the extraction path. Each in-thread case runs N
 * times with a forced full GC before the baseline and after the loop, so
 * whatever heap growth remains is memory the code keeps, not garbage V8 has
 * not collected yet. A final case drives the Piscina pool (pipeline.ts) the
 * way the 2026-10-07 run grew it to 6.4 GB and records process RSS, which
 * includes the threads' heaps.
 *
 * Run (needs --expose-gc; about 3 min):
 *   node --expose-gc --import tsx tests/latency/memory-probe.ts
 * Writes tests/latency/results/memory-probe-<date>.json (LATENCY_DATE or today, UTC).
 *
 * Options (environment):
 *   MEMORY_PROBE_BASELINE_IMPL=<path>  also probe another pipeline-impl.ts, e.g. the
 *     pre-linkedom version: `git show 2b0ac9f:apps/worker/src/extraction/pipeline-impl.ts`
 *     saved under apps/worker/ (so its imports resolve).
 *   MEMORY_PROBE_SKIP_POOL=1  skip the pool RSS case.
 *   MEMORY_PROBE_POOL_ONLY=1  run only the pool RSS case (it runs first either way, so the
 *     in-thread cases' retained garbage does not inflate the process RSS it records).
 *   MEMORY_PROBE_POOL_MODULE=<path>  drive another pipeline.ts (e.g. the pre-change version).
 *   MEMORY_PROBE_OUT=<path>  write the results there instead.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { largePage, smallPage } from './lib/fixtures.js';
import { runLoad } from './lib/runner.js';
import { summarize, roundSummary } from './lib/stats.js';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) {
  console.error('Run with --expose-gc: node --expose-gc --import tsx tests/latency/memory-probe.ts');
  process.exit(2);
}
const date = process.env.LATENCY_DATE ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`LATENCY_DATE must be YYYY-MM-DD, got "${date}"`);

const URL_ = 'https://example.com/';
const MB = 2 ** 20;

interface CaseResult {
  name: string;
  iterations: number;
  retainedHeapMB: number;
  retainedPerCallKB: number;
  callMs: ReturnType<typeof roundSummary>;
}

async function probe(name: string, iterations: number, call: () => unknown): Promise<CaseResult> {
  for (let i = 0; i < 5; i++) await call(); // module-level caches and JIT are not a leak
  gc!();
  gc!();
  const base = process.memoryUsage().heapUsed;
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await call();
    times.push(performance.now() - t0);
  }
  gc!();
  gc!();
  const retained = process.memoryUsage().heapUsed - base;
  const result = {
    name,
    iterations,
    retainedHeapMB: Math.round((retained / MB) * 10) / 10,
    retainedPerCallKB: Math.round(retained / iterations / 1024),
    callMs: roundSummary(summarize(times)),
  };
  console.log(`${name.padEnd(52)} +${result.retainedHeapMB} MB over ${iterations} (${result.retainedPerCallKB} KB/call), p50 ${result.callMs.p50} ms`);
  return result;
}

type ImplModule = typeof import('../../apps/worker/src/extraction/pipeline-impl.js');
type PipelineModule = typeof import('../../apps/worker/src/extraction/pipeline.js');
type PipelineCore = Pick<PipelineModule, 'extractContent' | 'extractionPoolInfo' | 'shutdownExtractionPool'>;

async function implCases(label: string, impl: ImplModule, small: string, large: string): Promise<CaseResult[]> {
  return [
    await probe(`${label} extractContent, small page`, 300, () => impl.extractContent(small, URL_, ['markdown'])),
    await probe(`${label} extractContent, 500 KB page`, 15, () => impl.extractContent(large, URL_, ['markdown'])),
    await probe(`${label} extractContent, 500 KB page, all formats`, 15, () =>
      impl.extractContent(large, URL_, ['markdown', 'text', 'html'])),
  ];
}

interface PoolResult {
  threads: number;
  concurrency: number;
  rssMB: Record<string, number>;
  recycledThreads: number;
  errors: number;
}

/** The pool sequence behind the README's RSS table, at worker.ts's concurrency of 5. */
async function poolCase(small: string, large: string): Promise<PoolResult> {
  const rss = () => Math.round(process.memoryUsage().rss / MB);
  const rssMB: Record<string, number> = { start: rss() };
  const modulePath = process.env.MEMORY_PROBE_POOL_MODULE;
  const pipeline = (modulePath
    ? await import(pathToFileURL(resolve(modulePath)).href)
    : await import('../../apps/worker/src/extraction/pipeline.js')) as Partial<PipelineModule> & PipelineCore;
  // Older versions have no warmExtractionPool(): one call per thread loads them.
  if (pipeline.warmExtractionPool) await pipeline.warmExtractionPool();
  else await Promise.all(Array.from({ length: pipeline.extractionPoolInfo.threads }, () => pipeline.extractContent(small, URL_, ['markdown'])));
  rssMB.afterWarmUp = rss();
  let errors = 0;
  const run = async (total: number, html: string) => {
    const r = await runLoad({ total, concurrency: 5, task: () => pipeline.extractContent(html, URL_, ['markdown']) });
    errors += r.errors.length;
  };
  await run(1_000, small);
  rssMB.after1000Small = rss();
  await run(100, large);
  rssMB.after100Large = rss();
  await run(50, large);
  rssMB.after150Large = rss();
  const threads = pipeline.extractionPoolInfo.threads;
  const recycledThreads = pipeline.getExtractionPoolStats?.().recycledThreads ?? 0;
  await pipeline.shutdownExtractionPool();
  gc!();
  rssMB.afterShutdown = rss();
  console.log(`pool (threads=${threads}, c5) RSS MB ${JSON.stringify(rssMB)} recycled=${recycledThreads} errors=${errors}`);
  return { threads, concurrency: 5, rssMB, recycledThreads, errors };
}

async function main(): Promise<void> {
  const small = smallPage();
  const large = largePage();
  const pool = process.env.MEMORY_PROBE_SKIP_POOL === '1' ? null : await poolCase(small, large);
  const cases = process.env.MEMORY_PROBE_POOL_ONLY === '1' ? [] : await threadCases(small, large);

  const file = process.env.MEMORY_PROBE_OUT
    ? resolve(process.env.MEMORY_PROBE_OUT)
    : resolve(dirname(fileURLToPath(import.meta.url)), 'results', `memory-probe-${date}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({
      date,
      node: process.version,
      note: 'heapUsed growth after forced full GC (gc() twice before and after); pool: process RSS',
      cases,
      pool,
    }, null, 2)}\n`,
  );
  console.log(`Wrote ${file}`);
}

async function threadCases(small: string, large: string): Promise<CaseResult[]> {
  const { JSDOM } = await import('jsdom');
  const { Readability } = await import('@mozilla/readability');
  const { parseHTML } = await import('linkedom');
  const impl = await import('../../apps/worker/src/extraction/pipeline-impl.js');

  const cases = await implCases('pipeline-impl', impl, small, large);
  const baselinePath = process.env.MEMORY_PROBE_BASELINE_IMPL;
  if (baselinePath) {
    const baseline = (await import(pathToFileURL(resolve(baselinePath)).href)) as ImplModule;
    cases.push(...(await implCases('baseline', baseline, small, large)));
  }
  cases.push(
    await probe('new JSDOM(small) without close()', 300, () => new JSDOM(small, { url: URL_ })),
    await probe('new JSDOM(small) + window.close()', 300, () => new JSDOM(small, { url: URL_ }).window.close()),
    await probe('JSDOM + Readability, 500 KB page', 15, () => {
      const dom = new JSDOM(large, { url: URL_ });
      new Readability(dom.window.document).parse();
      dom.window.close();
    }),
    await probe('linkedom parseHTML + Readability, 500 KB page', 15, () => {
      // Readability is typed against the DOM lib; linkedom implements the parts it uses.
      const { document } = parseHTML(large);
      new Readability(document as unknown as Document).parse();
    }),
  );
  return cases;
}

await main();
