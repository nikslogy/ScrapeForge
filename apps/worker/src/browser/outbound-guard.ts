// SSRF guard for browser tiers.
//
// Three layers, because Playwright route handlers do not see everything:
//
// 1. Route handlers (page and context) check every request Chromium hands to
//    interception and abort the ones aimed at private/reserved destinations.
//    The page handler settles its page's requests; the context handler covers
//    what page handlers never see: popups and service worker requests.
// 2. Redirect hops and WebSockets never reach route handlers. A monitor checks
//    them as they happen; any violation fails the fetch so nothing the page
//    loaded from a blocked destination is returned.
// 3. The navigation's redirect chain and the final page URL are re-checked
//    before content is read.
//
// Layer 2 detects but cannot prevent: a redirect hop or WebSocket handshake to
// a blocked address has already been sent when we see it (blind SSRF). Closing
// that needs an egress proxy that enforces the policy at connect time.

import type { BrowserContext, Page, Request, Response, Route, WebSocket } from 'patchright';
import { assertPublicUrl, isOutboundBlockedError, OutboundBlockedError } from '@scrapeforge/shared';
import { shouldBlockResource } from './resource-blocker.js';

// Content that never leaves the browser process.
const IN_BROWSER_SCHEMES = new Set(['data:', 'blob:', 'about:']);

const WS_TO_HTTP: Readonly<Record<string, string>> = { 'ws:': 'http:', 'wss:': 'https:' };

// Chromium's internal page after a failed navigation; not a fetched destination.
const ERROR_PAGE_PREFIX = 'chrome-error://';

const MAX_REDIRECT_CHAIN = 50;

const ALL_URLS = (): boolean => true;

/**
 * Why the browser may not load `rawUrl`, or null when it may. data:, blob:
 * and about: are allowed; http(s) and ws(s) must pass assertPublicUrl; every
 * other scheme (file:, ftp:, chrome:, ...) is refused. Never throws.
 */
export async function checkBrowserUrl(rawUrl: string): Promise<OutboundBlockedError | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return new OutboundBlockedError('invalid-url', '', 'invalid URL');
  }
  if (IN_BROWSER_SCHEMES.has(url.protocol)) return null;
  const httpScheme = WS_TO_HTTP[url.protocol];
  if (httpScheme) url.protocol = httpScheme;

  try {
    await assertPublicUrl(url);
    return null;
  } catch (err) {
    if (isOutboundBlockedError(err)) return err;
    // DNS failure: Chromium resolves on its own and might get an answer we
    // never checked, so fail closed.
    return new OutboundBlockedError(
      'unverified',
      url.hostname,
      `${url.hostname.slice(0, 100)} could not be verified`,
    );
  }
}

/**
 * One route handler for both concerns: tracker/media blocking (optional) and
 * the SSRF check (always). It settles every request itself.
 *
 * Allowed requests are continued explicitly, not passed on with fallback():
 * with Patchright, a request left to the default continuation (fallback with
 * no later handler, or no route at all) never settles after a cross-origin
 * redirect once an init script is installed, so networkidle waits run to
 * their timeout (measured +4 s per page). Explicit continue() avoids that.
 */
export function createOutboundRouteHandler(options: {
  blockResources: boolean;
}): (route: Route) => Promise<void> {
  return async (route) => {
    const request = route.request();
    const url = request.url();
    const allowed =
      !(options.blockResources && shouldBlockResource(request.resourceType(), url)) &&
      (await checkBrowserUrl(url)) === null;
    try {
      await (allowed ? route.continue() : route.abort());
    } catch {
      // The page closed during the check, or another handler already
      // resolved the route; either way there is nothing left to do.
    }
  };
}

/** Guard every request of `page`. `blockResources` only toggles tracker/media blocking. */
export async function installOutboundGuard(
  page: Page,
  options: { blockResources?: boolean } = {},
): Promise<void> {
  await page.route(ALL_URLS, createOutboundRouteHandler({ blockResources: options.blockResources ?? false }));
}

const contextGuards = new WeakMap<BrowserContext, Promise<void>>();

/**
 * Guard requests no page handler sees (popups, service workers). Installed
 * once per context: pooled contexts are reused across many fetches.
 */
export function ensureContextOutboundGuard(context: BrowserContext): Promise<void> {
  const existing = contextGuards.get(context);
  if (existing) return existing;
  const installed = context
    .route(ALL_URLS, createOutboundRouteHandler({ blockResources: false }))
    .then(() => undefined);
  contextGuards.set(context, installed);
  // Let a later fetch retry if installation failed.
  installed.catch(() => contextGuards.delete(context));
  return installed;
}

export interface OutboundMonitor {
  /** Wait for the checks started so far; throw the first violation seen. */
  assertClean(): Promise<void>;
  dispose(): void;
}

/**
 * Watch what route handlers cannot intercept: redirect hops of any request in
 * the page's context (Playwright follows them internally) and WebSockets.
 * WebSockets are observed rather than routed: page.routeWebSocket works by
 * replacing window.WebSocket inside the page, which anti-bot scripts can
 * detect and which does not cover workers.
 */
export function monitorOutbound(page: Page): OutboundMonitor {
  const context = page.context();
  const pending = new Set<Promise<void>>();
  let violation: OutboundBlockedError | null = null;

  const check = (rawUrl: string) => {
    const task = checkBrowserUrl(rawUrl).then((blocked) => {
      violation ??= blocked;
    });
    pending.add(task);
    void task.then(() => pending.delete(task));
  };
  const onRequest = (request: Request) => {
    if (request.redirectedFrom()) check(request.url());
  };
  const onWebSocket = (ws: WebSocket) => check(ws.url());

  context.on('request', onRequest);
  page.on('websocket', onWebSocket);

  return {
    async assertClean() {
      // Only checks started before this call matter: content was captured first.
      await Promise.all([...pending]);
      if (violation) throw violation;
    },
    dispose() {
      context.off('request', onRequest);
      page.off('websocket', onWebSocket);
    },
  };
}

/**
 * Check every hop of a navigation (`response` may be null, e.g. for
 * same-document navigations) and the page's current URL. Throws the first
 * OutboundBlockedError found.
 */
export async function assertNavigationAllowed(
  response: Response | null,
  finalUrl: string,
): Promise<void> {
  const urls = new Set<string>();
  let request: Request | null = response?.request() ?? null;
  for (let i = 0; request && i < MAX_REDIRECT_CHAIN; i++) {
    urls.add(request.url());
    request = request.redirectedFrom();
  }
  if (!finalUrl.startsWith(ERROR_PAGE_PREFIX)) urls.add(finalUrl);

  const verdicts = await Promise.all([...urls].map(checkBrowserUrl));
  const blocked = verdicts.find((v) => v !== null);
  if (blocked) throw blocked;
}
