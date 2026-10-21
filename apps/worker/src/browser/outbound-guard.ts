// SSRF guard for browser tiers.
//
// 0. The pooled Chromium connects only through the local egress guard
//    (browser/pool.ts, net/egress-proxy.ts), which resolves every destination
//    itself and refuses blocked addresses when the connection is made. That
//    covers what the layers below cannot prevent: redirect hops, WebSockets,
//    workers, popups, and DNS answers that change after a check. Loopback is
//    not bypassed: the guard decides for it too.
//
// The layers below are kept as defence in depth, and so that a page that
// tried to reach a blocked destination fails the fetch with an
// OutboundBlockedError instead of returning content:
//
// 1. Route handlers (page and context) check every request Chromium hands to
//    interception and abort the ones aimed at private/reserved destinations.
//    The page handler settles its page's requests; the context handler covers
//    what page handlers never see: popups and service worker requests.
// 2. Redirect hops and WebSockets never reach route handlers. A monitor checks
//    them as they happen, on every page of the context (popups included);
//    any violation fails the fetch. On its own this layer only detects: the
//    hop or handshake has already been sent when it is seen. Layer 0 is what
//    keeps it from being sent.
// 3. The navigation's redirect chain and the final page URL are re-checked
//    before content is read.

import type { BrowserContext, Page, Request, Response, Route, WebSocket } from 'patchright';
import { assertPublicUrl, isOutboundBlockedError, OutboundBlockedError } from '@scrapeforge/shared';
import { Semaphore } from '../throughput/limits.js';
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
  /**
   * Headers a browser sends anyway (Accept-Language, User-Agent): set on
   * Chromium's own request for `origin` (the target's). Harmless should a
   * redirect carry them on.
   */
  extraHeaders?: Readonly<Record<string, string>>;
  /**
   * Any other custom header (Authorization, an API key): it may be a
   * credential. Sent to `origin` only, on the requests that make the page
   * (SECRET_TYPES), by a fetch that follows redirects only within `origin`
   * (below).
   */
  secretHeaders?: Readonly<Record<string, string>>;
  origin?: string;
  /** The page's context: its request API follows redirect hops, and its fetches in flight are counted (see hasPendingSecretFetches). */
  context?: BrowserContext;
  /** Time left in the tier's budget: the bound on each fetch that carries the secret headers. */
  remainingMs?: () => number;
  /** A main-frame GET navigation whose same-origin redirects were followed here: the URL asked for, and the one it ended on. */
  onRedirected?: (requested: string, finalUrl: string) => void;
}): (route: Route) => Promise<void> {
  const pageSlots = new Semaphore(SECRET_FETCHES_PER_PAGE);
  return async (route) => {
    const request = route.request();
    const url = request.url();
    const allowed =
      !(options.blockResources && shouldBlockResource(request.resourceType(), url)) &&
      (await checkBrowserUrl(url)) === null;
    try {
      const target = options.origin !== undefined && originOf(url) === options.origin;
      if (!allowed) {
        await route.abort();
      } else if (target && options.secretHeaders && SECRET_TYPES.has(request.resourceType())) {
        await fetchWithSecrets(route, request, { ...options, origin: options.origin as string, secretHeaders: options.secretHeaders }, pageSlots);
      } else if (target && options.extraHeaders) {
        await route.continue({ headers: { ...request.headers(), ...options.extraHeaders } });
      } else {
        await route.continue();
      }
    } catch {
      // The page closed during the check, another handler already resolved
      // the route, or the fetch failed: fail the request rather than leave
      // it pending until the navigation times out.
      await route.abort().catch(() => undefined);
    }
  };
}

/**
 * Requests fetched here with the secret headers: what makes the page and
 * its data. Images, fonts, media and the rest are continued by Chromium
 * without them: a fetch here holds each body in the worker's memory and
 * opens a connection of its own, while what they hold is not text. So are
 * streams (EventSource, WebSocket), which a fetch here would buffer until
 * they end. (A fetch() or XHR whose body the page reads as a stream is
 * buffered all the same: with secret headers it arrives when it ends,
 * within the tier's budget.)
 */
const SECRET_TYPES: ReadonlySet<string> = new Set(['document', 'xhr', 'fetch', 'script', 'stylesheet']);
/** Credentialed fetches in flight per page: Chromium's own limit per host. */
const SECRET_FETCHES_PER_PAGE = 6;
/** ...and per worker, well under the egress guard's connection cap (each fetch opens its own connection). */
const SECRET_FETCHES_PER_WORKER = 64;
const workerSecretSlots = new Semaphore(SECRET_FETCHES_PER_WORKER);
/** Same-origin redirect hops followed with the secret headers, at most. */
const MAX_SECRET_HOPS = 10;
const BODY_HEADER = /^(?:content-type|content-length|content-encoding|transfer-encoding)$/i;

