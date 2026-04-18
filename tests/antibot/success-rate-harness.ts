/* eslint-disable no-console */
/**
 * Part 4.E — Anti-bot resilience harness.
 *
 * Hits hard targets N times each, measures success rate, latency, tier used,
 * and captures the root cause of failures. Uses quality-score > 0.7 as the
 * signal for "really succeeded" (not just a 200 with a CAPTCHA page inside).
 *
 * Run:
 *   $env:API_KEY="sf_live_..."; npx tsx tests/antibot/success-rate-harness.ts
 *   # optional: tune
 *   $env:RUNS_PER_TARGET="5"; npx tsx tests/antibot/success-rate-harness.ts
 */

const API = process.env.API_BASE || 'http://localhost:3000';
const KEY = process.env.API_KEY || process.env.TEST_API_KEY;
const RUNS = Number(process.env.RUNS_PER_TARGET || 5);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 1500);

if (!KEY) {
  console.error('Missing env API_KEY. Export sf_live_... and rerun.');
  process.exit(1);
}

/** Hard targets from the plan, plus one Cloudflare-protected reference. */
const HARD_TARGETS: Record<string, string> = {
  amazon:       'https://www.amazon.com/s?k=laptop',
  walmart:      'https://www.walmart.com/search?q=laptop',
  target:       'https://www.target.com',
  nike:         'https://www.nike.com',
  google_serp:  'https://www.google.com/search?q=web+scraping',
  bing_serp:    'https://www.bing.com/search?q=web+scraping',
  linkedin:     'https://www.linkedin.com/in/satyanadella',
  cloudflare:   'https://nowsecure.nl',
};

interface RunResult {
  run: number;
  ok: boolean;
  status: number;
  tier: number | null;
  ms: number;
  quality: number;
  chars: number;
  reason?: string;
}

interface TargetStats {
  target: string;
  runs: RunResult[];
  successRate: string;
  avgLatency: string;
  avgTier: string;
  avgQuality: string;
  topReasons: string[];
}

async function scrape(url: string): Promise<RunResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API}/v1/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({
        url,
        formats: ['markdown', 'html'],
        cacheTtl: 0,
        timeout: 60_000,
      }),
    });
    const data: any = await res.json().catch(() => null);
    const ms = Date.now() - t0;
    const quality = Number(data?.metadata?.qualityScore ?? 0);
    const chars =
      (data?.content?.markdown || data?.content?.text || data?.content?.html || '').length;
    const ok = res.ok && quality >= 0.7 && chars >= 500;
    let reason: string | undefined;
    if (!ok) {
      if (!res.ok) reason = `http-${res.status}: ${data?.error || 'unknown'}`;
      else if (quality < 0.7) reason = `low-quality-${quality.toFixed(2)}`;
      else if (chars < 500) reason = `short-content-${chars}c`;
    }
    return {
      run: 0,
      ok,
      status: res.status,
      tier: data?.metadata?.tierUsed ?? null,
      ms,
      quality,
      chars,
      reason,
    };
  } catch (err) {
    return {
      run: 0,
      ok: false,
      status: 0,
      tier: null,
      ms: Date.now() - t0,
      quality: 0,
      chars: 0,
      reason: `fetch-error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function avg(xs: number[]) {
  if (!xs.length) return 0;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

async function main() {
  console.log(
    `Anti-bot harness: ${Object.keys(HARD_TARGETS).length} targets × ${RUNS} runs each against ${API}\n`,
  );

  const allStats: TargetStats[] = [];

  for (const [name, url] of Object.entries(HARD_TARGETS)) {
    process.stdout.write(`  ${name.padEnd(14)} `);
    const runs: RunResult[] = [];
    for (let i = 0; i < RUNS; i++) {
      const r = await scrape(url);
      r.run = i + 1;
      runs.push(r);
      process.stdout.write(r.ok ? '.' : 'x');
      if (i < RUNS - 1) await new Promise((ok) => setTimeout(ok, COOLDOWN_MS));
    }

    const successCount = runs.filter((r) => r.ok).length;
    const tiers = runs.map((r) => r.tier).filter((x): x is number => typeof x === 'number');
    const reasonCounts: Record<string, number> = {};
    for (const r of runs) {
      if (!r.ok && r.reason) {
        const key = r.reason.split(':')[0];
        reasonCounts[key] = (reasonCounts[key] || 0) + 1;
      }
    }
    const topReasons = Object.entries(reasonCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([r, c]) => `${r}×${c}`);

    const stats: TargetStats = {
      target: name,
      runs,
      successRate: `${Math.round((successCount / runs.length) * 100)}%`,
      avgLatency: `${avg(runs.map((r) => r.ms))}ms`,
      avgTier: tiers.length ? (tiers.reduce((a, b) => a + b, 0) / tiers.length).toFixed(1) : '-',
      avgQuality: (
        runs.map((r) => r.quality).reduce((a, b) => a + b, 0) / runs.length
      ).toFixed(2),
      topReasons,
    };
    allStats.push(stats);
    console.log(
      `  success=${stats.successRate}  avg=${stats.avgLatency}  tier=${stats.avgTier}  q=${stats.avgQuality}  ${topReasons.join(' ')}`,
    );
  }

  // Summary table
  console.log('\n════════════ Anti-bot success matrix ════════════\n');
  console.log(
    ['TARGET'.padEnd(14), 'SUCCESS', 'AVG MS', 'TIER', 'Q', 'REASONS'].join(' | '),
  );
  console.log('-'.repeat(78));
  for (const s of allStats) {
    console.log(
      [
        s.target.padEnd(14),
        s.successRate.padStart(7),
        s.avgLatency.padStart(7),
        s.avgTier.padStart(4),
        s.avgQuality.padStart(4),
        s.topReasons.join(' '),
      ].join(' | '),
    );
  }

  // Plan's industry benchmarks
  const plan: Record<string, number> = {
    amazon: 80,
    walmart: 70,
    google_serp: 85,
    linkedin: 50,
    cloudflare: 70,
  };
  console.log('\n════════════ vs industry target (from plan) ════════════\n');
  for (const [t, target] of Object.entries(plan)) {
    const s = allStats.find((x) => x.target === t);
    if (!s) continue;
    const actual = parseInt(s.successRate);
    const verdict = actual >= target ? 'PASS' : 'MISS';
    console.log(
      `  ${t.padEnd(14)}  actual=${String(actual).padStart(3)}%  target >=${target}%  ${verdict}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
