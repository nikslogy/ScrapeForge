import type { BrowserContext, Page, Request } from 'patchright';
import { assertPublicUrl } from '@scrapeforge/shared';
import {
  assertNavigationAllowed,
  ensureContextOutboundGuard,
  installOutboundGuard,
  monitorOutbound,
} from '../browser/outbound-guard.js';

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

// ─────────────────────────────────────────────────────────────
// Readiness: condition-based waits instead of fixed sleeps
// ─────────────────────────────────────────────────────────────
//
// After domcontentloaded the page is polled every POLL_MS. It is ready when
//   - the network is briefly idle: no request in flight (images included, so
//     the outbound monitor sees every sub-resource redirect before content is
//     returned) for NETWORK_QUIET_MS, ignoring requests older than
//     LONG_REQUEST_MS (long-polls, streams, slow beacons);
//   - its DOM (text length and element count) has not changed for QUIET_MS,
//     unless the page has no scripts (nothing can change it after parsing);
//   - it does not look unfinished: an aria-busy region, an empty app mount
//     point, or a thin page that is blank or says it is loading while scripts
//     run.
// Every wait is bounded by a hard cap; a JS challenge interstitial ("Just a
// moment...") extends the cap so it can resolve and navigate. Auto-scroll
// runs only when the page shows lazy-loading signals, or when a screenshot or
// waitFor selector was requested.

export const DEFAULT_READY_CAP_MS = 2_500;
export const DEFAULT_CHALLENGE_CAP_MS = 6_000;
const POLL_MS = 100;
const QUIET_MS = 300;
const NETWORK_QUIET_MS = 100;
// A request in flight longer than this no longer holds readiness back.
const LONG_REQUEST_MS = 1_500;
// Never finish by design; the long-request cutoff would ignore them anyway.
const UNTRACKED_RESOURCE_TYPES = new Set(['eventsource', 'websocket']);
const MAX_SCROLL_PX = 15_000;

/** Non-negative integer from the environment, else `fallback`. */
export function envMs(name: string, fallback: number, max = 60_000): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : fallback;
}

interface DomSample {
  /** document.readyState is 'complete' (images and frames loaded). */
  complete: boolean;
  text: number;
  nodes: number;
  /** DOM mutations (nodes added/removed, text edited) seen since the document loaded. */
  mutations: number;
  scripts: number;
  unfinished: boolean;
  challenge: boolean;
  scrollHeight: number;
  viewportHeight: number;
  lazy: boolean;
}

// Evaluated in the page (Patchright's isolated world: DOM only, and globals
// set here are invisible to page scripts). A MutationObserver counts content
// changes that keep text length and element count equal (a ticking number).
// Text length excludes script/style contents. innerText (which forces
// layout) is only read on thin pages.
const SAMPLE_SCRIPT = `(() => {
  var st = window.__sfSettle;
  if (!st || st.doc !== document) {
    st = window.__sfSettle = { doc: document, n: 0 };
    try {
      new MutationObserver(function (records) { st.n += records.length; })
        .observe(document, { childList: true, subtree: true, characterData: true });
    } catch (e) {}
  }
  var b = document.body;
  var vh = window.innerHeight || 800;
  var de = document.documentElement;
  if (!b) return { complete: false, text: 0, nodes: de ? de.getElementsByTagName('*').length : 0, mutations: st.n,
    scripts: document.scripts.length, unfinished: true, challenge: false, scrollHeight: 0, viewportHeight: vh, lazy: false };
  var text = (b.textContent || '').length;
  var raw = b.querySelectorAll('script,style,noscript,template');
  for (var i = 0; i < raw.length; i++) text -= (raw[i].textContent || '').length;
  // Executable scripts only: JSON-LD and other data blocks cannot change the DOM.
  var scripts = document.querySelectorAll('script:not([type]),script[type=""],script[type*="javascript" i],' +
    'script[type="module" i]').length;
  var unfinished = !!document.querySelector('[aria-busy="true"]');
  if (!unfinished) {
    var mounts = document.querySelectorAll('#root,#app,#__next,#__nuxt,#___gatsby,#svelte,app-root,[data-reactroot]');
    for (var m = 0; m < mounts.length; m++) {
      if (mounts[m].childElementCount === 0 && !(mounts[m].textContent || '').trim()) { unfinished = true; break; }
    }
  }
  if (!unfinished && scripts > 0 && text < 2000) {
    var visible = (b.innerText || '').replace(/\\s+/g, ' ').trim();
    if (visible.length === 0) {
      unfinished = true;
    } else if (visible.length < 200) {
      unfinished = /\\b(loading|please wait|one moment)\\b/i.test(visible);
      if (!unfinished) {
        var loaders = document.querySelectorAll('[class*="spinner" i],[class*="loader" i],[class*="skeleton" i],' +
          '[class*="loading" i],[role="progressbar"]');
        for (var k = 0; k < loaders.length && k < 20; k++) {
          if (loaders[k].getClientRects().length > 0) { unfinished = true; break; }
        }
      }
    }
  }
  var title = (document.title || '').toLowerCase();
  var refresh = document.querySelector('meta[http-equiv="refresh" i]');
  var refreshSoon = false;
  if (refresh) {
    var delay = parseFloat(refresh.getAttribute('content') || '');
    refreshSoon = isFinite(delay) && delay <= 5;
  }
  var challenge = refreshSoon ||
    /^(just a moment|checking your browser|one moment|please wait|ddos-guard|vercel security checkpoint)/.test(title) ||
    !!document.querySelector('#challenge-running,#cf-challenge-running,#challenge-form,#challenge-stage,.cf-browser-verification,' +
      '#cf-spinner-please-wait,#sec-if-cpt-container,#bm-verify,script[src*="/cdn-cgi/challenge-platform/"]');
  var scrollHeight = Math.max(de ? de.scrollHeight : 0, b.scrollHeight);
  var lazy = !!document.querySelector('img[loading="lazy"],iframe[loading="lazy"],[data-src],[data-srcset],[data-lazy],' +
    '[data-lazy-src],[data-original],img.lazyload,img.lazy,[data-infinite-scroll],[class*="infinite-scroll"],' +
    '[id*="infinite-scroll"],[class*="sentinel"],[id*="sentinel"]');
  return { complete: document.readyState === 'complete', text: text, nodes: document.getElementsByTagName('*').length,
    mutations: st.n, scripts: scripts, unfinished: unfinished,
    challenge: challenge, scrollHeight: scrollHeight, viewportHeight: vh, lazy: lazy };
})()`;

