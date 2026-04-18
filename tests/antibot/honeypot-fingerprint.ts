/* eslint-disable no-console */
/**
 * Part 4.E — Honeypot fingerprint scan.
 *
 * Scrapes the standard bot-detection honeypots, saves HTML + screenshot
 * to disk so you can eyeball exactly what each site detected. The script
 * also does light heuristic flag counting ("webdriver: true" etc.).
 *
 * Run:
 *   $env:API_KEY="sf_live_..."; npx tsx tests/antibot/honeypot-fingerprint.ts
 * Outputs:
 *   tests/antibot/out/<site>.html    — extracted HTML
 *   tests/antibot/out/<site>.png     — rendered screenshot
 *   tests/antibot/out/summary.json   — heuristic flags per site
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API = process.env.API_BASE || 'http://localhost:3000';
const KEY = process.env.API_KEY || process.env.TEST_API_KEY;

if (!KEY) {
  console.error('Missing env API_KEY. Export sf_live_... and rerun.');
  process.exit(1);
}

const OUT = resolve('tests/antibot/out');
mkdirSync(OUT, { recursive: true });

const HONEYPOTS: Record<string, string> = {
  sannysoft:       'https://bot.sannysoft.com',
  creepjs:         'https://abrahamjuliot.github.io/creepjs',
  fingerprintcom:  'https://fingerprint.com/demo',
  pixelscan:       'https://pixelscan.net',
  device_browser:  'https://deviceandbrowserinfo.com/info_device',
  amiunique:       'https://amiunique.org/fingerprint',
};

/** Heuristics: strings that, if present, likely mean we got flagged. */
const RED_FLAGS = [
  'headless: true',
  'headless: yes',
  'webdriver: true',
  '"webdriver":true',
  'webdriver present',
  'automation: detected',
  'bot detected',
  'puppeteer',
  'missing image',
  'navigator.webdriver',
  'chrome: failed',
];

/** Heuristics: strings that typically mean we LOOK LIKE a real browser. */
const GOOD_SIGNALS = [
  'webdriver: false',
  'headless: false',
  '"webdriver":false',
  'no bot signals',
  'chrome: passed',
];

async function scrape(url: string) {
  const res = await fetch(`${API}/v1/scrape`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      url,
      formats: ['html', 'text', 'screenshot'],
      screenshot: true,
      cacheTtl: 0,
      timeout: 60_000,
      waitFor: 'body',
    }),
  });
  return { status: res.status, data: await res.json().catch(() => null) as any };
}

function scanFlags(text: string): { red: string[]; good: string[] } {
  const lower = text.toLowerCase();
  return {
    red: RED_FLAGS.filter((f) => lower.includes(f.toLowerCase())),
    good: GOOD_SIGNALS.filter((f) => lower.includes(f.toLowerCase())),
  };
}

async function main() {
  console.log(`Honeypot scan against ${API}\n`);

  const summary: Record<string, any> = {};

  for (const [name, url] of Object.entries(HONEYPOTS)) {
    process.stdout.write(`  ${name.padEnd(16)} `);
    try {
      const { status, data } = await scrape(url);
      const html = data?.content?.html || '';
      const text = data?.content?.text || '';
      const shot = data?.content?.screenshot;
      const tier = data?.metadata?.tierUsed;
      const quality = data?.metadata?.qualityScore;

      if (html) writeFileSync(`${OUT}/${name}.html`, html);
      if (text) writeFileSync(`${OUT}/${name}.txt`, text);
      if (shot) writeFileSync(`${OUT}/${name}.png`, Buffer.from(shot, 'base64'));

      const flags = scanFlags(`${html}\n${text}`);
      summary[name] = {
        url,
        status,
        tier,
        qualityScore: quality,
        htmlChars: html.length,
        redFlags: flags.red,
        goodSignals: flags.good,
      };
      console.log(
        `http=${status} tier=${tier ?? '-'} q=${quality ?? '-'} ` +
          `redFlags=${flags.red.length} goodSignals=${flags.good.length}`,
      );
    } catch (err) {
      summary[name] = { url, error: err instanceof Error ? err.message : String(err) };
      console.log(`ERROR ${(err as Error).message}`);
    }
  }

  writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(`\nArtifacts saved to ${OUT}`);
  console.log('Review the .png screenshots — that is the honest truth about what sites saw.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
