// Outbound request isolation (SSRF protection).
//
// Every request the engine makes on a customer's behalf (HTTP tiers, each
// redirect hop, browser sub-requests, webhooks) is checked here first: the
// scheme must be http(s), the hostname must not be a local/internal name, and
// every address the name resolves to must be public. A request is refused if
// ANY resolved address is private, because the client that actually connects
// may pick a different address than the one we looked at.
//
// The checks above run before a request; a hostile DNS server can answer
// differently when the client connects (DNS rebinding). The policy is
// therefore also enforced at connect time, where the address checked is the
// address connected to: `guardedLookup` for clients built on node:net
// (webhooks), and `resolveForConnect` in the worker's local egress proxy,
// which Impit and Chromium connect through (apps/worker/src/net/).

import { promises as dnsPromises, type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';

// ─────────────────────────────────────────────────────────────
// Address classification
// ─────────────────────────────────────────────────────────────

/** Special-purpose IPv4 ranges that must never be contacted. */
const BLOCKED_V4_CIDRS = [
  '0.0.0.0/8', // "this network"; 0.0.0.0 reaches the local host on Linux
  '10.0.0.0/8', // private
  '100.64.0.0/10', // carrier-grade NAT (shared address space)
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local, incl. cloud metadata 169.254.169.254
  '172.16.0.0/12', // private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1
  '192.88.99.0/24', // 6to4 relay anycast (deprecated)
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, incl. limited broadcast 255.255.255.255
];

/**
 * Special-purpose IPv6 ranges blocked outright. Ranges that embed an IPv4
 * address (mapped, compatible, NAT64, 6to4) are not listed here: they are
 * judged by the embedded IPv4 address instead (see embeddedIPv4).
 */
const BLOCKED_V6_CIDRS = [
  '::/128', // unspecified
  '::1/128', // loopback
  '100::/64', // discard-only
  '2001::/32', // Teredo: tunnels to an arbitrary (possibly private) IPv4 peer
  '2001:db8::/32', // documentation
  '3fff::/20', // documentation (RFC 9637)
  '64:ff9b:1::/48', // local-use NAT64 (RFC 8215): translation target is site-defined
  'fc00::/7', // unique local
  'fe80::/10', // link-local
  'fec0::/10', // site-local (deprecated, still routed by some stacks)
  'ff00::/8', // multicast
];

type V4Range = readonly [network: number, mask: number];
type V6Range = readonly [groups: readonly number[], prefix: number];

const BLOCKED_V4: readonly V4Range[] = BLOCKED_V4_CIDRS.map((cidr) => {
  const [ip, prefix] = cidr.split('/');
  const mask = prefixMask(Number(prefix));
  return [(parseIPv4Strict(ip)! & mask) >>> 0, mask] as const;
});

const BLOCKED_V6: readonly V6Range[] = BLOCKED_V6_CIDRS.map((cidr) => {
  const [ip, prefix] = cidr.split('/');
  return [parseIPv6(ip)!, Number(prefix)] as const;
});

function prefixMask(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/** Canonical dotted quad → uint32, or null. */
function parseIPv4Strict(s: string): number | null {
  if (isIP(s) !== 4) return null;
  return s.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

/**
 * IPv4 in any form inet_aton / the WHATWG URL parser accept: 1–4 parts, each
 * decimal, 0x-hex or 0-prefixed octal, the last part filling the remaining
 * bytes ("0x7f.1", "2130706433", "017700000001", "127.1" are all 127.0.0.1).
 */
function parseIPv4Loose(s: string): number | null {
  const parts = s.split('.');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    const n = parseIPv4Part(part);
    if (n === null) return null;
    nums.push(n);
  }
  const last = nums.pop()!;
  if (nums.some((n) => n > 255)) return null;
  if (last >= 256 ** (4 - nums.length)) return null;
  return nums.reduce((acc, n, i) => acc + n * 256 ** (3 - i), last);
}

function parseIPv4Part(part: string): number | null {
  let radix = 10;
  let digits = part;
  if (/^0x/i.test(part)) {
    radix = 16;
    digits = part.slice(2);
  } else if (part.length > 1 && part.startsWith('0')) {
    radix = 8;
    digits = part.slice(1);
  }
  if (digits === '') return part === '' ? null : 0;
  const valid = radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!valid.test(digits)) return null;
  // Very long inputs overflow to large floats; the caller's range checks reject them.
  return parseInt(digits, radix);
}

/**
 * IPv6 text → eight 16-bit groups, or null. Accepts brackets ("[::1]"), zone
 * ids ("fe80::1%eth0", stripped), "::" compression and a trailing dotted quad
 * ("::ffff:127.0.0.1").
 */
function parseIPv6(raw: string): number[] | null {
  let s = raw;
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (isIP(s) !== 6) return null;

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = parseIPv6Groups(halves[0]);
  const tail = halves.length === 2 ? parseIPv6Groups(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function parseIPv6Groups(part: string): number[] | null {
  if (part === '') return [];
  const pieces = part.split(':');
  const groups: number[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece.includes('.')) {
      if (i !== pieces.length - 1) return null;
      const v4 = parseIPv4Strict(piece);
      if (v4 === null) return null;
      groups.push(Math.floor(v4 / 65536), v4 % 65536);
    } else {
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
  }
  return groups;
}

function isBlockedV4(ip: number): boolean {
  return BLOCKED_V4.some(([network, mask]) => ((ip & mask) >>> 0) === network);
}

function inV6Range(groups: readonly number[], [network, prefix]: V6Range): boolean {
  let remaining = prefix;
  for (let i = 0; i < 8 && remaining > 0; i++, remaining -= 16) {
    const bits = Math.min(16, remaining);
    const mask = (0xffff << (16 - bits)) & 0xffff;
    if ((groups[i] & mask) !== (network[i] & mask)) return false;
  }
  return true;
}

/** The IPv4 address an IPv6 address carries and would be routed to, if any. */
function embeddedIPv4(g: readonly number[]): number | null {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const low32 = g[6] * 65536 + g[7];
  if (zero(0, 5) && g[5] === 0xffff) return low32; // ::ffff:a.b.c.d (mapped)
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return low32; // ::ffff:0:a.b.c.d (SIIT)
  if (zero(0, 6)) return low32; // ::a.b.c.d (compatible, deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return low32; // 64:ff9b::/96 (NAT64)
  if (g[0] === 0x2002) return g[1] * 65536 + g[2]; // 2002::/16 (6to4)
  return null;
}

function isBlockedV6(groups: readonly number[]): boolean {
  if (BLOCKED_V6.some((range) => inV6Range(groups, range))) return true;
  const v4 = embeddedIPv4(groups);
  return v4 !== null && isBlockedV4(v4);
}

/**
 * True when `ip` is in a private, loopback, link-local, multicast,
 * documentation or otherwise reserved range (IPv4 or IPv6, including IPv6
 * forms that embed an IPv4 address). Brackets and zone ids are ignored and
 * legacy IPv4 spellings ("0x7f.1", "2130706433") are understood.
 *
 * Fails closed: anything that is not an IP address is reported as blocked.
 */
export function isBlockedAddress(ip: string): boolean {
  const s = ip.trim();
  if (s.includes(':')) {
    const groups = parseIPv6(s);
    return groups === null ? true : isBlockedV6(groups);
  }
  const v4 = parseIPv4Loose(s);
  return v4 === null ? true : isBlockedV4(v4);
}

// ─────────────────────────────────────────────────────────────
// Hostname rules (no DNS)
// ─────────────────────────────────────────────────────────────

// Names that only ever resolve inside a host or a private network.
const INTERNAL_SUFFIXES = ['localhost', 'local', 'internal', 'localdomain', 'home.arpa'];

/**
 * True for names that must never be fetched, whatever DNS says: localhost
 * and its subdomains, internal-only suffixes (.local, .internal, ...), and
 * single-label names, which only resolve through resolver search domains
 * (e.g. "redis" → redis.default.svc.cluster.local). IP literals are not
 * judged here; use isBlockedAddress.
 */
export function isBlockedHostname(hostname: string): boolean {
  const name = bareHostname(hostname).toLowerCase();
  if (name === '' || !name.includes('.')) return true;
  return INTERNAL_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

/**
 * URL hostname without IPv6 brackets or trailing dots. A manual scan rather
 * than /\.+$/, which backtracks quadratically on long runs of dots (a
 * 200k-dot hostname took ~37 s) and hostnames come from customer input.
 */
function bareHostname(hostname: string): string {
  let start = 0;
  let end = hostname.length;
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    start = 1;
    end -= 1;
  }
  while (end > start && hostname.charCodeAt(end - 1) === 0x2e /* "." */) end--;
  return hostname.slice(start, end);
}

function displayHost(hostname: string): string {
  return hostname.length > 100 ? `${hostname.slice(0, 100)}…` : hostname;
}

// ─────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────

export type OutboundBlockReason = 'invalid-url' | 'scheme' | 'hostname' | 'address' | 'unverified';

/**
 * A request was refused because it would reach a private or reserved
 * destination. The message never contains the resolved address (that would
 * let a customer map internal DNS); `address` keeps it for internal logs.
 */
export class OutboundBlockedError extends Error {
  readonly code = 'OUTBOUND_BLOCKED' as const;

  constructor(
    readonly reason: OutboundBlockReason,
    readonly hostname: string,
    detail: string,
    readonly address?: string,
  ) {
    super(`Blocked by SSRF guard: ${detail}`);
    this.name = 'OutboundBlockedError';
  }
}

/** The hostname could not be resolved. Not a security block: report it as a lookup failure. */
export class DnsLookupError extends Error {
  readonly code = 'DNS_LOOKUP_FAILED' as const;

  constructor(
    readonly hostname: string,
    /** Resolver error code such as ENOTFOUND or EAI_AGAIN, when known. */
    readonly lookupCode?: string,
    options?: { cause?: unknown },
  ) {
    super(`DNS lookup failed for ${displayHost(hostname)}${lookupCode ? ` (${lookupCode})` : ''}`, options);
    this.name = 'DnsLookupError';
  }
}

export class TooManyRedirectsError extends Error {
  readonly code = 'TOO_MANY_REDIRECTS' as const;

  constructor(readonly maxRedirects: number) {
    super(`Too many redirects (more than ${maxRedirects})`);
    this.name = 'TooManyRedirectsError';
  }
}

// `code` checks keep these working when two copies of this module are loaded
// (e.g. compiled dist next to source in tests), where instanceof would fail.
export function isOutboundBlockedError(err: unknown): err is OutboundBlockedError {
  return err instanceof OutboundBlockedError || errorCode(err) === 'OUTBOUND_BLOCKED';
}

export function isDnsLookupError(err: unknown): err is DnsLookupError {
  return err instanceof DnsLookupError || errorCode(err) === 'DNS_LOOKUP_FAILED';
}

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

// ─────────────────────────────────────────────────────────────
// Policy, DNS and cache
// ─────────────────────────────────────────────────────────────

export interface OutboundPolicy {
  /** Every address the system resolver returns for `hostname`. */
  lookup: (hostname: string) => Promise<string[]>;
  /** True when an address must never be contacted. */
  isBlocked: (address: string) => boolean;
}

const DNS_TIMEOUT_MS = 5_000;
// RFC 1035: longer names cannot exist, so they are not worth a lookup.
const MAX_DNS_NAME_LENGTH = 253;
const HOST_CACHE_TTL_MS = 30_000;
const HOST_CACHE_MAX = 5_000;

async function systemLookup(hostname: string): Promise<string[]> {
  const answers = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
}

const defaultPolicy: OutboundPolicy = { lookup: systemLookup, isBlocked: isBlockedAddress };
let policy: OutboundPolicy = defaultPolicy;

interface HostVerdict {
  /** First blocked address among the answers; undefined when all are public. */
  blockedAddress?: string;
}

// Per-hostname verdicts, in LRU order (Map iteration order = insertion order).
// Blocked verdicts are cached too: refusing a host for 30 s after it pointed
// somewhere private is always safe, and it stops repeat attempts from costing
// a DNS lookup each. DNS failures are not cached (they are often transient).
const hostCache = new Map<string, { verdict: HostVerdict; expiresAt: number }>();
// Concurrent checks of the same host (a page loading 40 assets from one CDN)
// share one lookup.
const inflight = new Map<string, Promise<HostVerdict>>();
let cacheGeneration = 0;

/** Drop every cached host verdict. */
export function clearOutboundCache(): void {
  hostCache.clear();
  inflight.clear();
  cacheGeneration++;
}

/**
 * Replace the DNS lookup and/or address predicate for tests (e.g. to treat a
 * local fixture server on 127.0.0.1 as public while 127.0.0.2 stays private).
 * Pass null to restore the strict defaults. Refuses to run in production.
 */
export function setOutboundPolicyForTests(overrides: Partial<OutboundPolicy> | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('setOutboundPolicyForTests is not available in production');
  }
  policy = overrides ? { ...defaultPolicy, ...overrides } : defaultPolicy;
  clearOutboundCache();
}

/**
 * Private destinations are allowed only in development/tests that opt in
 * (local fixture servers), never in production.
 */
export function allowPrivateNetwork(): boolean {
  return (
    process.env.SCRAPEFORGE_ALLOW_PRIVATE_NETWORK === '1' && process.env.NODE_ENV !== 'production'
  );
}

async function lookupWithTimeout(
  lookup: OutboundPolicy['lookup'],
  hostname: string,
): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DnsLookupError(hostname, 'ETIMEOUT')), DNS_TIMEOUT_MS);
  });
  try {
    const addresses = await Promise.race([lookup(hostname), timeout]);
    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw new DnsLookupError(hostname, 'ENODATA');
    }
    return addresses;
  } catch (err) {
    if (isDnsLookupError(err)) throw err;
    const code = errorCode(err);
    const lookupCode = typeof code === 'string' && /^[A-Z_]{1,32}$/.test(code) ? code : undefined;
    throw new DnsLookupError(hostname, lookupCode, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

function classify(addresses: string[]): HostVerdict {
  const blockedAddress = addresses.find((a) => policy.isBlocked(a));
  return blockedAddress === undefined ? {} : { blockedAddress };
}

function cacheGet(hostname: string): HostVerdict | undefined {
  const entry = hostCache.get(hostname);
  if (!entry) return undefined;
  hostCache.delete(hostname);
  if (entry.expiresAt <= Date.now()) return undefined;
  hostCache.set(hostname, entry);
  return entry.verdict;
}

function cacheSet(hostname: string, verdict: HostVerdict): void {
  hostCache.delete(hostname);
  hostCache.set(hostname, { verdict, expiresAt: Date.now() + HOST_CACHE_TTL_MS });
  if (hostCache.size > HOST_CACHE_MAX) {
    hostCache.delete(hostCache.keys().next().value!);
  }
}

async function resolveHost(
  hostname: string,
  customLookup?: OutboundPolicy['lookup'],
): Promise<HostVerdict> {
  // A per-call lookup must not populate the shared cache with its answers.
  if (customLookup) return classify(await lookupWithTimeout(customLookup, hostname));

  const cached = cacheGet(hostname);
  if (cached) return cached;
  const pending = inflight.get(hostname);
  if (pending) return pending;

  const generation = cacheGeneration;
  const lookup = lookupWithTimeout(policy.lookup, hostname).then((addresses) => {
    const verdict = classify(addresses);
    if (generation === cacheGeneration) cacheSet(hostname, verdict);
    return verdict;
  });
  inflight.set(hostname, lookup);
  const settle = () => {
    if (inflight.get(hostname) === lookup) inflight.delete(hostname);
  };
  lookup.then(settle, settle);
  return lookup;
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort!);
  }
}

