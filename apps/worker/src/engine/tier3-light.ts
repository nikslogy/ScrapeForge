import { chromium } from 'patchright';
import { assertPublicUrl, isOutboundBlockedError } from '@scrapeforge/shared';
import { assertNavigationAllowed } from '../browser/outbound-guard.js';

// Lightpanda runs pages in its own process, out of reach of the worker's
// egress guard and route guard: requests its pages' scripts make are not
// checked against the outbound policy, and what they read can end up in the
// returned HTML. Tier 3 is therefore used only when the operator asserts,
// with LIGHTPANDA_EGRESS_GUARDED=1, that the instance at LIGHTPANDA_URL
// (e.g. wss://euwest.cloud.lightpanda.io or ws://localhost:9222) sits behind
// an egress policy enforced at connect time: a network policy that denies
// private and reserved ranges, or a proxy that applies isBlockedAddress to
// the address it connects to. Without it, tier 3 is skipped (logged once).
let warnedUnguarded = false;

/** The Lightpanda endpoint to use, or undefined when tier 3 is off. */
function lightpandaEndpoint(): string | undefined {
  const url = process.env.LIGHTPANDA_URL;
  if (!url) return undefined;
  if (process.env.LIGHTPANDA_EGRESS_GUARDED !== '1') {
    if (!warnedUnguarded) {
      warnedUnguarded = true;
      // The endpoint itself is not logged: it can carry an access token.
      console.warn(
        '[Tier3] LIGHTPANDA_URL is set but LIGHTPANDA_EGRESS_GUARDED is not 1: Lightpanda is not used, ' +
          'because requests made by its pages bypass the outbound policy. Set LIGHTPANDA_EGRESS_GUARDED=1 ' +
          'only when the instance sits behind an egress policy that blocks private and reserved addresses.',
      );
    }
    return undefined;
  }
  return url;
}

/**
 * Tier 3: Lightweight headless browser via Lightpanda CDP.
 * 25x faster and 60x less memory than full Chromium for JS rendering.
 * Returns null when Lightpanda is not configured or not declared
 * egress-guarded (see lightpandaEndpoint).
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
  const endpoint = lightpandaEndpoint();
  if (!endpoint) return null;

  const start = performance.now();
  // Checked before connecting, so a refused URL never reaches the browser.
  // No request guard runs inside Lightpanda (its CDP request interception is
  // not relied on), so only the navigation chain and the final URL are
  // checked here; sub-requests are left to the egress policy the operator
  // asserted with LIGHTPANDA_EGRESS_GUARDED=1.
  const target = await assertPublicUrl(url);

  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint, {
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
    console.warn(`[Tier3] Lightpanda failed for ${url}:`, redactEndpoint(String((err as Error)?.message ?? err), endpoint));
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * `message` without the parts of `endpoint` that can carry an access token
 * (query string, credentials): connection errors quote the endpoint, also
 * rewritten (".../json/version/?token=...").
 */
function redactEndpoint(message: string, endpoint: string): string {
  const secrets = [endpoint];
  try {
    const u = new URL(endpoint);
    secrets.push(u.search.slice(1), decodeURIComponent(u.password), u.password, decodeURIComponent(u.username), u.username);
  } catch {
    // Not a URL: only the literal is redacted.
  }
  let out = message;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('[redacted]');
  return out;
}

/** True when tier 3 may run: LIGHTPANDA_URL set and LIGHTPANDA_EGRESS_GUARDED=1. */
export function isLightpandaConfigured(): boolean {
  return lightpandaEndpoint() !== undefined;
}
