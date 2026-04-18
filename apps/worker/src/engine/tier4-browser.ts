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
