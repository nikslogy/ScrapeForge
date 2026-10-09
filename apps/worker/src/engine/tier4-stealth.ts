import type { BrowserContext, Page } from 'patchright';
import { assertPublicUrl } from '@scrapeforge/shared';
import {
  assertNavigationAllowed,
  ensureContextOutboundGuard,
  installOutboundGuard,
  monitorOutbound,
} from '../browser/outbound-guard.js';
import {
  assertNoRefusedNavigation,
  capturePage,
  closePage,
  envMs,
  fetchDeadline,
  navigationFailure,
  readinessFor,
  trackNavigationHops,
  trackNavigationStatus,
  trackRequests,
} from './tier4-browser.js';

// Optional pause after the page loads, for sites that score instant readers
// as bots. Off by default: it is pure latency. STEALTH_HUMAN_DELAY_MS=600
// waits 300-600 ms.
const MAX_HUMAN_DELAY_MS = 10_000;

export function humanDelayMs(random: () => number = Math.random): number {
  const base = envMs('STEALTH_HUMAN_DELAY_MS', 0, MAX_HUMAN_DELAY_MS);
  return base > 0 ? Math.round(base / 2 + random() * (base / 2)) : 0;
}

/**
 * Tier 4+: Stealth browser mode with deep anti-detection.
 * Used when standard Patchright is blocked (Cloudflare Enterprise, DataDome, PerimeterX).
 *
 * Applies runtime JavaScript patches to hide automation signals that
 * fingerprinting scripts look for. Patchright already handles the
 * major detection vectors at the C++ level, but some advanced WAFs
 * check for JS-level leaks.
 */
async function applyStealthPatches(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (params: any) => {
      if (params.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission } as PermissionStatus);
      }
      return originalQuery(params);
    };

    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
    });

    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter: number) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, parameter);
    };
  });
}

export async function tier4StealthFetch(
  url: string,
  context: BrowserContext,
  options: {
    waitFor?: string;
    /** Overall budget in ms, page reading included (default DEFAULT_FETCH_TIMEOUT_MS). */
    timeout?: number;
    blockResources?: boolean;
    screenshot?: boolean;
    /** Cap for the readiness wait after load (default BROWSER_READY_TIMEOUT_MS or 2.5 s). */
    readyTimeoutMs?: number;
  } = {},
): Promise<{
  html: string;
  statusCode: number;
  screenshot?: string;
  latencyMs: number;
}> {
  const start = performance.now();
  const deadline = fetchDeadline(start, options.timeout);
  // Refuse before spending a page on it. The guards below cover everything
  // the page loads afterwards (see browser/outbound-guard.ts).
  const target = await assertPublicUrl(url);
  await ensureContextOutboundGuard(context);
  const page = await context.newPage();
  const monitor = monitorOutbound(page);
  const tracker = trackRequests(page);
  const navigation = trackNavigationStatus(page);
  const hops = trackNavigationHops(page);

  try {
    // Dropped by Patchright once page.route() follows (see tier4-browser.ts).
    await applyStealthPatches(page);

    // Always installed: blockResources only toggles tracker/media blocking,
    // never the SSRF check.
    await installOutboundGuard(page, { blockResources: options.blockResources !== false });

    // Simulate human-like behavior
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
    });

    const response = await deadline
      .run('navigation', () =>
        page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: deadline.timeoutFor('navigation') }),
      )
      .catch((err: unknown) => {
        throw navigationFailure(err, hops);
      });
    // Route handlers never see redirect hops: check the chain before
    // spending any more time on the page.
    await deadline.run('checking redirects', () => assertNavigationAllowed(response, page.url()));

    const delay = Math.min(humanDelayMs(), deadline.remaining());
    if (delay > 0) await deadline.run('human delay', () => page.waitForTimeout(delay));

    const waitFor = options.waitFor;
    if (waitFor) {
      await deadline.run('waitFor', () =>
        page.waitForSelector(waitFor, { timeout: deadline.timeoutFor('waitFor', 10_000) }),
      );
    }

    const capture = await capturePage(page, {
      tracker,
      monitor,
      navigation,
      fallbackStatus: response?.status() || 200,
      deadline,
      settle: readinessFor({ ...options, timeout: deadline.timeoutMs }, start),
      screenshot: Boolean(options.screenshot),
    });
    assertNoRefusedNavigation(page, hops);

    return {
      html: capture.html,
      statusCode: capture.statusCode,
      screenshot: capture.screenshot,
      latencyMs: Math.round(performance.now() - start),
    };
  } finally {
    hops.dispose();
    navigation.dispose();
    tracker.dispose();
    monitor.dispose();
    await closePage(page);
  }
}