/**
 * Credentialed fetches not yet settled, per context. A fetch here is not
 * cancelled when its page closes, and it stores its response's cookies in
 * the context: a context with one still in flight must not be cleaned and
 * handed to another fetch (BrowserPool.release retires it instead).
 */
const pendingSecretFetches = new WeakMap<BrowserContext, number>();

export function hasPendingSecretFetches(context: BrowserContext): boolean {
  return (pendingSecretFetches.get(context) ?? 0) > 0;
}

interface SecretOptions {
  extraHeaders?: Readonly<Record<string, string>>;
  secretHeaders: Readonly<Record<string, string>>;
  origin: string;
  context?: BrowserContext;
  remainingMs?: () => number;
  onRedirected?: (requested: string, finalUrl: string) => void;
}

/** fetchWithSecrets within the page's and the worker's limits, counted against the context while it runs. */
async function fetchWithSecrets(route: Route, request: Request, options: SecretOptions, pageSlots: Semaphore): Promise<void> {
  const { context } = options;
  if (context) pendingSecretFetches.set(context, (pendingSecretFetches.get(context) ?? 0) + 1);
  try {
    // The page's own navigation does not wait behind its slow scripts (the worker's limit still holds).
    const releasePage = isMainFrameNavigation(request) ? () => undefined : await pageSlots.acquire();
    try {
      const releaseWorker = await workerSecretSlots.acquire();
      try {
        await followWithSecrets(route, request, options);
      } finally {
        releaseWorker();
      }
    } finally {
      releasePage();
    }
  } finally {
    if (context) {
      const left = (pendingSecretFetches.get(context) ?? 1) - 1;
      if (left > 0) pendingSecretFetches.set(context, left);
      else pendingSecretFetches.delete(context);
    }
  }
}

/**
 * The request fetched here with the secret headers. Chromium keeps a
 * continued request's header overrides on every redirect hop, and the hops
 * never reach a route handler: a target redirecting to an identity provider
 * would carry the credential there. So redirects are not left to Chromium:
 * one within the origin is followed here, with the headers (each hop
 * checked, and sent by the context's request API, so a GET after a 303
 * carries no body); one to another origin goes back to the browser, which
 * follows it without them. A script, style or frame redirected into
 * another directory goes back too: its relative URLs (module imports,
 * url()) resolve against its own address, which a fulfilled body cannot
 * carry. A main-frame GET that ended on another URL of the origin is
 * reported (onRedirected): the tier loads that URL, so the page has its own
 * address. Each body is released once served.
 */
async function followWithSecrets(route: Route, request: Request, options: SecretOptions): Promise<void> {
  const requested = request.url();
  const mainFrame = isMainFrameNavigation(request);
  const followsInPlace = mainFrame || request.resourceType() === 'xhr' || request.resourceType() === 'fetch';
  let url = requested;
  let method = request.method();
  let body = request.postDataBuffer();
  let headers: Record<string, string> = { ...request.headers(), ...options.extraHeaders, ...options.secretHeaders };
  for (let hop = 0; ; hop++) {
    const left = options.remainingMs ? options.remainingMs() : undefined;
    if (left !== undefined && left <= 0) throw new Error('the tier\'s budget is spent');
    const timeout = left !== undefined ? { timeout: Math.max(1, Math.floor(left)) } : {};
    const response =
      hop === 0
        ? await route.fetch({ url, method, headers, ...(body ? { postData: body } : {}), maxRedirects: 0, ...timeout })
        : await (options.context as BrowserContext).request.fetch(url, { method, headers, ...(body ? { data: body } : {}), maxRedirects: 0, ...timeout });
    const status = response.status();
    const rawLocation = response.headers().location;
    const location = utf8Header(rawLocation);
    let next = hop < MAX_SECRET_HOPS && options.context ? await sameOriginRedirect(status, location, url, options.origin) : null;
    if (next !== null && !followsInPlace && directoryOf(next) !== directoryOf(url)) next = null;
    if (next === null) {
      try {
        if (mainFrame && url !== requested && request.method() === 'GET' && method === 'GET' && !isRedirectStatus(status)) {
          options.onRedirected?.(requested, url);
        }
        await route.fulfill(location !== rawLocation ? { response, headers: { ...response.headers(), location: location as string } } : { response });
      } finally {
        await response.dispose().catch(() => undefined);
      }
      return;
    }
    await response.dispose().catch(() => undefined);
    // As browsers do: a 303, or a 301/302 answering a POST, is followed with a GET.
    if (status === 303 ? method !== 'HEAD' : (status === 301 || status === 302) && method === 'POST') {
      method = 'GET';
      body = null;
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !BODY_HEADER.test(name)));
    }
    // The context's cookies for the next URL (and any the hop just set) come from its own jar.
    headers = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'cookie'));
    url = next;
  }
}