// ─────────────────────────────────────────────────────────────
// URL checks
// ─────────────────────────────────────────────────────────────

export interface AssertPublicUrlOptions {
  /** Resolver override for this call only (results are not cached). */
  lookup?: (hostname: string) => Promise<string[]>;
  /** Skip the address checks (scheme is still enforced). Defaults to allowPrivateNetwork(). */
  allowPrivate?: boolean;
  /** Abandon the DNS wait when this fires. */
  signal?: AbortSignal;
}

/**
 * Resolve once and confirm `input` may be fetched: http(s) only, not an
 * internal hostname, and every resolved address public. Returns the parsed
 * URL; callers should fetch `result.href` so the checked and fetched URLs
 * cannot be parsed differently.
 *
 * Throws OutboundBlockedError when the destination is refused and
 * DnsLookupError when the name cannot be resolved.
 */
export async function assertPublicUrl(
  input: string | URL,
  opts: AssertPublicUrlOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(typeof input === 'string' ? input : input.href);
  } catch {
    throw new OutboundBlockedError('invalid-url', '', 'invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundBlockedError(
      'scheme',
      url.hostname,
      `scheme "${url.protocol.slice(0, 20)}" is not allowed`,
    );
  }
  if (opts.allowPrivate ?? allowPrivateNetwork()) return url;

  const host = bareHostname(url.hostname);
  const shown = displayHost(host);
  if (isIP(host)) {
    if (policy.isBlocked(host)) {
      throw new OutboundBlockedError('address', host, `${shown} is a private or reserved address`, host);
    }
    return url;
  }
  if (isBlockedHostname(host)) {
    throw new OutboundBlockedError('hostname', host, `${shown} is a private or reserved hostname`);
  }
  // url.hostname (not the trimmed name) is what gets resolved: a trailing dot
  // makes it fully qualified, exactly as the fetching client will see it.
  if (url.hostname.length > MAX_DNS_NAME_LENGTH + 1) throw new DnsLookupError(host, 'ENOTFOUND');

  const verdict = await withAbort(resolveHost(url.hostname, opts.lookup), opts.signal);
  if (verdict.blockedAddress !== undefined) {
    throw new OutboundBlockedError(
      'address',
      host,
      `${shown} resolves to a private or reserved address`,
      verdict.blockedAddress,
    );
  }
  return url;
}

