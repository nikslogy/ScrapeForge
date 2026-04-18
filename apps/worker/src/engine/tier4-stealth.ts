import type { BrowserContext, Page } from 'patchright';
import { installResourceBlocker } from '../browser/resource-blocker.js';

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
  } = {},
): Promise<{
  html: string;
  statusCode: number;
  screenshot?: string;
  latencyMs: number;
}> {
  const start = performance.now();
  const page = await context.newPage();

  try {
    await applyStealthPatches(page);

    if (options.blockResources !== false) {
      await installResourceBlocker(page);
    }

    // Simulate human-like behavior
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
    });

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeout || 30_000,
    });

    // Small random delay to look human
    await page.waitForTimeout(300 + Math.floor(Math.random() * 700));

    if (options.waitFor) {
      await page.waitForSelector(options.waitFor, {
        timeout: Math.min(options.timeout || 10_000, 10_000),
      });
    } else {
      await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
    }

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

    const html = await page.content();
    const statusCode = response?.status() || 200;

    let screenshot: string | undefined;
    if (options.screenshot) {
      const buffer = await page.screenshot({ fullPage: true, type: 'png' });
      screenshot = buffer.toString('base64');
    }

    return {
      html,
      statusCode,
      screenshot,
      latencyMs: Math.round(performance.now() - start),
    };
  } finally {
    await page.close();
  }
}
