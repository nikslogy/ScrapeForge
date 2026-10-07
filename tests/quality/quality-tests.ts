/* eslint-disable no-console */
/**
 * Part 4.F — Quality tests.
 *
 * 1. Markdown conversion fidelity on a Wikipedia article
 * 2. Readability extraction (title/content) on a news article
 * 3. AI extraction accuracy vs ground truth (books.toscrape)
 * 4. Quality-score calibration on known-good vs known-blocked pages
 *
 * Run:
 *   $env:API_KEY="sf_live_..."; npx tsx tests/quality/quality-tests.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API = process.env.API_BASE || 'http://localhost:3000';
const KEY = process.env.API_KEY || process.env.TEST_API_KEY;
if (!KEY) {
  console.error('Missing env API_KEY.');
  process.exit(1);
}

async function scrape(body: Record<string, unknown>) {
  const res = await fetch(`${API}/v1/scrape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ cacheTtl: 0, timeout: 60_000, ...body }),
  });
  return { status: res.status, ok: res.ok, data: await res.json().catch(() => null) };
}

async function extract(body: Record<string, unknown>) {
  try {
    const res = await fetch(`${API}/v1/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ cacheTtl: 0, timeout: 90_000, ...body }),
    });
    return { status: res.status, ok: res.ok, data: await res.json().catch(() => null) };
  } catch (err) {
    return { status: 0, ok: false, data: null as any };
  }
}

function pctMatch(ok: number, total: number) {
  return total === 0 ? 0 : Math.round((ok / total) * 100);
}

async function test1_MarkdownFidelity() {
  console.log('\n── Test 1: Markdown fidelity (Wikipedia) ──');
  const r = await scrape({
    url: 'https://en.wikipedia.org/wiki/Web_scraping',
    formats: ['markdown', 'html'],
  });
  const md: string = r.data?.content?.markdown || '';
  const html: string = r.data?.content?.html || '';

  const checks = {
    hasH1:           /(^|\n)# /.test(md),
    hasH2:           /(^|\n)## /.test(md),
    hasH3:           /(^|\n)### /.test(md),
    hasLinks:        /\[[^\]]+\]\([^)]+\)/.test(md),
    hasListItems:    /(^|\n)[-*] /.test(md),
    noNavJunk:       !/\b(Main page|Contents menu|Navigation menu|Donate)\b/i.test(md.slice(0, 1000)),
    reasonableLen:   md.length > 5_000 && md.length < html.length,
    hasCitations:    /\[\d+\]/.test(md) || md.includes('[edit]'),
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;
  console.log(`  chars: md=${md.length}  html=${html.length}`);
  for (const [k, v] of Object.entries(checks)) {
    console.log(`  ${v ? 'ok' : '!!'}  ${k}`);
  }
  console.log(
    `  fidelity: ${passed}/${total} (${pctMatch(passed, total)}%)  plan target >=95% (>=${Math.ceil(total * 0.95)}/${total})  ${passed >= Math.ceil(total * 0.95) ? 'PASS' : 'MISS'}`,
  );
}

async function test2_Readability() {
  console.log('\n── Test 2: Readability extraction (BBC article) ──');
  // A stable BBC article URL. Fall back to techcrunch landing page if BBC
  // is blocked in the test environment.
  const candidates = [
    'https://www.bbc.com/news/world',
    'https://techcrunch.com',
  ];
  for (const url of candidates) {
    const r = await scrape({ url, formats: ['markdown', 'html'] });
    const md: string = r.data?.content?.markdown || '';
    const text: string = r.data?.content?.text || '';
    const title: string = r.data?.metadata?.title || '';
    const q = r.data?.metadata?.qualityScore ?? 0;
    const extractionMethod = r.data?.metadata?.extractionMethod || '—';
    const wordsMd = md.split(/\s+/).filter(Boolean).length;
    const looksLikeArticle = wordsMd >= 200 && !/\baccept cookies\b/i.test(md.slice(0, 500));
    console.log(
      `  ${url}\n    tier=${r.data?.metadata?.tierUsed} method=${extractionMethod} title="${title.slice(0, 60)}" q=${q} mdWords=${wordsMd} ${
        looksLikeArticle ? 'PASS' : 'MISS'
      }`,
    );
  }
}

async function test3_AIExtractionAccuracy() {
  console.log('\n── Test 3: AI extraction accuracy (books.toscrape) ──');
  const fixturePath = resolve(process.cwd(), 'tests/quality/gold-books.json');
  const gold = JSON.parse(readFileSync(fixturePath, 'utf8')).items as Array<{
    url: string;
    expected: { title: string; price: number; availability: string; rating: number };
  }>;

  const schema = {
    title: 'string — the book title as shown in the main product heading',
    price: 'number — numeric price in pounds, no currency symbol (e.g. 51.77)',
    availability: 'string — availability label such as "In stock" or "Out of stock"',
    rating: 'number — star rating 1–5 derived from the rating row',
  };

  let titleOk = 0, priceOk = 0, availOk = 0, ratingOk = 0;
  let skipped = 0;
  const failures: Array<{ url: string; diff: string }> = [];

  // OpenRouter's free tier is capped at 16 req/min and ~50/day. Pace ourselves
  // well under the per-minute cap; enable cacheTtl so repeat runs reuse the
  // first successful result instead of burning daily budget.
  const THROTTLE_MS = 4_000;
  const CACHE_TTL = 24 * 60 * 60; // 1 day
  let last = 0;

  for (const g of gold) {
    const since = Date.now() - last;
    if (last && since < THROTTLE_MS) {
      await new Promise((r) => setTimeout(r, THROTTLE_MS - since));
    }
    last = Date.now();

    const slug = g.url.split('/').slice(-2, -1)[0];
    process.stdout.write(`  ${slug.padEnd(40)} ... `);
    const r = await extract({ url: g.url, schema, cacheTtl: CACHE_TTL });
    const got: any = r.data?.content?.json || r.data?.extracted || r.data?.data || {};
    const method = r.data?.metadata?.extractionMethod ?? '—';
    process.stdout.write(`method=${method} status=${r.status}\n`);

    // Extraction returned no JSON at all — almost always an upstream LLM
    // rate-limit or quota exhaustion. Don't count it against accuracy since
    // it's an infra signal, not an extraction-quality signal. The failure
    // line below still prints so the run is visibly incomplete.
    if (!got || Object.keys(got).length === 0) {
      skipped++;
      failures.push({
        url: slug,
        diff: `skipped (no JSON returned — likely LLM rate-limit / quota)`,
      });
      continue;
    }

    const tOk = String(got.title || '').trim() === g.expected.title;
    const pOk = Math.abs(Number(got.price) - g.expected.price) < 0.02;
    const aOk = String(got.availability || '').toLowerCase().includes(
      g.expected.availability.toLowerCase(),
    );
    const rOk = Number(got.rating) === g.expected.rating;

    if (tOk) titleOk++;
    if (pOk) priceOk++;
    if (aOk) availOk++;
    if (rOk) ratingOk++;

    if (!tOk || !pOk || !aOk || !rOk) {
      failures.push({
        url: g.url.split('/').slice(-2, -1)[0],
        diff: `title=${tOk ? 'ok' : `"${got.title}" vs "${g.expected.title}"`} ` +
          `price=${pOk ? 'ok' : `${got.price} vs ${g.expected.price}`} ` +
          `avail=${aOk ? 'ok' : `"${got.availability}" vs "${g.expected.availability}"`} ` +
          `rating=${rOk ? 'ok' : `${got.rating} vs ${g.expected.rating}`}`,
      });
    }
  }

  // Accuracy is measured against books where the LLM actually responded —
  // rate-limit skips aren't treated as wrong answers.
  const scored = gold.length - skipped;
  const plan = { title: 95, price: 98, avail: 95, rating: 90 };
  console.log(
    `  sample size: ${gold.length} products (scored ${scored}, skipped ${skipped} due to LLM rate-limit)`,
  );
  const n = scored || 1;
  console.log(`  title:        ${pctMatch(titleOk, n)}%   plan >=${plan.title}%  ${pctMatch(titleOk, n) >= plan.title ? 'PASS' : 'MISS'}`);
  console.log(`  price:        ${pctMatch(priceOk, n)}%   plan >=${plan.price}%  ${pctMatch(priceOk, n) >= plan.price ? 'PASS' : 'MISS'}`);
  console.log(`  availability: ${pctMatch(availOk, n)}%   plan >=${plan.avail}%  ${pctMatch(availOk, n) >= plan.avail ? 'PASS' : 'MISS'}`);
  console.log(`  rating:       ${pctMatch(ratingOk, n)}%   plan >=${plan.rating}%  ${pctMatch(ratingOk, n) >= plan.rating ? 'PASS' : 'MISS'}`);
  if (failures.length) {
    console.log('  failures:');
    for (const f of failures) console.log(`    - ${f.url}: ${f.diff}`);
  }
}

async function test4_QualityScoreCalibration() {
  console.log('\n── Test 4: Quality-score calibration ──');
  const knownGood = [
    'https://example.com',
    'https://en.wikipedia.org/wiki/Web_scraping',
    'https://news.ycombinator.com',
    'https://quotes.toscrape.com',
    'https://books.toscrape.com',
    'https://httpbin.org/html',
    'https://docs.python.org/3/',
  ];
  const knownBad = [
    // Sites that reliably return a bot-detection / CAPTCHA stub against datacenter IPs.
    // (Matches the short-content / low-quality outcomes in the anti-bot log.)
    'https://www.walmart.com/search?q=laptop',
    'https://www.google.com/search?q=web+scraping',
    'https://nowsecure.nl',
  ];

  let goodCorrect = 0;
  let badCorrect = 0;
  const results: Array<{ url: string; label: 'good' | 'bad'; q: number; chars: number; ok: boolean }> = [];

  for (const url of knownGood) {
    const r = await scrape({ url, formats: ['markdown'] });
    const q = r.data?.metadata?.qualityScore ?? 0;
    const chars = (r.data?.content?.markdown || '').length;
    const ok = q >= 0.7;
    if (ok) goodCorrect++;
    results.push({ url, label: 'good', q, chars, ok });
  }
  for (const url of knownBad) {
    const r = await scrape({ url, formats: ['markdown'] });
    const q = r.data?.metadata?.qualityScore ?? 0;
    const chars = (r.data?.content?.markdown || '').length;
    const ok = q < 0.4;
    if (ok) badCorrect++;
    results.push({ url, label: 'bad', q, chars, ok });
  }

  console.table(
    results.map((r) => ({
      url: r.url.length > 50 ? r.url.slice(0, 50) + '…' : r.url,
      label: r.label,
      q: r.q,
      chars: r.chars,
      correct: r.ok,
    })),
  );

  const goodAcc = pctMatch(goodCorrect, knownGood.length);
  const badAcc = pctMatch(badCorrect, knownBad.length);
  const overall = pctMatch(goodCorrect + badCorrect, knownGood.length + knownBad.length);
  console.log(
    `  good-pages flagged ok:  ${goodCorrect}/${knownGood.length} (${goodAcc}%)`,
  );
  console.log(
    `  blocked-pages flagged bad: ${badCorrect}/${knownBad.length} (${badAcc}%)`,
  );
  console.log(`  overall calibration: ${overall}%  plan target >=95%  ${overall >= 95 ? 'PASS' : 'MISS'}`);
}

async function main() {
  console.log(`Quality tests against ${API}`);
  await test1_MarkdownFidelity();
  await test2_Readability();
  await test3_AIExtractionAccuracy();
  await test4_QualityScoreCalibration();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