export type PublicUrlCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: 'blocked'; error: OutboundBlockedError }
  | { ok: false; reason: 'dns'; error: DnsLookupError };

/** assertPublicUrl as a result value, for request validation. */
export async function checkPublicUrl(
  input: string | URL,
  opts?: AssertPublicUrlOptions,
): Promise<PublicUrlCheck> {
  try {
    return { ok: true, url: await assertPublicUrl(input, opts) };
  } catch (err) {
    if (isOutboundBlockedError(err)) return { ok: false, reason: 'blocked', error: err };
    if (isDnsLookupError(err)) return { ok: false, reason: 'dns', error: err };
    throw err;
  }
}

/**
 * node:net `lookup` replacement that refuses to connect when any answer is a
 * blocked address. Unlike assertPublicUrl it always resolves afresh (no
 * cache), so the address checked is the address connected to: pass it as
 * `lookup` to http(s).request / net.connect to close the DNS-rebinding gap.
 * IP-literal hosts never reach a lookup function; check them with
 * assertPublicUrl first.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  const allowPrivate = allowPrivateNetwork();
  const family =
    options.family === 4 || options.family === 'IPv4'
      ? 4
      : options.family === 6 || options.family === 'IPv6'
        ? 6
        : 0;

  lookupWithTimeout(policy.lookup, hostname)
    .then((addresses) => connectableAddresses(hostname, addresses, family, allowPrivate))
    .then(
      (usable) => {
        if (options.all) {
          callback(null, usable.map((address): LookupAddress => ({ address, family: isIP(address) })));
        } else {
          callback(null, usable[0], isIP(usable[0]));
        }
      },
      (err: unknown) => {
        const known = isDnsLookupError(err) || isOutboundBlockedError(err);
        callback(known ? err : new DnsLookupError(hostname, undefined, { cause: err }), '');
      },
    );
};

export interface ResolveForConnectOptions {
  /** Skip the address and hostname checks (the name is still resolved). Defaults to allowPrivateNetwork(). */
  allowPrivate?: boolean;
  /** Abandon the DNS wait when this fires. */
  signal?: AbortSignal;
}

