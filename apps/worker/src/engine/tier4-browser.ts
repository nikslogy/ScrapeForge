import type { BrowserContext } from 'patchright';
import { installResourceBlocker } from '../browser/resource-blocker.js';

const FLATTEN_SHADOW_DOM_SCRIPT = `
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
`;

const AUTO_SCROLL_SCRIPT = `
  async function() {
    await new Promise(function(resolve) {
      var totalHeight = 0;
      var distance = 800;
      var hardDeadline = Date.now() + 2500;
      var timer = setInterval(function() {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (
          totalHeight >= document.body.scrollHeight ||
          totalHeight > 4000 ||
          Date.now() > hardDeadline
        ) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 60);
    });
  }
`;

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const MOBILE_INIT_SCRIPT = `
  (function() {
    try {
      Object.defineProperty(navigator, 'userAgent', { get: function() { return '${MOBILE_UA}'; }, configurable: true });
      Object.defineProperty(navigator, 'platform',  { get: function() { return 'iPhone'; },         configurable: true });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: function() { return 5; },          configurable: true });
      Object.defineProperty(navigator, 'vendor',    { get: function() { return 'Apple Computer, Inc.'; }, configurable: true });
    } catch (e) {}
  })();
`;

// Baseline fingerprint patches applied to every T4 page. Fixes the three
// big Patchright tells flagged by bot.sannysoft.com: missing window.chrome,
// empty navigator.plugins, and stripped WebGL vendor/renderer. Runs before
// any page script, so the values are set by the time detection code sees them.
const FINGERPRINT_INIT_SCRIPT = `
  (function() {
    try {
      // window.chrome — real Chrome has this object populated. Patchright
      // leaves it undefined in headless mode, which is a cheap bot signal.
      if (!window.chrome) {
        Object.defineProperty(window, 'chrome', {
          get: function() {
            return {
              app: { isInstalled: false },
              runtime: {},
              csi: function() {},
              loadTimes: function() {
                return {
                  requestTime: Date.now() / 1000 - Math.random() * 10,
                  startLoadTime: Date.now() / 1000 - Math.random() * 5,
                  commitLoadTime: Date.now() / 1000 - Math.random() * 3,
                  finishDocumentLoadTime: Date.now() / 1000 - Math.random(),
                  finishLoadTime: Date.now() / 1000,
                  firstPaintTime: Date.now() / 1000 - Math.random() * 2,
                  firstPaintAfterLoadTime: 0,
                  navigationType: 'Other',
                  wasFetchedViaSpdy: false,
                  wasNpnNegotiated: true,
                  npnNegotiatedProtocol: 'h2',
                  wasAlternateProtocolAvailable: false,
                  connectionInfo: 'h2',
                };
              },
            };
          },
          configurable: true,
        });
      }

      // navigator.plugins — real Chrome ships the PDF viewer by default;
      // an empty list screams headless.
      var fakePlugins = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      ];
      Object.defineProperty(navigator, 'plugins', {
        get: function() { return fakePlugins; },
        configurable: true,
      });
      Object.defineProperty(navigator, 'mimeTypes', {
        get: function() {
          return [
            { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
            { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
          ];
        },
        configurable: true,
      });

      // WebGL vendor/renderer — SwiftShader in headless containers is a
      // dead giveaway. Spoof a common Intel iGPU signature.
      var origGetParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return 'Intel Inc.';                   // UNMASKED_VENDOR_WEBGL
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';     // UNMASKED_RENDERER_WEBGL
        return origGetParameter.call(this, parameter);
      };
      if (typeof WebGL2RenderingContext !== 'undefined') {
        var origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) return 'Intel Inc.';
          if (parameter === 37446) return 'Intel Iris OpenGL Engine';
          return origGetParameter2.call(this, parameter);
        };
      }
    } catch (e) { /* best-effort */ }
  })();
`;

export async function tier4Fetch(
  url: string,
  context: BrowserContext,
  options: {
    waitFor?: string;
    timeout?: number;
    blockResources?: boolean;
    mobile?: boolean;
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
    // Apply fingerprint patches before anything navigates. Patchright
    // already hides webdriver at the C++ layer, but still leaves
    // window.chrome undefined and navigator.plugins empty, which several
    // commercial fingerprinters key on.
    await page.addInitScript(FINGERPRINT_INIT_SCRIPT);

    if (options.blockResources !== false) {
      await installResourceBlocker(page);
    }

    // Mobile emulation: apply viewport + UA at the PAGE level so pooled
    // desktop contexts stay reusable. Overrides cleared on page.close().
    if (options.mobile) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.setExtraHTTPHeaders({ 'User-Agent': MOBILE_UA });
      await page.addInitScript(MOBILE_INIT_SCRIPT);
    }

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(options.timeout || 20_000, 20_000),
    });

    if (options.waitFor) {
      await page.waitForSelector(options.waitFor, {
        timeout: Math.min(options.timeout || 8_000, 8_000),
      });
    } else {
      // Short networkidle — lots of sites keep open trackers/websockets
      // that never go idle. 4s is enough for meaningful content loads.
      await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
    }

    // Scroll to trigger lazy-loaded content (hard-capped at ~2.5s).
    await page.evaluate(`(${AUTO_SCROLL_SCRIPT})()`);
    await page.waitForTimeout(400);

    // Flatten Shadow DOM so extraction can read hidden content
    await page.evaluate(FLATTEN_SHADOW_DOM_SCRIPT);

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
