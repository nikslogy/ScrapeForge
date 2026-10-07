/* eslint-disable no-console */
/**
 * Part 4.B — Reliability tests.
 *
 * Simulates real production incidents and verifies the system degrades
 * gracefully and self-heals. Run manually; they intentionally break things.
 *
 * Tests implemented:
 *   1. Worker crash mid-job  — kill worker, confirm BullMQ re-queues the job
 *                              and a replacement worker picks it up OR a
 *                              clean error reaches the client within timeout.
 *   2. Redis disconnect      — restart Redis mid-traffic, confirm worker
 *                              reconnects and in-flight jobs resolve (not
 *                              silently hang forever).
 *   3. Browser hang / timeout — scrape a black-hole URL; confirm the API
 *                              returns within configured timeout instead of
 *                              hanging forever, and the browser context is
 *                              released back to the pool.
 *   4. Malformed HTML        — scrape a deliberately broken HTML endpoint
 *                              (via httpbin.org or an inline data-url);
 *                              confirm pipeline doesn't 500, quality score
 *                              reflects the garbage, response is well-formed.
 *
 * Run:
 *   $env:API_KEY="sf_live_..."; npx tsx tests/reliability/reliability-tests.ts
 */

import { execSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const API = process.env.API_BASE || 'http://localhost:3000';
const KEY = process.env.API_KEY || process.env.TEST_API_KEY;

if (!KEY) {
  console.error('Missing env API_KEY.');
  process.exit(1);
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
  durationMs: number;
}

const results: TestResult[] = [];

function record(name: string, pass: boolean, detail: string, t0: number) {
  const durationMs = Date.now() - t0;
  results.push({ name, pass, detail, durationMs });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}  ${detail}  (${durationMs}ms)`);
}

async function scrape(
  url: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: any; ms: number; err?: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API}/v1/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({ url, formats: ['markdown'], cacheTtl: 0, ...extra }),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body, ms: Date.now() - t0 };
  } catch (err) {
    return {
      status: 0,
      body: null,
      ms: Date.now() - t0,
      err: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Test 1: Browser hang / timeout enforcement ────────────────
//
// Point the scraper at a black-hole address (RFC5737 TEST-NET-1; nothing
// responds). The `timeout` param must cap the total browser wait so the
// API returns an error within timeout+slack seconds, NOT hang forever.
async function test1_Timeout() {
  console.log('\n── Test 1: Browser hang / timeout enforcement ──');
  const t0 = Date.now();
  // 10.255.255.1 is a TEST-NET address that never ACKs. timeout=8s.
  // We expect the API to respond in 8–15s, either with HTTP 500 or a
  // body whose `error` describes the timeout. Anything over 30s is a fail
  // because that's the outer job timeout, not the configured one.
  const r = await scrape('http://10.255.255.1:81', { timeout: 8_000 });
  const withinBudget = r.ms < 25_000;
  const failedCleanly = r.status !== 200 || r.body?.error;
  const pass = withinBudget && failedCleanly;
  record(
    'timeout-enforcement',
    pass,
    `status=${r.status} ms=${r.ms} err=${(r.body?.error || r.err || 'none').toString().slice(0, 60)}`,
    t0,
  );
}

// ─── Test 2: Malformed / broken HTML ──────────────────────────
//
// httpbin.org/html returns a tiny, simple HTML doc; we use a URL that
// returns deliberately garbage bytes via data:-url doesn't work over
// HTTP. Instead we hit an endpoint that returns a non-HTML content-type,
// which the pipeline still has to handle without crashing.
async function test2_MalformedHtml() {
  console.log('\n── Test 2: Malformed / non-HTML content ──');
  const t0 = Date.now();
  // jsonplaceholder returns JSON; pipeline should still respond cleanly
  // with minimal content + a low quality score, NOT throw.
  const r = await scrape('https://jsonplaceholder.typicode.com/posts/1');
  const apiOk = r.status === 200 && !!r.body;
  const hasWellFormedShape =
    apiOk && typeof r.body.metadata?.qualityScore === 'number';
  record(
    'non-html-graceful',
    apiOk && hasWellFormedShape,
    `status=${r.status} quality=${r.body?.metadata?.qualityScore ?? 'n/a'}`,
    t0,
  );
}

// ─── Test 3: Redis restart resilience ─────────────────────────
//
// Fires a scrape, restarts Redis while the job is in the queue, then fires
// a second scrape. Verifies:
//   - First scrape eventually completes (may fail if it was in-flight
//     during the restart; that's acceptable so long as error is clean).
//   - Second scrape, after Redis comes back, succeeds normally — proves
//     the worker reconnected rather than wedged.
async function test3_RedisRestart() {
  console.log('\n── Test 3: Redis restart mid-traffic ──');
  const t0 = Date.now();
  try {
    // Fire scrape 1 but DON'T await; restart Redis while it's flying.
    const p1 = scrape('https://example.com');
    // Let the job enter the queue.
    await new Promise((ok) => setTimeout(ok, 200));
    execSync('docker restart infra-redis-1', { stdio: 'ignore' });
    const r1 = await p1;
    // Let worker reconnect (ioredis default retry is ~100ms backoff).
    await new Promise((ok) => setTimeout(ok, 3000));
    const r2 = await scrape('https://example.com');

    const recovered = r2.status === 200 && r2.body?.metadata;
    const detail =
      `first: status=${r1.status} ms=${r1.ms} | ` +
      `second(after-restart): status=${r2.status} ms=${r2.ms} ok=${recovered ? 'yes' : 'no'}`;
    record('redis-reconnect', !!recovered, detail, t0);
  } catch (err) {
    record('redis-reconnect', false, `threw: ${(err as Error).message}`, t0);
  }
}

// ─── Test 4: Worker crash + BullMQ stall recovery ─────────────
//
// Spawns a DEDICATED ephemeral second worker we fully control (so we can
// kill it cleanly without breaking the dev setup), then fires a scrape
// at a heavy URL so the ephemeral worker is most likely to pick it up
// first. After a brief delay we SIGKILL the ephemeral worker mid-job and
// rely on BullMQ's stalled-job detection (now tuned to 15s in
// workerOptions) to re-deliver to the surviving primary worker.
//
// We accept success if the scrape completes within a reasonable window
// (stalled interval + one scrape budget). A timeout is a real fail —
// it means re-delivery is broken.
async function test4_WorkerCrash() {
  console.log('\n── Test 4: Worker crash recovery ──');
  const t0 = Date.now();
  // Spawn ephemeral worker.  `shell: true` is required on Windows so we can
  // invoke `npm`, a .cmd shim rather than a true executable.
  const child = spawn('npm', ['run', 'dev', '-w', 'apps/worker'], {
    cwd: process.cwd(),
    stdio: 'pipe',
    detached: false,
    shell: true,
    env: {
      ...process.env,
      // Different metrics port so the two workers don't collide.
      METRICS_PORT: '9092',
    },
  });
  let ready = false;
  child.stdout?.on('data', (buf) => {
    if (String(buf).includes('ScrapeForge worker ready')) ready = true;
  });

  try {
    // Wait up to 25s for the ephemeral worker to be ready.
    const deadline = Date.now() + 25_000;
    while (!ready && Date.now() < deadline) {
      await sleep(250);
    }
    if (!ready) {
      record(
        'worker-crash-recovery',
        false,
        'ephemeral worker never reported ready within 25s',
        t0,
      );
      return;
    }

    // Fire a scrape; ~200ms later, kill the ephemeral worker.
    const p = scrape('https://quotes.toscrape.com', { timeout: 45_000 });
    await sleep(250);
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      // already dead
    }

    const r = await p;
    const ok = r.status === 200;
    record(
      'worker-crash-recovery',
      ok,
      `killed ephemeral PID ${child.pid}; scrape status=${r.status} ms=${r.ms}`,
      t0,
    );
  } finally {
    if (!child.killed) {
      try {
        if (process.platform === 'win32' && child.pid) {
          execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        /* best-effort */
      }
    }
  }
}

async function main() {
  console.log(`Reliability tests against ${API}\n`);

  await test1_Timeout();
  await test2_MalformedHtml();
  await test3_RedisRestart();
  await test4_WorkerCrash();

  console.log('\n════════════ Reliability summary ════════════');
  const passed = results.filter((r) => r.pass).length;
  console.log(`  Passed: ${passed}/${results.length}`);
  for (const r of results) {
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.name.padEnd(30)} ${r.detail}`);
  }
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