/**
 * The addresses to connect to for `host` (a hostname or IP literal, with or
 * without IPv6 brackets), checked against the outbound policy. Always
 * resolves afresh (no cache): connect to exactly these addresses and never
 * resolve the name again, so the address checked is the address connected
 * to. Applies the same hostname rules as assertPublicUrl and honours
 * allowPrivateNetwork() / setOutboundPolicyForTests.
 *
 * Throws OutboundBlockedError when the destination is refused and
 * DnsLookupError when the name cannot be resolved.
 */
export async function resolveForConnect(
  host: string,
  opts: ResolveForConnectOptions = {},
): Promise<string[]> {
  const allowPrivate = opts.allowPrivate ?? allowPrivateNetwork();
  const name = bareHostname(host);
  const shown = displayHost(name);
  // Legacy IPv4 spellings ("127.1", "0x7f.1") are addresses, not names: the
  // system resolver would turn them into 127.0.0.1 without asking DNS.
  const v4 = name.includes(':') ? null : parseIPv4Loose(name);
  const literal =
    isIP(name) !== 0 ? name : v4 !== null ? [24, 16, 8, 0].map((s) => (v4 >>> s) & 255).join('.') : null;
  if (literal !== null) {
    if (!allowPrivate && policy.isBlocked(literal)) {
      throw new OutboundBlockedError('address', name, `${shown} is a private or reserved address`, literal);
    }
    return [literal];
  }
  if (!allowPrivate && isBlockedHostname(name)) {
    throw new OutboundBlockedError('hostname', name, `${shown} is a private or reserved hostname`);
  }
  if (name.length > MAX_DNS_NAME_LENGTH) throw new DnsLookupError(name, 'ENOTFOUND');
  // `host` keeps a trailing dot (fully qualified), as the client would resolve it.
  const addresses = await withAbort(lookupWithTimeout(policy.lookup, host), opts.signal);
  return connectableAddresses(host, addresses, 0, allowPrivate);
}

