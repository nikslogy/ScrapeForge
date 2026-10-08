import type { BrowserContext, Page } from 'patchright';
import { assertPublicUrl } from '@scrapeforge/shared';
import {
  assertNavigationAllowed,
  ensureContextOutboundGuard,
  installOutboundGuard,
  monitorOutbound,
} from '../browser/outbound-guard.js';
import { envMs, readinessFor, settlePage, trackRequests } from './tier4-browser.js';

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
  // Refuse before spending a page on it. The guards below cover everything
  // the page loads afterwards (see browser/outbound-guard.ts).
  const target = await assertPublicUrl(url);
  await ensureContextOutboundGuard(context);
  const page = await context.newPage();
  const monitor = monitorOutbound(page);
  const tracker = trackRequests(page);

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

    const response = await page.goto(target.href, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeout || 30_000,
    });
    // Route handlers never see redirect hops: check the chain before
    // spending any more time on the page.
    await assertNavigationAllowed(response, page.url());

    const delay = humanDelayMs();
    if (delay > 0) await page.waitForTimeout(delay);

    if (options.waitFor) {
      await page.waitForSelector(options.waitFor, {
        timeout: Math.min(options.timeout || 10_000, 10_000),
      });
    }
    await settlePage(page, tracker, readinessFor(options, start));

    // Flatten Shadow DOM so extraction can see hidden content
    await page.evaluate(`
      (function() {
        function go(root) {
          var els = root.querySelectorAll('*');
          for (var i = 0; i < els.length; i++) {
            if (els[i].shadowRoot) {
              go(els[i].shadowRoot);
              var w = document.createElement('div');
              w.setAttribute('data-shadow-flattened', 'true');
              w.innerHTML = els[i].shadowRoot.innerHTML;
              els[i].appendChild(w);
            }
          }
        }
        go(document);
      })();
    `);

    // Page scripts may have navigated since the initial load.
    await assertNavigationAllowed(null, page.url());
    const html = await page.content();
    const statusCode = response?.status() || 200;

    let screenshot: string | undefined;
    if (options.screenshot) {
      const buffer = await page.screenshot({ fullPage: true, type: 'png' });
      screenshot = buffer.toString('base64');
    }

    // Nothing is returned if any redirect hop or WebSocket reached a
    // blocked destination while the page was loading.
    await monitor.assertClean();

    return {
      html,
      statusCode,
      screenshot,
      latencyMs: Math.round(performance.now() - start),
    };
  } finally {
    tracker.dispose();
    monitor.dispose();
    await page.close();
  }
}
