// Locates a Chromium binary for the browser-tier scenarios. Kept free of
// patchright imports so it is cheap to call (and to test).

import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

export const DEFAULT_BROWSER_ROOTS: readonly string[] = ['/opt/pw-browsers', join(os.homedir(), '.cache', 'ms-playwright')];

/**
 * LATENCY_CHROMIUM_PATH if it exists; otherwise the newest
 * `chromium-<revision>/chrome-linux/chrome` under PLAYWRIGHT_BROWSERS_PATH
 * and `roots`. Null when nothing usable is installed.
 */
export function findChromium(
  env: NodeJS.ProcessEnv = process.env,
  roots: readonly string[] = DEFAULT_BROWSER_ROOTS,
): string | null {
  if (env.LATENCY_CHROMIUM_PATH) return existsSync(env.LATENCY_CHROMIUM_PATH) ? env.LATENCY_CHROMIUM_PATH : null;
  let best: { rev: number; path: string } | null = null;
  for (const root of [env.PLAYWRIGHT_BROWSERS_PATH, ...roots]) {
    if (!root || !existsSync(root)) continue;
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue; // unreadable cache dir: treat as absent
    }
    for (const name of names) {
      const match = /^chromium-(\d+)$/.exec(name);
      if (!match) continue;
      const path = join(root, name, 'chrome-linux', 'chrome');
      if (existsSync(path) && (!best || Number(match[1]) > best.rev)) best = { rev: Number(match[1]), path };
    }
  }
  return best?.path ?? null;
}
