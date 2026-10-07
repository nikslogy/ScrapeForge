// Browser tiers for the harness. The installed Chromium build may not be the
// revision patchright expects, so BrowserPool (which calls chromium.launch()
// with no executablePath) is given the binary through a launch shim instead
// of modifying product code or the browser cache.

import { chromium } from 'patchright';
import { BrowserPool } from '../../../apps/worker/src/browser/pool.js';

/** The worker's BrowserPool (same sizes as worker.ts), launched with `executablePath`. */
export async function openBrowserPool(executablePath: string, maxContexts = 5): Promise<BrowserPool> {
  const launch = chromium.launch;
  chromium.launch = (options) => launch.call(chromium, { ...options, executablePath });
  const pool = new BrowserPool(maxContexts, 100, 30 * 60 * 1000);
  try {
    await pool.initialize();
    return pool;
  } catch (err) {
    // A failure after launch (e.g. creating the warm contexts) would leave Chromium running.
    await pool.shutdown().catch(() => {});
    throw err;
  } finally {
    chromium.launch = launch;
  }
}
