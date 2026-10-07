// Extraction pool: worker-entry selection, extraction through real worker
// threads from TypeScript sources (bundled mode), and a regression check that
// compiled output runs extraction without esbuild (the dist build bug).
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(here, '..', '..');
const srcExtraction = resolve(workerRoot, 'src', 'extraction');
const cacheDir = resolve(workerRoot, '.extraction-cache');

// Leftover bundles planted before the pool starts, to check the startup sweep.
const host = hostname().replace(/[^A-Za-z0-9.-]/g, '_').slice(0, 64);
const DEAD_PID = 99_999_999; // above Linux's maximum pid_max (2^22)
const planted = {
  staleOwn: resolve(cacheDir, `pipeline-worker-${host}-${DEAD_PID}.mjs`),
  staleOwnTmp: resolve(cacheDir, `pipeline-worker-${host}-${DEAD_PID}.mjs.tmp`),
  otherHost: resolve(cacheDir, `pipeline-worker-other-host-${process.pid}-${DEAD_PID}.mjs`),
  liveOwn: resolve(cacheDir, `pipeline-worker-${host}-${process.ppid}.mjs`),
  unrelated: resolve(cacheDir, `notes-${DEAD_PID}.txt`),
};
mkdirSync(cacheDir, { recursive: true });
for (const file of Object.values(planted)) writeFileSync(file, '// planted by pipeline.test.ts\n');

// Keep the pool small: each thread loads jsdom.
vi.stubEnv('EXTRACTION_POOL_SIZE', '2');
const pipeline = await import('../../src/extraction/pipeline.js');
const { extractContent, extractionPoolInfo, resolveWorkerEntry, shutdownExtractionPool } = pipeline;

afterAll(() => {
  for (const file of Object.values(planted)) rmSync(file, { force: true });
});

const ARTICLE = `<!doctype html><html><head><title>Field Notes on Tide Pools</title>
<meta name="description" content="A short article about tide pools."></head>
<body><nav><a href="/">Home</a> <a href="/about">About</a></nav>
<article><h1>Field Notes on Tide Pools</h1>
<p>Tide pools are rocky depressions along the shore that hold seawater when the tide recedes. They host anemones, barnacles, sea stars and small fish that tolerate rapid swings in temperature and salinity.</p>
<p>Visiting at low tide reveals the richest variety of life. Step only on bare rock, never lift animals from their pools, and watch the incoming tide so you are not cut off from the shore.</p>
<p>Researchers use tide pools as natural laboratories for studying competition, predation and how communities recover after storms disturb the rocks.</p>
</article><footer>Copyright 2026</footer></body></html>`;

describe('resolveWorkerEntry', () => {
  it('bundles the TypeScript entry when running from sources', () => {
    expect(resolveWorkerEntry('file:///srv/app/src/extraction/pipeline.ts')).toEqual({
      mode: 'bundled',
      file: '/srv/app/src/extraction/pipeline-worker.ts',
    });
  });

  it.each(['pipeline.mts', 'pipeline.cts'])('treats %s as source', (name) => {
    expect(resolveWorkerEntry(`file:///srv/app/src/extraction/${name}`).mode).toBe('bundled');
  });

  it('loads the compiled sibling directly when running from dist', () => {
    expect(resolveWorkerEntry('file:///srv/app/dist/extraction/pipeline.js')).toEqual({
      mode: 'compiled',
      file: '/srv/app/dist/extraction/pipeline-worker.js',
    });
  });

  it('decodes percent-encoded paths', () => {
    expect(resolveWorkerEntry('file:///srv/my%20app/dist/extraction/pipeline.js').file).toBe(
      '/srv/my app/dist/extraction/pipeline-worker.js',
    );
  });

  it('does not mistake a directory named like a .ts file for source', () => {
    expect(resolveWorkerEntry('file:///srv/app.ts/dist/extraction/pipeline.js').mode).toBe('compiled');
  });

  it('rejects non-file URLs', () => {
    expect(() => resolveWorkerEntry('https://example.com/pipeline.js')).toThrow();
  });
});

