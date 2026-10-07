/* eslint-disable no-console */
/**
 * Retained-memory probe for the extraction path. Each case runs N times with
 * a forced full GC before the baseline and after the loop, so whatever heap
 * growth remains is memory the code keeps, not garbage V8 has not collected yet.
 *
 * Run (needs --expose-gc; about 2 min):
 *   node --expose-gc --import tsx tests/latency/memory-probe.ts
 * Writes tests/latency/results/memory-probe-<date>.json (LATENCY_DATE or today, UTC).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { largePage, smallPage } from './lib/fixtures.js';
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
  console.log(`${name.padEnd(48)} +${result.retainedHeapMB} MB over ${iterations} (${result.retainedPerCallKB} KB/call), p50 ${result.callMs.p50} ms`);
  return result;
}

async function main(): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const { Readability } = await import('@mozilla/readability');
  const { parseHTML } = await import('linkedom');
  const impl = await import('../../apps/worker/src/extraction/pipeline-impl.js');
  const small = smallPage();
  const large = largePage();

  const cases = [
    await probe('pipeline-impl extractContent, small page', 300, () => impl.extractContent(small, URL_, ['markdown'])),
    await probe('pipeline-impl extractContent, 500 KB page', 15, () => impl.extractContent(large, URL_, ['markdown'])),
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
  ];

  const file = resolve(dirname(fileURLToPath(import.meta.url)), 'results', `memory-probe-${date}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ date, node: process.version, note: 'heapUsed growth after forced full GC (gc() twice before and after)', cases }, null, 2)}\n`,
  );
  console.log(`Wrote ${file}`);
}

await main();
