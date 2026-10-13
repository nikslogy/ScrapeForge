// Phase 5: mixed load and recovery on the real worker (apps/worker/src/worker.ts).
//
// Starts its own redis-server, a local fixture site and the real worker
// process, then submits jobs the way the API does (same queues and job
// options) and checks what comes back:
//
//   A. mixed steady load: static pages, client-rendered pages (browser),
//      JSON-LD product pages with an extraction schema, 500 KB pages, slow
//      pages, a failing site (500) and a rate-limiting site (429), from
//      several concurrent clients;
//   B. a burst of identical requests (coalescing: one origin fetch);
//   C. one page, several schemas (snapshot cache: one origin fetch);
//   D. the worker killed (SIGKILL) with jobs in flight: a new worker picks
//      them up (BullMQ stalled-job recovery) and every job finishes;
//   E. Redis restarted under the worker: it reconnects and serves new jobs.
//
// Run: npx tsx tests/load/mixed-load.ts [--jobs 150] [--clients 8]
// Writes tests/load/results/mixed-load-<date>.{json,md}. Needs redis-server
// and a Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE or /opt/pw-browsers/chromium).
// No model key is needed: extraction pages carry JSON-LD.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const JOBS = Number(args.get('jobs') ?? 150);
const CLIENTS = Number(args.get('clients') ?? 8);
const CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/opt/pw-browsers/chromium';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

// ── Fixture site ────────────────────────────────────────────

const hits = new Map<string, number>();
const count = (path: string) => hits.set(path, (hits.get(path) ?? 0) + 1);
const ARTICLE = (n: string) =>
  `<!doctype html><html lang="en"><head><title>Article ${n}</title></head><body><header><nav><a href="/">Home</a></nav></header><main><article><h1>Field notes ${n}</h1>` +
  `<p>${'Long-form text about trail gear, written for people who carry it every weekend and want to know what lasts. '.repeat(12)}</p>` +
  `<p>${'Each section compares weight, packed size and how the stitching holds after a season of rain. '.repeat(10)}</p></article></main><footer>© 2026</footer></body></html>`;
const SPA = (n: string) =>
  `<!doctype html><html><head><title>App ${n}</title></head><body><div id="root"></div><script>` +
  `document.getElementById('root').innerHTML = '<h1>Rendered ${n}</h1><p>' + 'Rendered in the browser by a script. '.repeat(30) + '</p>';</script></body></html>`;
const PRODUCT = (n: string) =>
  `<!doctype html><html lang="en"><head><title>Trail Tent ${n}</title><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Product', name: `Trail Tent ${n}`, sku: `TT-${n}`,
    offers: { '@type': 'Offer', price: `${100 + Number(n.replace(/\D/g, '') || 0)}.00`, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
  })}</script></head><body><main><h1>Trail Tent ${n}</h1><p class="price">$${100 + Number(n.replace(/\D/g, '') || 0)}.00</p><p>In stock</p>` +
  `<p>${'A two-person tent with a full-coverage fly and two vestibules. '.repeat(8)}</p></main></body></html>`;
const LARGE = (n: string) =>
  `<!doctype html><html lang="en"><head><title>Catalog ${n}</title></head><body><main><h1>Catalog ${n}</h1>` +
  Array.from({ length: 2_000 }, (_, i) => `<section><h2>Item ${i}</h2><p>${'Durable, light and tested over many seasons in the field. '.repeat(4)}</p></section>`).join('') +
  '</main></body></html>';

function handle(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? '/').split('?')[0];
  count(path);
  const [, kind, n = '0'] = path.split('/');
  const send = (code: number, body: string, headers: Record<string, string> = {}) => {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
  };
  switch (kind) {
    case 'static': return send(200, ARTICLE(n));
    case 'spa': return send(200, SPA(n));
    case 'product': return send(200, PRODUCT(n));
    case 'large': return send(200, LARGE(n));
    case 'slow': { setTimeout(() => send(200, ARTICLE(n)), 1_500); return; }
    case 'down': return send(500, '<html><body><h1>500 Internal Server Error</h1></body></html>');
    case 'limited': return send(429, 'Too Many Requests', { 'retry-after': '0' });
    default: return send(404, '<h1>Not found</h1>');
  }
}

