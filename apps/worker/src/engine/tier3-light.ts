import { chromium } from 'patchright';
import { assertPublicUrl, isOutboundBlockedError } from '@scrapeforge/shared';
import { assertNavigationAllowed } from '../browser/outbound-guard.js';

const LIGHTPANDA_URL = process.env.LIGHTPANDA_URL; // e.g. wss://euwest.cloud.lightpanda.io or ws://localhost:9222

/**
 * Tier 3: Lightweight headless browser via Lightpanda CDP.
 * 25x faster and 60x less memory than full Chromium for JS rendering.
 * Falls back gracefully when Lightpanda is not configured.
 */
export async function tier3Fetch(
  url: string,
  options: {
    waitFor?: string;
    timeout?: number;
    proxy?: string;
  } = {},
): Promise<{
  html: string;
  statusCode: number;
  latencyMs: number;
} | null> {
  if (!LIGHTPANDA_URL) return null;

  const start = performance.now();
  // Checked before connecting, so a refused URL never reaches the browser.
  // No request guard runs inside Lightpanda (its CDP request interception is
  // not relied on), so only the navigation chain and the final URL are
  // checked afterwards. Sub-requests are not: a self-hosted Lightpanda
  // inside our network should sit behind an egress policy of its own.
  const target = await assertPublicUrl(url);

  let browser;
  try {
    browser = await chromium.connectOverCDP(LIGHTPANDA_URL, {
      timeout: 10_000,
    });

    const context = browser.contexts()[0] || await browser.newContext();
    const page = await context.newPage();

    try {
      const response = await page.goto(target.href, {
        waitUntil: 'domcontentloaded',
        timeout: options.timeout || 20_000,
      });
      await assertNavigationAllowed(response, page.url());

      if (options.waitFor) {
        await page.waitForSelector(options.waitFor, {
          timeout: Math.min(options.timeout || 8_000, 8_000),
        });
      } else {
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      }

      // Page scripts may have navigated since the initial load.
      await assertNavigationAllowed(null, page.url());
      const html = await page.content();
      const statusCode = response?.status() || 200;

      return {
        html,
        statusCode,
        latencyMs: Math.round(performance.now() - start),
      };
    } finally {
      await page.close();
    }
  } catch (err) {
    // A refused destination is a verdict, not a Lightpanda failure: let the
    // router record it instead of treating it as "no result".
    if (isOutboundBlockedError(err)) throw err;
    console.warn(`[Tier3] Lightpanda failed for ${url}:`, (err as Error).message);
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}

export function isLightpandaConfigured(): boolean {
  return !!LIGHTPANDA_URL;
}