/**
 * A header value as Chromium reads it: its bytes as UTF-8 ("/straße"), not
 * as the Latin-1 the fetch decoded them with ("/straÃ\u009fe", which would
 * be percent-encoded twice). Unchanged when the bytes are not UTF-8.
 */
function utf8Header(value: string | undefined): string | undefined {
  if (value === undefined || !/[\u0080-\u00ff]/.test(value) || /[^\u0000-\u00ff]/.test(value)) return value;
  const decoded = Buffer.from(value, 'latin1').toString('utf8');
  return decoded.includes('\ufffd') ? value : decoded;
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status <= 399 && status !== 304;
}

function directoryOf(url: string): string {
  const path = new URL(url).pathname;
  return path.slice(0, path.lastIndexOf('/') + 1);
}

/** Where a 3xx within `origin` leads, when the browser may load it; null for anything else. */
async function sameOriginRedirect(status: number, location: string | undefined, from: string, origin: string): Promise<string | null> {
  if (status < 300 || status > 399 || status === 304 || !location) return null;
  let next: string;
  try {
    next = new URL(location, from).href;
  } catch {
    return null;
  }
  if (originOf(next) !== origin) return null;
  return (await checkBrowserUrl(next)) === null ? next : null;
}

function isMainFrameNavigation(request: Request): boolean {
  try {
    return request.isNavigationRequest() && request.frame().parentFrame() === null;
  } catch {
    // Service worker requests have no frame.
    return false;
  }
}

/** `url` without its fragment. */
export function withoutFragment(url: string): string {
  const i = url.indexOf('#');
  return i < 0 ? url : url.slice(0, i);
}

/**
 * Guard every request of `page`. `blockResources` only toggles
 * tracker/media blocking; `extraHeaders` and `secretHeaders` go to `origin` only.
 */
export async function installOutboundGuard(
  page: Page,
  options: {
    blockResources?: boolean;
    extraHeaders?: Readonly<Record<string, string>>;
    secretHeaders?: Readonly<Record<string, string>>;
    origin?: string;
    remainingMs?: () => number;
    onRedirected?: (requested: string, finalUrl: string) => void;
  } = {},
): Promise<void> {
  const scoped = options.origin !== undefined;
  await page.route(
    ALL_URLS,
    createOutboundRouteHandler({
      blockResources: options.blockResources ?? false,
      ...(scoped && options.extraHeaders ? { extraHeaders: options.extraHeaders } : {}),
      ...(scoped && options.secretHeaders ? { secretHeaders: options.secretHeaders, context: page.context() } : {}),
      ...(scoped ? { origin: options.origin } : {}),
      ...(options.remainingMs ? { remainingMs: options.remainingMs } : {}),
      ...(options.onRedirected ? { onRedirected: options.onRedirected } : {}),
    }),
  );
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
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
 * the page's context (Playwright follows them internally) and WebSockets of
 * the page and of every page opened in its context while the monitor runs
 * (popups). WebSockets are observed rather than routed:
 * page.routeWebSocket works by replacing window.WebSocket inside the page,
 * which anti-bot scripts can detect and which does not cover workers.
 */
export function monitorOutbound(page: Page): OutboundMonitor {
  const context = page.context();
  const pending = new Set<Promise<void>>();
  const watched = new Set<Page>();
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
  const watch = (p: Page) => {
    if (watched.has(p)) return;
    watched.add(p);
    p.on('websocket', onWebSocket);
  };

  context.on('request', onRequest);
  // Popups and any other page opened while the fetch runs. A pooled context
  // holds no other page: the pool closes leftovers between fetches.
  context.on('page', watch);
  watch(page);

  return {
    async assertClean() {
      // Only checks started before this call matter: content was captured first.
      await Promise.all([...pending]);
      if (violation) throw violation;
    },
    dispose() {
      context.off('request', onRequest);
      context.off('page', watch);
      for (const p of watched) p.off('websocket', onWebSocket);
      watched.clear();
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