describe('extraction pool from TypeScript sources', () => {
  it('runs in bundled mode with a per-process bundle', () => {
    expect(extractionPoolInfo.mode).toBe('bundled');
    expect(extractionPoolInfo.threads).toBe(2);
    expect(extractionPoolInfo.entry).toBe(
      resolve(cacheDir, `pipeline-worker-${host}-${process.pid}.mjs`),
    );
    expect(existsSync(extractionPoolInfo.entry)).toBe(true);
    expect(existsSync(`${extractionPoolInfo.entry}.tmp`)).toBe(false);
    expect(Object.isFrozen(extractionPoolInfo)).toBe(true);
  });

  it("sweeps this host's bundles from dead processes and nothing else", () => {
    expect(existsSync(planted.staleOwn)).toBe(false);
    expect(existsSync(planted.staleOwnTmp)).toBe(false);
    expect(existsSync(planted.otherHost)).toBe(true);
    expect(existsSync(planted.liveOwn)).toBe(true);
    expect(existsSync(planted.unrelated)).toBe(true);
  });

  it('extracts markdown, text, html and metadata through a worker thread', async () => {
    const r = await extractContent(ARTICLE, 'https://example.com/tide-pools', [
      'markdown',
      'text',
      'html',
    ]);
    expect(r.markdown).toMatch(/^# Field Notes on Tide Pools\n/);
    expect(r.markdown).toContain('Tide pools are rocky depressions');
    expect(r.markdown).not.toContain('Copyright 2026');
    expect(r.text).toContain('natural laboratories');
    expect(r.html).toContain('<article>');
    expect(r.title).toBe('Field Notes on Tide Pools');
    expect(r.extractionMethod).toBeTruthy();
  });

  it('only produces the requested formats', async () => {
    const r = await extractContent(ARTICLE, 'https://example.com/tide-pools', ['markdown']);
    expect(r.markdown).toBeTruthy();
    expect(r.html).toBeUndefined();
    expect(r.text).toBeUndefined();
  });

  it('handles concurrent requests across the pool', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        extractContent(
          ARTICLE.replace('Field Notes on Tide Pools</h1>', `Field Notes ${i}</h1>`),
          `https://example.com/tide-pools/${i}`,
          ['markdown'],
        ),
      ),
    );
    results.forEach((r) => expect(r.markdown).toContain('Tide pools are rocky depressions'));
  });

  it.each([
    ['empty input', ''],
    ['plain text', 'just some text, no markup'],
    ['unclosed tags', '<div><p><span>dangling'],
    ['binary-ish garbage', '\u0000\u0001<\u0002>￿'],
  ])('survives %s', async (_name, html) => {
    const r = await extractContent(html, 'https://example.com/', ['markdown', 'text']);
    expect(typeof (r.markdown ?? '')).toBe('string');
  });

  it('rejects an already-aborted request without running it', async () => {
    await expect(
      extractContent(ARTICLE, 'https://example.com/', ['markdown'], { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // The pool keeps serving afterwards.
    const r = await extractContent(ARTICLE, 'https://example.com/', ['markdown']);
    expect(r.markdown).toContain('Tide pools');
  });
});

// Regression for the production build: dist has only the compiled
// pipeline-worker.js and no esbuild. The two entry modules are compiled into a
// scratch dir (inside the worker package so bare imports resolve from
// node_modules) and run in a child Node process that refuses to load esbuild.
describe('extraction pool from compiled output', () => {
  const scratch = resolve(cacheDir, `dist-check-${process.pid}`);
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
      `import * as nodeModule from 'node:module';
if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'esbuild' || specifier.startsWith('esbuild/')) {
        throw new Error('esbuild must not load from compiled output');
      }
      return next(specifier, context);
    },
  });
}
const mod = await import(process.argv[2]);
const r = await mod.extractContent(process.argv[3], 'https://example.com/tide-pools', ['markdown']);
await mod.shutdownExtractionPool();
console.log('RESULT ' + JSON.stringify({ info: mod.extractionPoolInfo, markdown: r.markdown }));
`,
    );
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('loads the compiled pipeline-worker.js directly and extracts', async () => {
    const pipelineUrl = pathToFileURL(resolve(outDir, 'pipeline.js')).href;
    const { stdout } = await promisify(execFile)(process.execPath, [script, pipelineUrl, ARTICLE], {
      env: { ...process.env, EXTRACTION_POOL_SIZE: '2' },
      timeout: 15_000,
    });
    const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
    expect(line, stdout).toBeDefined();
    const { info, markdown } = JSON.parse(line!.slice('RESULT '.length));
    expect(info).toEqual({ mode: 'compiled', entry: resolve(outDir, 'pipeline-worker.js'), threads: 2 });
    expect(markdown).toMatch(/^# Field Notes on Tide Pools/);
    expect(markdown).toContain('natural laboratories');
  });

  it('fails fast with an actionable error when the compiled worker entry is missing', async () => {
    rmSync(resolve(outDir, 'pipeline-worker.js'));
    const pipelineUrl = pathToFileURL(resolve(outDir, 'pipeline.js')).href;
    const run = promisify(execFile)(process.execPath, [script, pipelineUrl, ARTICLE], {
      timeout: 15_000,
    });
    await expect(run).rejects.toMatchObject({
      stderr: expect.stringContaining('npm run build -w apps/worker'),
    });
  });
});

// Kept last: shuts down the shared pool.
describe('shutdownExtractionPool', () => {
  it('is idempotent and later requests fail instead of hanging', async () => {
    await Promise.all([shutdownExtractionPool(), shutdownExtractionPool()]);
    await shutdownExtractionPool();
    await expect(extractContent(ARTICLE, 'https://example.com/', ['markdown'])).rejects.toThrow();
  });
});