// Scrolls a viewport at a time until the bottom, MAX_SCROLL_PX or `maxMs`,
// then returns to the top (screenshots start there).
const AUTO_SCROLL_SCRIPT = `async (args) => {
  var deadline = Date.now() + args.maxMs;
  var step = Math.max(400, Math.floor((window.innerHeight || 800) * 0.9));
  var y = 0;
  while (Date.now() < deadline && y < args.maxPx) {
    window.scrollBy(0, step);
    y += step;
    await new Promise(function (r) { setTimeout(r, 50); });
    var de = document.documentElement;
    var h = Math.max(de ? de.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
    if (y + (window.innerHeight || 800) >= h) break;
  }
  window.scrollTo(0, 0);
}`;

/**
 * The page's requests in flight. Attach before navigating so the first
 * requests are seen.
 */
export interface RequestTracker {
  /** Requests in flight, ignoring ones older than LONG_REQUEST_MS. */
  inflight(): number;
  /** ms since a request last started or ended; 0 while one is in flight. */
  quietMs(): number;
  dispose(): void;
}

export function trackRequests(page: Page): RequestTracker {
  const started = new Map<Request, number>();
  let lastActivity = performance.now();
  const onRequest = (r: Request) => {
    if (UNTRACKED_RESOURCE_TYPES.has(r.resourceType())) return;
    lastActivity = performance.now();
    started.set(r, lastActivity);
  };
  const onDone = (r: Request) => {
    if (started.delete(r)) lastActivity = performance.now();
  };
  const inflight = () => {
    const now = performance.now();
    let n = 0;
    for (const [r, t] of started) {
      if (now - t < LONG_REQUEST_MS) n++;
      else started.delete(r); // never counted again
    }
    return n;
  };
  page.on('request', onRequest);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);
  return {
    inflight,
    quietMs() {
      return inflight() > 0 ? 0 : performance.now() - lastActivity;
    },
    dispose() {
      page.off('request', onRequest);
      page.off('requestfinished', onDone);
      page.off('requestfailed', onDone);
      started.clear();
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** `promise`, or null after `ms` (or when it rejects). Never leaves a rejection unhandled. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const guarded = promise.catch(() => null);
  try {
    return await Promise.race([guarded, new Promise<null>((r) => (timer = setTimeout(() => r(null), Math.max(0, ms))))]);
  } finally {
    clearTimeout(timer);
  }
}

export interface SettleOptions {
  /** Hard cap for the whole settle phase, scroll included. */
  capMs: number;
  /** Cap while a JS challenge interstitial is showing (never below capMs). */
  challengeCapMs: number;
  /** Scroll even without lazy-loading signals (screenshot or waitFor requested). */
  forceScroll?: boolean;
  /** Also wait for the load event (images), for screenshots. */
  waitForLoad?: boolean;
  /** Never scroll. */
  noScroll?: boolean;
}

export type SettleReason = 'static' | 'stable' | 'cap' | 'challenge-cap';

export interface SettleReport {
  ms: number;
  reason: SettleReason;
  scrolled: boolean;
}

/**
 * Waits until the page is ready by the rules above. Never throws for the
 * page's sake: evaluation failures (a navigation in progress, a busy main
 * thread) count as "still changing" until the cap.
 */
export async function settlePage(page: Page, tracker: RequestTracker, opts: SettleOptions): Promise<SettleReport> {
  const start = performance.now();
  let deadline = start + Math.max(0, opts.capMs);
  let extended = false;
  let scrolled = false;
  let last: DomSample | null = null;
  let lastChange = start;

  const extend = () => {
    if (!extended) {
      extended = true;
      deadline = Math.max(deadline, start + Math.max(0, opts.challengeCapMs));
    }
  };

  for (;;) {
    const remaining = deadline - performance.now();
    const sample = await within(page.evaluate(SAMPLE_SCRIPT) as Promise<DomSample>, Math.max(remaining, 50));
    const now = performance.now();
    if (!sample) {
      lastChange = now;
      last = null;
    } else {
      if (!last || sample.text !== last.text || sample.nodes !== last.nodes || sample.mutations !== last.mutations) {
        lastChange = now;
      }
      last = sample;
      if (sample.challenge) extend();
      const networkIdle =
        tracker.quietMs() >= NETWORK_QUIET_MS && (opts.waitForLoad !== true || sample.complete);
      const done: SettleReason | null =
        !networkIdle || sample.challenge
          ? null
          : sample.scripts === 0
            ? 'static'
            : now - lastChange >= QUIET_MS && !sample.unfinished
              ? 'stable'
              : null;

      if (done) {
        const wantsScroll =
          !opts.noScroll &&
          !scrolled &&
          sample.scrollHeight > sample.viewportHeight * 1.2 &&
          (opts.forceScroll || sample.lazy || isSparse(sample));
        if (!wantsScroll) return { ms: performance.now() - start, reason: done, scrolled };
        scrolled = true;
        const scrollBudget = deadline - performance.now();
        if (scrollBudget > 0) {
          // A string is evaluated as an expression, so the call is part of it.
          const call = `(${AUTO_SCROLL_SCRIPT})(${JSON.stringify({ maxMs: Math.round(scrollBudget), maxPx: MAX_SCROLL_PX })})`;
          await within(page.evaluate(call), scrollBudget + 200);
        }
        // Whatever the scroll triggered must settle too.
        lastChange = performance.now();
        last = null;
        continue;
      }
    }
    if (performance.now() >= deadline) {
      return { ms: performance.now() - start, reason: extended ? 'challenge-cap' : 'cap', scrolled };
    }
    await sleep(Math.min(POLL_MS, deadline - performance.now()));
  }
}

/** Tall page with little text per screen: content is probably still placeholders. */
function isSparse(s: DomSample): boolean {
  const screens = s.scrollHeight / Math.max(1, s.viewportHeight);
  return screens > 3 && s.text < screens * 200;
}

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
    // Apply fingerprint patches before anything navigates. Patchright
    // already hides webdriver at the C++ layer, but still leaves
    // window.chrome undefined and navigator.plugins empty, which several
    // commercial fingerprinters key on.
    //
    // Known Patchright 1.59.4 behaviour (checked with Chromium 141): the
    // page.route() below makes Patchright drop this init script, so it does
    // not run. Installing the route first makes it run, but then every
    // cross-origin redirected sub-resource stalls (the page's load event
    // never fires), which breaks CDN-redirected scripts and images. The
    // order is kept until that is fixed upstream.
    await page.addInitScript(FINGERPRINT_INIT_SCRIPT);

    // Always installed: blockResources only toggles tracker/media blocking,
    // never the SSRF check.
    await installOutboundGuard(page, { blockResources: options.blockResources !== false });

    // Mobile emulation: apply viewport + UA at the PAGE level so pooled
    // desktop contexts stay reusable. Overrides cleared on page.close().
    if (options.mobile) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.setExtraHTTPHeaders({ 'User-Agent': MOBILE_UA });
      await page.addInitScript(MOBILE_INIT_SCRIPT);
    }

    const response = await page.goto(target.href, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(options.timeout || 20_000, 20_000),
    });
    // Route handlers never see redirect hops: check the chain before
    // spending any more time on the page.
    await assertNavigationAllowed(response, page.url());

    if (options.waitFor) {
      await page.waitForSelector(options.waitFor, {
        timeout: Math.min(options.timeout || 8_000, 8_000),
      });
    }
    await settlePage(page, tracker, readinessFor(options, start));

    // Flatten Shadow DOM so extraction can read hidden content
    await page.evaluate(FLATTEN_SHADOW_DOM_SCRIPT);

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

/**
 * Settle options for a fetch: the cap is `readyTimeoutMs`, else
 * BROWSER_READY_TIMEOUT_MS, else 2.5 s, and never runs past the caller's
 * overall `timeout` (measured from `start`).
 */
export function readinessFor(
  options: { waitFor?: string; timeout?: number; screenshot?: boolean; readyTimeoutMs?: number },
  start: number,
): SettleOptions {
  let capMs = options.readyTimeoutMs ?? envMs('BROWSER_READY_TIMEOUT_MS', DEFAULT_READY_CAP_MS);
  let challengeCapMs = envMs('BROWSER_CHALLENGE_TIMEOUT_MS', DEFAULT_CHALLENGE_CAP_MS);
  if (options.timeout) {
    const left = Math.max(0, options.timeout - (performance.now() - start));
    capMs = Math.min(capMs, left);
    challengeCapMs = Math.min(challengeCapMs, left);
  }
  return {
    capMs,
    challengeCapMs: Math.max(capMs, challengeCapMs),
    forceScroll: Boolean(options.screenshot || options.waitFor),
    waitForLoad: Boolean(options.screenshot),
  };
}