function connectableAddresses(
  hostname: string,
  addresses: string[],
  family: 0 | 4 | 6,
  allowPrivate: boolean,
): string[] {
  const blocked = allowPrivate ? undefined : addresses.find((a) => policy.isBlocked(a));
  if (blocked !== undefined) {
    const host = displayHost(bareHostname(hostname));
    throw new OutboundBlockedError(
      'address',
      host,
      `${host} resolves to a private or reserved address`,
      blocked,
    );
  }
  const usable = addresses.filter((a) => isIP(a) !== 0 && (family === 0 || isIP(a) === family));
  if (usable.length === 0) throw new DnsLookupError(hostname, 'ENOTFOUND');
  return usable;
}

// ─────────────────────────────────────────────────────────────
// Redirects
// ─────────────────────────────────────────────────────────────

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const DEFAULT_MAX_REDIRECTS = 10;

export interface RedirectHop {
  /** Checked URL to request on this hop. */
  url: URL;
  /** 0 for the initial request. */
  hop: number;
  /** False once any hop has left the initial origin (stays false). */
  sameOrigin: boolean;
}

export interface RedirectableResponse {
  status: number;
  headers: { get(name: string): string | null };
}

export interface SafeRedirectOptions<R> {
  /** Redirects to follow before failing with TooManyRedirectsError (default 10). */
  maxRedirects?: number;
  /** Release a redirect response's body before following it. */
  discard?: (response: R) => unknown;
  signal?: AbortSignal;
}

