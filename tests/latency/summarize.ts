/* eslint-disable no-console */
/**
 * Prints markdown tables from a queue-overhead results file.
 *   npx tsx tests/latency/summarize.ts tests/latency/results/queue-overhead-<date>.json
 */

import { readFileSync } from 'node:fs';

interface Summary {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

interface Run {
  label: string;
  concurrency: number;
  n: number;
  throughputPerSec: number;
  errors: number;
  latency?: Summary;
  phases?: Record<string, Summary>;
  extra?: Record<string, unknown>;
}

const fmt = (x: unknown, digits = 2): string => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(digits) : 'n/a');

function latencyTable(runs: readonly Run[]): string {
  const rows = runs.map(
    (r) =>
      `| ${r.label} | ${r.n} | ${fmt(r.latency?.p50)} | ${fmt(r.latency?.p95)} | ${fmt(r.latency?.p99)} | ${fmt(r.latency?.max)} | ${r.errors} |`,
  );
  return ['| run | n | p50 ms | p95 ms | p99 ms | max ms | errors |', '|---|---:|---:|---:|---:|---:|---:|', ...rows].join('\n');
}

function queueTable(runs: readonly Run[]): string {
  const rows = runs.map((r) => {
    const p = r.phases ?? {};
    return (
      `| ${r.label} | ${r.n} | ${fmt(p.total?.p50)} | ${fmt(p.total?.p95)} | ${fmt(p.total?.p99)} | ${fmt(p.total?.max)} | ` +
      `${fmt(p.enqueue?.p50)} | ${fmt(p.pickup?.p50)} | ${fmt(p.process?.p50)} | ${fmt(p.afterProcess?.p50)} | ${fmt(p.overhead?.p50)} | ${fmt(r.throughputPerSec, 1)} | ${r.errors} |`
    );
  });
  return [
    '| level | n | total p50 | p95 | p99 | max | enqueue p50 | pickup p50 | process p50 | after-process p50 | overhead p50 | jobs/s | errors |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows,
  ].join('\n');
}

function isRunArray(value: unknown): value is Run[] {
  return Array.isArray(value) && value.every((r) => typeof r === 'object' && r !== null && 'label' in r);
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: tsx tests/latency/summarize.ts <results.json>');
    process.exit(2);
  }
  const data = JSON.parse(readFileSync(file, 'utf8')) as { scenarios: Record<string, Record<string, unknown>>; scenarioErrors?: Record<string, string> };
  for (const [key, scenario] of Object.entries(data.scenarios)) {
    console.log(`\n### ${key}${typeof scenario.description === 'string' ? ` — ${scenario.description}` : ''}\n`);
    for (const [field, value] of Object.entries(scenario)) {
      if (!isRunArray(value) || value.length === 0) continue;
      console.log(`${field}:\n`);
      console.log(value[0].phases ? queueTable(value) : latencyTable(value));
      for (const r of value) if (r.extra) console.log(`\n${r.label} extra: \`${JSON.stringify(r.extra)}\``);
      console.log('');
    }
  }
  for (const [key, message] of Object.entries(data.scenarioErrors ?? {})) {
    console.log(`\n**${key} failed:** ${message.split('\n')[0]}`);
  }
}

main();
