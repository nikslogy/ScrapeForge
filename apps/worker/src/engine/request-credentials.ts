// The request's own cookies and custom headers, applied by every fetch tier.
//
// HTTP tiers send matching cookies in a Cookie header; redirect hops that
// leave the initial origin drop it with Authorization (headersForHop).
// Browser tiers add the cookies to the (pooled) context, which the pool
// clears before the next fetch, and add custom headers only to requests for
// the target's own origin, so credentials never reach third-party scripts,
// CDNs or trackers the page loads.

import type { CookieInput } from '@scrapeforge/shared';

// A cookie value with a control character (tab included) or ";" is refused
// by Chromium and by HTTP clients alike: one such cookie would fail every
// tier, so it is dropped.
const UNSAFE_COOKIE_CHARS = /[\x00-\x1f\x7f;]/;
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_COOKIES = 100;
// RFC 9110 field names are tokens; values carry no control character but tab.
const HEADER_NAME = COOKIE_NAME;
const UNSAFE_HEADER_VALUE = /[\x00-\x08\x0a-\x1f\x7f]/;

/**
 * Custom headers a tier can send: names that are tokens, values without
 * control characters. Anything else would make every tier throw (or a
 * browser request hang), so it is dropped rather than sent.
 */
export function sendableHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || !HEADER_NAME.test(name) || UNSAFE_HEADER_VALUE.test(value)) continue;
    out[name] = value;
  }
  return out;
}

function domainOf(cookie: CookieInput): string | undefined {
  const d = cookie.domain?.trim().toLowerCase().replace(/^\./, '');
  return d ? d : undefined;
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  const prefix = cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`;
  return requestPath.startsWith(prefix);
}

/**
 * The request's cookies `url` receives: the cookie's domain is the host or
 * a parent of it (no domain: the host only), its path a prefix of the
 * URL's path (RFC 6265 domain and path matching). Malformed cookies are
 * dropped.
 */
export function cookiesFor(url: URL, cookies: readonly CookieInput[] | undefined): CookieInput[] {
  if (!cookies || cookies.length === 0) return [];
  const host = url.hostname.toLowerCase();
  const out: CookieInput[] = [];
  for (const c of cookies.slice(0, MAX_COOKIES)) {
    if (typeof c?.name !== 'string' || typeof c.value !== 'string') continue;
    if (!COOKIE_NAME.test(c.name) || UNSAFE_COOKIE_CHARS.test(c.value)) continue;
    const domain = domainOf(c);
    if (domain !== undefined && host !== domain && !host.endsWith(`.${domain}`)) continue;
    if (!pathMatches(url.pathname || '/', c.path?.trim() || '/')) continue;
    out.push(c);
  }
  return out;
}

/** "a=1; b=2" for the cookies `url` receives, or undefined. */
export function cookieHeader(url: URL, cookies: readonly CookieInput[] | undefined): string | undefined {
  const matching = cookiesFor(url, cookies);
  return matching.length > 0 ? matching.map((c) => `${c.name}=${c.value}`).join('; ') : undefined;
}

/** The custom headers plus the request's cookies (appended to a custom Cookie header, if any). */
export function headersWithCookies(
  url: string,
  given: Readonly<Record<string, string>> | undefined,
  cookies: readonly CookieInput[] | undefined,
): Record<string, string> | undefined {
  const headers = sendableHeaders(given);
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return headers ? { ...headers } : undefined;
  }
  const fromCookies = cookieHeader(target, cookies);
  if (!fromCookies) return headers ? { ...headers } : undefined;
  const out: Record<string, string> = {};
  let existing: string | undefined;
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === 'cookie') existing = value;
    else out[name] = value;
  }
  out.Cookie = existing ? `${existing}; ${fromCookies}` : fromCookies;
  return out;
}

export interface BrowserCookie {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
}

/**
 * The request's cookies `url` receives, in Playwright's addCookies form: a
 * host-only cookie is bound to the URL's host (a domain without a leading
 * dot is host-only) and its own path; one with a domain to that domain (and
 * its subdomains) and its path. The url form is not used: Playwright takes
 * its path from the URL's directory, so "/account" would become "/".
 */
export function browserCookies(url: URL, cookies: readonly CookieInput[] | undefined): BrowserCookie[] {
  return cookiesFor(url, cookies).map((c) => {
    const domain = domainOf(c);
    const path = c.path?.trim() || '/';
    return { name: c.name, value: c.value, domain: domain === undefined ? url.hostname : `.${domain}`, path };
  });
}

/** Custom headers worth adding in a browser: a Cookie header is applied as cookies instead. */
export function browserHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  const sendable = sendableHeaders(headers);
  if (!sendable) return undefined;
  const out = Object.fromEntries(Object.entries(sendable).filter(([name]) => name.toLowerCase() !== 'cookie' && name.toLowerCase() !== 'host'));
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Adds the cookies to a browser context; if the batch is refused (a value
 * the browser will not take), one at a time, skipping the ones refused.
 */
export async function addBrowserCookies(
  context: { addCookies(cookies: BrowserCookie[]): Promise<void> },
  cookies: BrowserCookie[],
): Promise<void> {
  if (cookies.length === 0) return;
  try {
    await context.addCookies(cookies);
  } catch {
    for (const cookie of cookies) await context.addCookies([cookie]).catch(() => undefined);
  }
}

/** Cookies written in a custom Cookie header ("a=1; b=2"), as host-only cookies. */
export function cookiesFromHeader(headers: Readonly<Record<string, string>> | undefined): CookieInput[] {
  const raw = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'cookie')?.[1];
  if (!raw) return [];
  const out: CookieInput[] = [];
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out.push({ name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() });
  }
  return out;
}

/** What a browser tier applies: the request's cookies (and a custom Cookie header's), and its other headers. */
export function browserCredentials(
  url: URL,
  headers: Readonly<Record<string, string>> | undefined,
  cookies: readonly CookieInput[] | undefined,
): { cookies: BrowserCookie[]; headers?: Record<string, string> } {
  const all = [...cookiesFromHeader(headers), ...(cookies ?? [])];
  const extra = browserHeaders(headers);
  return { cookies: browserCookies(url, all), ...(extra ? { headers: extra } : {}) };
}

/** Whether a request has cookies or custom headers a tier must send. */
export function carriesCredentials(options: { headers?: Readonly<Record<string, string>>; cookies?: readonly CookieInput[] }): boolean {
  return (options.cookies?.length ?? 0) > 0 || Object.keys(options.headers ?? {}).length > 0;
}