/**
 * Follow redirects by hand so every hop, including the first, passes
 * assertPublicUrl before any connection is made. `fetchHop` must not follow
 * redirects itself. Relative Locations resolve against the current URL; a
 * redirect without a usable Location is returned as the final response.
 * All engine fetches are GET, so 301/302/303 method rewriting does not arise.
 */
export async function fetchWithSafeRedirects<R extends RedirectableResponse>(
  url: string | URL,
  fetchHop: (hop: RedirectHop) => Promise<R>,
  opts: SafeRedirectOptions<R> = {},
): Promise<{ response: R; url: URL; redirects: number }> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = await assertPublicUrl(url, { signal: opts.signal });
  const initialOrigin = current.origin;
  let sameOrigin = true;

  for (let hop = 0; ; hop++) {
    const response = await fetchHop({ url: current, hop, sameOrigin });
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
    if (location === null) return { response, url: current, redirects: hop };

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return { response, url: current, redirects: hop };
    }
    try {
      await opts.discard?.(response);
    } catch {
      // Best effort: failing to release a body must not change the outcome.
    }
    if (hop >= maxRedirects) throw new TooManyRedirectsError(maxRedirects);
    current = await assertPublicUrl(next, { signal: opts.signal });
    if (current.origin !== initialOrigin) sameOrigin = false;
  }
}

// Credentials a customer attached for the target site must not leak to
// another origin a redirect points at (mirrors the fetch spec and reqwest).
const CROSS_ORIGIN_STRIPPED_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

/** Request headers for a redirect hop: credentials dropped once the chain left the initial origin. */
export function headersForHop(
  headers: Record<string, string>,
  hop: Pick<RedirectHop, 'sameOrigin'>,
): Record<string, string> {
  if (hop.sameOrigin) return headers;
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !CROSS_ORIGIN_STRIPPED_HEADERS.has(name.toLowerCase())),
  );
}
