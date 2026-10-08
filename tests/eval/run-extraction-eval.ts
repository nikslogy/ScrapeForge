// Live extraction benchmark: the fixture corpus through the real engine and
// real models (createDefaultModelClient), one model at a time.
//
//   npx tsx --env-file=.env tests/eval/run-extraction-eval.ts \
//     --models openrouter:google/gemini-2.5-flash,openrouter:openai/gpt-4.1-mini \
//     --repeat 3 --concurrency 4
//
// Options:
//   --models <keys>       comma-separated registry keys; each is benchmarked on
//                         its own (EXTRACT_MODELS=<key>, no fallbacks).
//                         Default: EXTRACT_MODELS, else openrouter:google/gemini-2.5-flash
//   --repeat <n>          runs per fixture (default 1)
//   --fixtures <ids>      comma-separated fixture ids (default: all)
//   --no-structured       disable structured data and recipes: pure LLM path
//   --concurrency <n>     extractions in flight (default 4)
//   --max-cost <usd>      spend cap per extraction (default 0.10)
//   --timeout <ms>        deadline per extraction (default 120000)
//   --out <dir>           results directory (default tests/eval/results)
//
// Per fixture it records status, precision/recall (tests/engine/scoring.ts),
// latency, tokens, cost, attempts and the resolved model/provider; per model
// it aggregates micro precision/recall, status accuracy, p50/p95 latency,
// cost per correct field and failures by category, then writes
// <out>/<ISO date>-<model>.json and .md. Without an API key, or when the
// network is unreachable, it says so and exits 0. Keys are never printed.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractStructured } from '../../apps/worker/src/extract/engine.js';
import { createDefaultModelClient, PROVIDER_KEY_ENV, parseModelKey, type ModelClient } from '../../apps/worker/src/extract/llm/index.js';
import type { ExtractionOutcome, ExtractRequest } from '../../apps/worker/src/extract/types.js';
import { aggregate, formatSummary, scoreExtraction, type ScoreResult } from '../engine/scoring.js';
import { fixtureIds, loadFixtures, type Fixture } from '../fixtures/extraction/load.js';

// ─────────────────────────────────────────────────────────────
// Arguments
// ─────────────────────────────────────────────────────────────

export interface EvalArgs {
  models: string[];
  repeat: number;
  fixtures: string[];
  noStructured: boolean;
  concurrency: number;
  maxCostUsd: number;
  timeoutMs: number;
  outDir: string;
}

const DEFAULT_MODEL = 'openrouter:google/gemini-2.5-flash';
const DEFAULT_OUT = fileURLToPath(new URL('./results', import.meta.url));