// ── Processes ───────────────────────────────────────────────

function startRedis(port: number): void {
  execFileSync('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--daemonize', 'yes']);
}
function stopRedis(port: number): void {
  try {
    execFileSync('redis-cli', ['-p', String(port), 'shutdown', 'nosave'], { stdio: 'ignore' });
  } catch {
    // closes the connection mid-reply
  }
}
async function waitRedis(port: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = new Redis(port, '127.0.0.1', { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
      r.on('error', () => {});
      await r.connect();
      await r.ping();
      r.disconnect();
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error('redis did not come up');
}

interface WorkerProc {
  child: ChildProcess;
  log: string[];
}

async function startWorker(redisPort: number): Promise<WorkerProc> {
  const child = spawn('npx', ['tsx', 'apps/worker/src/worker.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      REDIS_URL: `redis://127.0.0.1:${redisPort}`,
      DATABASE_URL: 'postgres://load:load@127.0.0.1:1/none',
      MAX_BROWSER_CONTEXTS: '2',
      WORKER_CONCURRENCY: '8',
      SCRAPEFORGE_ALLOW_PRIVATE_NETWORK: '1',
      PLAYWRIGHT_CHROMIUM_EXECUTABLE: CHROMIUM,
      EXTRACT_MODELS: '',
      OPENROUTER_API_KEY: '',
      BULLMQ_STALLED_INTERVAL_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const log: string[] = [];
  const onData = (d: Buffer) => log.push(...d.toString().split('\n').filter(Boolean));
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  for (let i = 0; i < 240 && !log.some((l) => l.includes('worker ready')); i++) await sleep(250);
  if (!log.some((l) => l.includes('worker ready'))) throw new Error(`worker did not start:\n${log.slice(-30).join('\n')}`);
  return { child, log };
}

function killWorker(w: WorkerProc, signal: NodeJS.Signals): void {
  try {
    // The worker runs under npx/tsx: signal the whole process group.
    if (w.child.pid) process.kill(-w.child.pid, signal);
  } catch {
    w.child.kill(signal);
  }
}

// ── Jobs ────────────────────────────────────────────────────

type Kind = 'static' | 'spa' | 'product' | 'large' | 'slow' | 'down' | 'limited';
const WEIGHTS: Array<[Kind, number]> = [['static', 35], ['product', 25], ['spa', 12], ['large', 10], ['slow', 8], ['down', 5], ['limited', 5]];
const EXPECT_FAIL = new Set<Kind>(['down', 'limited']);

interface Done {
  kind: string;
  ms: number;
  status: 'completed' | 'failed';
  tier?: number;
  cached?: boolean;
  coalescedWith?: string;
  snapshotAgeMs?: number;
  extraction?: string;
  error?: string;
}

const PRODUCT_SCHEMA = { name: 'string', price: 'number', inStock: 'boolean' };

function pick(seed: number): Kind {
  const total = WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let r = seed % total;
  for (const [k, w] of WEIGHTS) {
    if (r < w) return k;
    r -= w;
  }
  return 'static';
}

class Client {
  readonly realtime: Queue;
  readonly events: QueueEvents;
  #seq = 0;

  constructor(readonly redisPort: number, readonly origin: string) {
    const connection = { host: '127.0.0.1', port: redisPort };
    this.realtime = new Queue('scrape-realtime', { connection });
    this.events = new QueueEvents('scrape-realtime', { connection });
  }

  async run(kind: string, path: string, options: Record<string, unknown>, timeoutMs = 60_000): Promise<Done> {
    const jobId = `load-${process.pid}-${++this.#seq}-${Math.random().toString(36).slice(2, 8)}`;
    const t0 = performance.now();
    const job = await this.realtime.add(
      jobId,
      { jobId, userId: 'load-tenant', apiKeyId: 'load-key', url: `${this.origin}${path}`, options: { timeout: 30_000, ...options }, priority: 1, createdAt: new Date().toISOString() },
      { jobId, priority: 1, attempts: 2, backoff: { type: 'fixed', delay: 250 }, removeOnComplete: { age: 3600 }, removeOnFail: { age: 86400 } },
    );
    try {
      const r = (await job.waitUntilFinished(this.events, timeoutMs)) as {
        status: 'completed';
        metadata: { tierUsed: number; cached: boolean; coalescedWith?: string; snapshotAgeMs?: number; extraction?: { status: string } };
      };
      return {
        kind, ms: performance.now() - t0, status: 'completed', tier: r.metadata.tierUsed, cached: r.metadata.cached,
        ...(r.metadata.coalescedWith ? { coalescedWith: r.metadata.coalescedWith } : {}),
        ...(r.metadata.snapshotAgeMs !== undefined ? { snapshotAgeMs: r.metadata.snapshotAgeMs } : {}),
        ...(r.metadata.extraction ? { extraction: r.metadata.extraction.status } : {}),
      };
    } catch (err) {
      return { kind, ms: performance.now() - t0, status: 'failed', error: String((err as Error).message).slice(0, 160) };
    }
  }

  async close(): Promise<void> {
    await this.events.close();
    await this.realtime.close();
  }
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]);
}

// ── Scenarios ───────────────────────────────────────────────

async function main(): Promise<void> {
  const redisPort = await freePort();
  startRedis(redisPort);
  await waitRedis(redisPort);
  const site = createServer(handle);
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  let worker = await startWorker(redisPort);
  const client = new Client(redisPort, origin);
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), jobs: JOBS, clients: CLIENTS, workerConcurrency: 8, browserContexts: 2 };
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  };

  try {
    // A. mixed steady load
    console.log(`[A] ${JOBS} mixed jobs from ${CLIENTS} clients`);
    const results: Done[] = [];
    let next = 0;
    const tA = performance.now();
    await Promise.all(
      Array.from({ length: CLIENTS }, async () => {
        for (let i = next++; i < JOBS; i = next++) {
          const kind = pick(i * 7919);
          // Unique paths: no coalescing or snapshot help in this phase.
          const path = `/${kind}/${i}`;
          const options = kind === 'product' ? { extractSchema: PRODUCT_SCHEMA, cacheTtl: 0 } : { cacheTtl: 0 };
          results.push(await client.run(kind, path, options));
        }
      }),
    );
    const wallA = performance.now() - tA;
    const byKind: Record<string, unknown> = {};
    for (const [kind] of WEIGHTS) {
      const rs = results.filter((r) => r.kind === kind);
      const ok = rs.filter((r) => r.status === 'completed');
      byKind[kind] = {
        jobs: rs.length, completed: ok.length, failed: rs.length - ok.length,
        p50Ms: pct(rs.map((r) => r.ms), 50), p95Ms: pct(rs.map((r) => r.ms), 95),
        tiers: [...new Set(ok.map((r) => r.tier))].sort(),
        ...(kind === 'product' ? { extraction: Object.fromEntries([...new Set(ok.map((r) => r.extraction))].map((s) => [s, ok.filter((r) => r.extraction === s).length])) } : {}),
      };
    }
    report.mixed = { wallMs: Math.round(wallA), jobsPerSec: Number((results.length / (wallA / 1000)).toFixed(2)), byKind };
    const unexpected = results.filter((r) => (r.status === 'failed') !== EXPECT_FAIL.has(r.kind as Kind));
    check('A: every job ends as expected (pages complete; 500/429 sites fail retryably)', unexpected.length === 0, `${results.length} jobs, ${unexpected.length} unexpected: ${JSON.stringify(unexpected.slice(0, 3))}`);
    const products = results.filter((r) => r.kind === 'product' && r.status === 'completed');
    check('A: JSON-LD products extract complete without a model', products.every((r) => r.extraction === 'complete'), `${products.filter((r) => r.extraction === 'complete').length}/${products.length} complete`);
    const downHits = [...hits.entries()].filter(([p]) => p.startsWith('/down/')).map(([, n]) => n);
    // 2 attempts per job (BullMQ), 2 fetches per attempt (T1 + its one retry); no browser.
    check('A: a failing site is fetched at most 4 times per job (no browser escalation)', downHits.every((n) => n <= 4), `fetches per failing job: ${JSON.stringify([...new Set(downHits)])}`);

    // B. burst of identical requests
    console.log('[B] 20 identical requests at once');
    hits.clear();
    const burst = await Promise.all(Array.from({ length: 20 }, () => client.run('burst', '/slow/burst', { formats: ['markdown'] })));
    const coalesced = burst.filter((r) => r.coalescedWith).length;
    report.burst = { jobs: 20, originFetches: hits.get('/slow/burst') ?? 0, coalesced, cachedOrCoalesced: burst.filter((r) => r.cached).length, p50Ms: pct(burst.map((r) => r.ms), 50), p95Ms: pct(burst.map((r) => r.ms), 95) };
    check('B: 20 identical requests fetch the origin once', (hits.get('/slow/burst') ?? 0) === 1 && burst.every((r) => r.status === 'completed'), JSON.stringify(report.burst));

    // C. one page, several schemas
    console.log('[C] one page, three schemas, one after another');
    hits.clear();
    const schemas = [{ name: 'string' }, { name: 'string', price: 'number' }, { name: 'string', sku: 'string' }];
    const snaps: Done[] = [];
    for (const schema of schemas) snaps.push(await client.run('snapshot', '/product/snap', { extractSchema: schema }));
    report.snapshot = { originFetches: hits.get('/product/snap') ?? 0, msPerRequest: snaps.map((r) => Math.round(r.ms)), snapshotAgeMs: snaps.map((r) => r.snapshotAgeMs ?? null) };
    check('C: three schemas on one page fetch it once', (hits.get('/product/snap') ?? 0) === 1 && snaps.slice(1).every((r) => r.snapshotAgeMs !== undefined), JSON.stringify(report.snapshot));

    // D. worker killed with jobs in flight
    console.log('[D] SIGKILL the worker with 10 slow jobs in flight, start a new one');
    const tD = performance.now();
    const inflight = Array.from({ length: 10 }, (_, i) => client.run('crash', `/slow/crash-${i}`, { cacheTtl: 0 }, 90_000));
    await sleep(800);
    killWorker(worker, 'SIGKILL');
    await sleep(500);
    worker = await startWorker(redisPort);
    const crashed = await Promise.all(inflight);
    report.crashRecovery = {
      jobs: 10, completed: crashed.filter((r) => r.status === 'completed').length,
      p50Ms: pct(crashed.map((r) => r.ms), 50), maxMs: Math.round(Math.max(...crashed.map((r) => r.ms))), wallMs: Math.round(performance.now() - tD),
    };
    check('D: every in-flight job finishes after a worker crash', crashed.every((r) => r.status === 'completed'), JSON.stringify(report.crashRecovery));

    // E. Redis restarted under the worker
    console.log('[E] restart Redis under the worker');
    await client.close();
    stopRedis(redisPort);
    await sleep(1_000);
    startRedis(redisPort);
    await waitRedis(redisPort);
    const client2 = new Client(redisPort, origin);
    const tE = performance.now();
    const after = await Promise.all(Array.from({ length: 5 }, (_, i) => client2.run('after-redis', `/static/after-${i}`, { cacheTtl: 0 }, 60_000)));
    report.redisRestart = { jobs: 5, completed: after.filter((r) => r.status === 'completed').length, wallMs: Math.round(performance.now() - tE) };
    check('E: the worker serves new jobs after Redis restarts', after.every((r) => r.status === 'completed'), JSON.stringify(report.redisRestart));
    await client2.close();
  } finally {
    report.checks = checks;
    report.workerLogTail = worker.log.filter((l) => /error|Error|fail/i.test(l) && !/Log write failed|ECONNREFUSED 127.0.0.1:1/.test(l)).slice(-15);
    killWorker(worker, 'SIGTERM');
    await sleep(500);
    killWorker(worker, 'SIGKILL');
    site.close();
    stopRedis(redisPort);
    const outDir = join(ROOT, 'tests', 'load', 'results');
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(outDir, `mixed-load-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  }
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
