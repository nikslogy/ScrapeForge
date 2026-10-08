// Thread memory bounds, in child processes so NODE_OPTIONS can be set:
// --max-old-space-size (this sandbox sets 8192) overrides worker
// resourceLimits for the whole process.
// - Without it, a page whose parse exceeds EXTRACTION_THREAD_MAX_OLD_MB kills
//   only its thread: a clear EXTRACTION_OUT_OF_MEMORY error, a replacement
//   thread, and the next extraction succeeds.
// - With it, the pool warns that the limit is not in effect and replaces a
//   thread whose heap in use crossed EXTRACTION_THREAD_RECYCLE_HEAP_MB.
// The two entry modules are compiled the way pipeline.test.ts does it.
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(here, '..', '..');
const srcExtraction = resolve(workerRoot, 'src', 'extraction');
const scratch = resolve(workerRoot, '.extraction-cache', `mem-check-${process.pid}`);
const outDir = resolve(scratch, 'extraction');
const script = resolve(scratch, 'run.mjs');

beforeAll(async () => {
  mkdirSync(outDir, { recursive: true });
  const { build } = await import('esbuild');
  await build({
    entryPoints: [resolve(srcExtraction, 'pipeline.ts'), resolve(srcExtraction, 'pipeline-worker.ts')],
    outdir: outDir,
    bundle: true,
    packages: 'external',
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'warning',
  });
  writeFileSync(
    script,
    `const mod = await import(process.argv[2]);
await mod.warmExtractionPool();
const blocks = Number(process.argv[3]);
const big = '<html><head><title>Big</title></head><body>' + '<div class="c"><p>para <b>x</b> <a href="/y">l</a></p></div>'.repeat(blocks) + '</body></html>';
const out = {};
try {
  const r = await mod.extractContent(big, 'https://example.com/big', ['markdown']);
  out.big = { ok: true, method: r.extractionMethod };
} catch (err) {
  out.big = { ok: false, name: err.name, code: err.code, message: err.message };
}
const small = await mod.extractContent('<html><head><title>S</title></head><body><article><p>' + 'Small page text. '.repeat(30) + '</p></article></body></html>', 'https://example.com/', ['markdown']);
out.small = small.markdown.slice(0, 39);
out.stats = mod.getExtractionPoolStats();
await mod.shutdownExtractionPool();
console.log('RESULT ' + JSON.stringify(out));
`,
  );
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function runChild(env: Record<string, string>, blocks: number) {
  const pipelineUrl = pathToFileURL(resolve(outDir, 'pipeline.js')).href;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [script, pipelineUrl, String(blocks)], {
    env: { ...process.env, EXTRACTION_POOL_SIZE: '2', ...env },
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
  expect(line, `${stdout}\n${stderr}`).toBeDefined();
  return { out: JSON.parse(line!.slice('RESULT '.length)), stderr, stdout };
}

describe('extraction thread memory limits', () => {
  it('fails one oversized extraction with EXTRACTION_OUT_OF_MEMORY and keeps serving', async () => {
    const { out } = await runChild({ NODE_OPTIONS: '', EXTRACTION_THREAD_MAX_OLD_MB: '64' }, 150_000);
    expect(out.big).toMatchObject({
      ok: false,
      name: 'ExtractionError',
      code: 'EXTRACTION_OUT_OF_MEMORY',
      message: expect.stringContaining('64 MB thread heap limit'),
    });
    expect(out.small).toBe('# S\n\nSmall page text. Small page text. ');
    expect(out.stats).toMatchObject({ outOfMemory: 1, threads: 2 });
    expect(out.stats.threadIds).toHaveLength(2);
  }, 60_000);

  it('warns when --max-old-space-size overrides the thread limit and replaces a thread by heap use', async () => {
    const { out, stderr } = await runChild(
      { NODE_OPTIONS: '--max-old-space-size=4096', EXTRACTION_THREAD_MAX_OLD_MB: '128', EXTRACTION_THREAD_RECYCLE_HEAP_MB: '96' },
      40_000,
    );
    expect(stderr).toContain('overrides worker resourceLimits');
    expect(out.big).toMatchObject({ ok: true });
    expect(out.small).toBe('# S\n\nSmall page text. Small page text. ');
    expect(out.stats.recycledThreads).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