function list(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function positiveInt(name: string, value: string | undefined, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be an integer between 1 and ${max}`);
  return n;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): EvalArgs {
  const args: EvalArgs = {
    models: list(env.EXTRACT_MODELS ?? '').length > 0 ? list(env.EXTRACT_MODELS as string) : [DEFAULT_MODEL],
    repeat: 1,
    fixtures: [],
    noStructured: false,
    concurrency: 4,
    maxCostUsd: 0.1,
    timeoutMs: 120_000,
    outDir: DEFAULT_OUT,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--models':
        args.models = list(value());
        break;
      case '--repeat':
        args.repeat = positiveInt('--repeat', value(), 100);
        break;
      case '--fixtures':
        args.fixtures = list(value());
        break;
      case '--no-structured':
        args.noStructured = true;
        break;
      case '--concurrency':
        args.concurrency = positiveInt('--concurrency', value(), 64);
        break;
      case '--max-cost': {
        const n = Number(value());
        if (!Number.isFinite(n) || n < 0 || n > 10) throw new Error('--max-cost must be a number between 0 and 10');
        args.maxCostUsd = n;
        break;
      }
      case '--timeout':
        args.timeoutMs = positiveInt('--timeout', value(), 600_000);
        break;
      case '--out':
        args.outDir = value();
        break;
      case '--help':
      case '-h':
        throw new HelpRequested();
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }
  if (args.models.length === 0) throw new Error('--models is empty');
  for (const m of args.models) if (!parseModelKey(m)) throw new Error(`invalid model key ${JSON.stringify(m)} (expected provider:model)`);
  const known = new Set(fixtureIds());
  const unknown = args.fixtures.filter((f) => !known.has(f));
  if (unknown.length > 0) throw new Error(`unknown fixture(s): ${unknown.join(', ')}`);
  return args;
}

class HelpRequested extends Error {}

// ─────────────────────────────────────────────────────────────
// Running
// ─────────────────────────────────────────────────────────────

export interface RunRecord {
  fixture: string;
  repeat: number;
  status: ExtractionOutcome['status'];
  expectedStatus: Fixture['expectStatus'];
  method: ExtractionOutcome['method'];
  precision: number;
  recall: number;
  correct: number;
  returned: number;
  expected: number;
  latencyMs: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  truncated: boolean;
  resolvedModels: string[];
  resolvedProviders: string[];
  attempts: Array<{ ok: boolean; purpose: string; errorCategory?: string; latencyMs: number; resolvedModel?: string; resolvedProvider?: string }>;
  warnings: string[];
  missing: Array<{ path: string; reason: string }>;
  /** Engine error (a bug), if the run threw. */
  error?: string;
}

async function runOne(fixture: Fixture, repeat: number, client: ModelClient, args: EvalArgs): Promise<{ record: RunRecord; score: ScoreResult }> {
  const req: ExtractRequest = {
    html: fixture.html,
    url: fixture.url,
    schema: fixture.schema,
    tenantId: 'eval',
    deadlineMs: Date.now() + args.timeoutMs,
    maxCostUsd: args.maxCostUsd,
    ...(args.noStructured ? { disable: ['structured', 'recipe'] as ExtractRequest['disable'] } : {}),
  };
  const t0 = performance.now();
  let outcome: ExtractionOutcome;
  let error: string | undefined;
  try {
    outcome = await extractStructured(req, { modelClient: client, recipeStore: null, learning: 'off' });
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    outcome = {
      data: null, status: 'failed', method: 'none', schemaValid: false, evidence: [], missing: [], warnings: ['engine_error'],
      scope: { url: fixture.url, snapshotHash: '', description: 'page-snapshot', blocksTotal: 0, blocksSentToModel: 0, recordsDetected: 0, truncated: false },
      llm: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, attempts: [] }, timings: {},
    };
  }
  const latencyMs = Math.round(performance.now() - t0);
  const score = scoreExtraction(fixture, outcome.data);
  const attempts = outcome.llm.attempts.map((a) => ({
    ok: a.ok,
    purpose: a.purpose,
    latencyMs: a.latencyMs,
    ...(a.errorCategory ? { errorCategory: a.errorCategory } : {}),
    ...(a.resolvedModel ? { resolvedModel: a.resolvedModel } : {}),
    ...(a.resolvedProvider ? { resolvedProvider: a.resolvedProvider } : {}),
  }));
  const record: RunRecord = {
    fixture: fixture.id,
    repeat,
    status: outcome.status,
    expectedStatus: fixture.expectStatus,
    method: outcome.method,
    precision: score.valuePrecision,
    recall: score.valueRecall,
    correct: score.counts.correct,
    returned: score.counts.returned,
    expected: score.counts.expected,
    latencyMs,
    calls: outcome.llm.calls,
    inputTokens: outcome.llm.inputTokens,
    outputTokens: outcome.llm.outputTokens,
    costUsd: outcome.llm.costUsd,
    truncated: outcome.scope.truncated,
    resolvedModels: [...new Set(outcome.llm.attempts.map((a) => a.resolvedModel).filter((m): m is string => !!m))],
    resolvedProviders: [...new Set(outcome.llm.attempts.map((a) => a.resolvedProvider).filter((p): p is string => !!p))],
    attempts,
    warnings: outcome.warnings,
    missing: outcome.missing.map((m) => ({ path: m.path, reason: m.reason })),
  };
  if (error) record.error = error;
  return { record, score };
}

async function pool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ─────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export interface ModelSummary {
  model: string;
  runs: number;
  microPrecision: number;
  microRecall: number;
  macroPrecision: number;
  macroRecall: number;
  statusAccuracy: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  totalCostUsd: number;
  correctFields: number;
  costPerCorrectFieldUsd: number | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Failed attempts by error category, plus engine errors. */
  failuresByCategory: Record<string, number>;
  statuses: Record<string, number>;
}

export function summarize(model: string, records: RunRecord[], scores: ScoreResult[]): ModelSummary {
  const agg = aggregate(scores);
  const failures: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  for (const r of records) {
    statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    for (const a of r.attempts) if (!a.ok) failures[a.errorCategory ?? 'unknown'] = (failures[a.errorCategory ?? 'unknown'] ?? 0) + 1;
    if (r.error) failures.engine_error = (failures.engine_error ?? 0) + 1;
  }
  const totalCost = records.reduce((s, r) => s + r.costUsd, 0);
  const correct = records.reduce((s, r) => s + r.correct, 0);
  return {
    model,
    runs: records.length,
    microPrecision: agg.micro.valuePrecision,
    microRecall: agg.micro.valueRecall,
    macroPrecision: agg.macro.valuePrecision,
    macroRecall: agg.macro.valueRecall,
    statusAccuracy: records.length === 0 ? 0 : records.filter((r) => r.status === r.expectedStatus).length / records.length,
    latencyP50Ms: percentile(records.map((r) => r.latencyMs), 50),
    latencyP95Ms: percentile(records.map((r) => r.latencyMs), 95),
    totalCostUsd: totalCost,
    correctFields: correct,
    costPerCorrectFieldUsd: correct === 0 ? null : totalCost / correct,
    calls: records.reduce((s, r) => s + r.calls, 0),
    inputTokens: records.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: records.reduce((s, r) => s + r.outputTokens, 0),
    failuresByCategory: failures,
    statuses,
  };
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

export function markdownReport(summary: ModelSummary, records: RunRecord[], scores: ScoreResult[], args: EvalArgs, startedAt: string): string {
  const lines: string[] = [];
  lines.push(`# Extraction eval: ${summary.model}`);
  lines.push('');
  lines.push(`Run ${startedAt}; ${summary.runs} extraction(s), repeat ${args.repeat}, ${args.noStructured ? 'pure LLM path (structured data and recipes disabled)' : 'full engine'}, spend cap $${args.maxCostUsd}/extraction.`);
  lines.push('');
  lines.push('| metric | value |');
  lines.push('|---|---|');
  lines.push(`| value precision (micro / macro) | ${pct(summary.microPrecision)} / ${pct(summary.macroPrecision)} |`);
  lines.push(`| value recall (micro / macro) | ${pct(summary.microRecall)} / ${pct(summary.macroRecall)} |`);
  lines.push(`| status accuracy | ${pct(summary.statusAccuracy)} |`);
  lines.push(`| latency p50 / p95 | ${summary.latencyP50Ms} ms / ${summary.latencyP95Ms} ms |`);
  lines.push(`| model calls / tokens in / out | ${summary.calls} / ${summary.inputTokens} / ${summary.outputTokens} |`);
  lines.push(`| total cost | $${summary.totalCostUsd.toFixed(6)} |`);
  lines.push(`| cost per correct field | ${summary.costPerCorrectFieldUsd === null ? '-' : `$${summary.costPerCorrectFieldUsd.toFixed(7)}`} |`);
  lines.push(`| statuses | ${Object.entries(summary.statuses).map(([k, v]) => `${k} ${v}`).join(', ')} |`);
  lines.push(`| failures by category | ${Object.entries(summary.failuresByCategory).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} |`);
  lines.push('');
  lines.push('## Per fixture');
  lines.push('');
  lines.push('| fixture | run | status (expected) | P | R | latency | calls | cost | resolved model |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of records) {
    lines.push(
      `| ${r.fixture} | ${r.repeat} | ${r.status} (${r.expectedStatus}) | ${pct(r.precision)} | ${pct(r.recall)} | ${r.latencyMs} ms | ${r.calls} | $${r.costUsd.toFixed(6)} | ${r.resolvedModels.join(', ') || '-'}${r.resolvedProviders.length > 0 ? ` via ${r.resolvedProviders.join(', ')}` : ''} |`,
    );
  }
  lines.push('');
  lines.push('## Scores (scoring.ts)');
  lines.push('');
  lines.push('```');
  lines.push(formatSummary(aggregate(scores)));
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function fileSafe(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const NETWORK_CATEGORIES = new Set(['network', 'timeout']);

function allAttemptsIn(records: RunRecord[], categories: Set<string>): boolean {
  const attempts = records.flatMap((r) => r.attempts);
  return attempts.length > 0 && attempts.every((a) => !a.ok && categories.has(a.errorCategory ?? ''));
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let args: EvalArgs;
  try {
    args = parseArgs(argv, env);
  } catch (err) {
    if (err instanceof HelpRequested) {
      console.log('usage: npx tsx tests/eval/run-extraction-eval.ts [--models k1,k2] [--repeat N] [--fixtures ids] [--no-structured] [--concurrency N] [--max-cost USD] [--timeout MS] [--out DIR]');
      return 0;
    }
    console.error(`run-extraction-eval: ${(err as Error).message}`);
    return 2;
  }
  const fixtures = loadFixtures(args.fixtures.length > 0 ? { ids: args.fixtures } : {});
  const startedAt = new Date().toISOString();
  let ran = 0;

  for (const model of args.models) {
    const provider = parseModelKey(model)!.provider;
    const keyEnv = PROVIDER_KEY_ENV[provider];
    if (!env[keyEnv] || env[keyEnv]!.trim() === '') {
      console.log(`[eval] ${model}: skipped, ${keyEnv} is not set (export it or use --env-file; see tests/eval/README.md)`);
      continue;
    }
    let client: ModelClient;
    try {
      client = createDefaultModelClient({ ...env, EXTRACT_MODELS: model });
    } catch (err) {
      console.log(`[eval] ${model}: skipped, ${(err as Error).message}`);
      continue;
    }
    for (const w of client.warnings) console.log(`[eval] ${model}: ${w}`);
    if (client.models.length === 0) {
      console.log(`[eval] ${model}: skipped, no usable model`);
      continue;
    }

    // One cheap probe first: an unreachable network or a bad key should end
    // the run with a clear message, not after 15 × repeat failed extractions.
    const probeFixture = fixtures.find((f) => f.expectStatus !== 'failed') ?? fixtures[0];
    const probe = await runOne(probeFixture, 0, client, args);
    if (allAttemptsIn([probe.record], NETWORK_CATEGORIES)) {
      console.log(`[eval] ${model}: the provider is unreachable (network blocked or offline); nothing written.`);
      continue;
    }
    if (allAttemptsIn([probe.record], new Set(['auth']))) {
      console.log(`[eval] ${model}: authentication failed; check ${keyEnv}. Nothing written.`);
      continue;
    }

    console.log(`[eval] ${model}: ${fixtures.length} fixture(s) × ${args.repeat}, concurrency ${args.concurrency}`);
    const tasks = fixtures.flatMap((f) => Array.from({ length: args.repeat }, (_, r) => ({ f, r: r + 1 })));
    const results = await pool(tasks, args.concurrency, async ({ f, r }) => {
      const res = await runOne(f, r, client, args);
      const rec = res.record;
      console.log(
        `[eval] ${model} ${f.id}#${r}: ${rec.status} P=${rec.precision.toFixed(3)} R=${rec.recall.toFixed(3)} ${rec.latencyMs}ms calls=${rec.calls} $${rec.costUsd.toFixed(6)}${rec.error ? ` ERROR ${rec.error}` : ''}`,
      );
      return res;
    });
    const records = results.map((r) => r.record);
    const scores = results.map((r) => r.score);
    const summary = summarize(model, records, scores);
    const stamp = startedAt.replace(/[:.]/g, '-');
    mkdirSync(args.outDir, { recursive: true });
    const base = join(args.outDir, `${stamp}-${fileSafe(model)}${args.noStructured ? '-llm-only' : ''}`);
    writeFileSync(`${base}.json`, `${JSON.stringify({ startedAt, args: { ...args, outDir: undefined }, summary, records }, null, 2)}\n`);
    writeFileSync(`${base}.md`, markdownReport(summary, records, scores, args, startedAt));
    console.log(
      `[eval] ${model}: P=${pct(summary.microPrecision)} R=${pct(summary.microRecall)} status=${pct(summary.statusAccuracy)} p50=${summary.latencyP50Ms}ms p95=${summary.latencyP95Ms}ms cost=$${summary.totalCostUsd.toFixed(6)} → ${base}.{json,md}`,
    );
    ran++;
  }
  if (ran === 0) console.log('[eval] no model was benchmarked (see messages above). Exiting without results.');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`run-extraction-eval failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
