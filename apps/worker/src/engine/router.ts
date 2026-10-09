import { Redis } from 'ioredis';
import type { BrowserContext } from 'patchright';
import { isDnsLookupError, isOutboundBlockedError, type ScrapeOptions } from '@scrapeforge/shared';
import { tier1Fetch, isValidContent } from './tier1-http.js';
import { tier2Fetch } from './tier2-tls.js';
import { tier3Fetch, isLightpandaConfigured } from './tier3-light.js';
import { tier4Fetch } from './tier4-browser.js';
import { tier4StealthFetch } from './tier4-stealth.js';
import { ProxyManager, type SelectedProxy } from '../proxy/manager.js';
import { calculateQualityScore } from '../extraction/quality-scorer.js';
import type { AttemptOutcome, StageTracer } from '../tracing.js';

// Minimum quality score below which a tier's response is treated as a
// soft-block and escalation continues. Target.com, Bing SERPs, and the
// first run of Amazon all ship a cloaked 200-OK page that slips past
// `isValidContent` (no block keywords, normal size) but scores < 0.55
// because the visible text is thin and there's no semantic content.
// Small, well-formed pages without block markers (example.com) score 0.9
// thanks to the short-page rule in quality-scorer.
export const MIN_TIER_ACCEPT_QUALITY = 0.55;

// On the TERMINAL tier (T5 stealth) we're out of escalation targets, so
// we accept whatever we get even if low-quality — returning *something*
// with a low quality score is more useful than throwing "All tiers
// exhausted" and wasting the browser context cost entirely.
const TERMINAL_TIER_ACCEPT_QUALITY = 0;

export interface RouterResult {
  html: string;
  statusCode: number;
  tierUsed: number;
  proxyTier: string;
  proxyCost: number;
  screenshot?: string;
  latencyMs: number;
}

// Domains known to require JavaScript rendering. Sending them through T1/T2
// just wastes 30s before we end up in the browser anyway. This list is a
// cold-start hint; the adaptive domain cache takes over after a few samples.
const JS_HEAVY_DOMAINS = new Set<string>([
  'msn.com',
  'www.msn.com',
  'bing.com',
  'www.bing.com',
  'amazon.com',
  'www.amazon.com',
  'reuters.com',
  'www.reuters.com',
  'medium.com',
  'www.medium.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'www.instagram.com',
  'linkedin.com',
  'www.linkedin.com',
  'facebook.com',
  'www.facebook.com',
  'tiktok.com',
  'www.tiktok.com',
]);

// Domains where we know T1/T2/T3 cannot succeed — either Cloudflare Enterprise,
// DataDome, or aggressive Akamai serving cloaked 200-OK block pages at the HTTP
// tier. Skip straight to T4 so we don't burn 30s of escalation on tiers that
// only produce false positives. Kept deliberately short and evidence-based —
// a domain earns a spot only after the harness shows it fails at T1/T2 AND
// succeeds at T4. Nike/Target were tried and REMOVED because they were already
// passing cleanly at T1/T2.
const HARD_DOMAINS = new Set<string>([
  'nowsecure.nl',
  'walmart.com',
  'www.walmart.com',
  'google.com',
  'www.google.com',
]);

function isJsHeavyDomain(domain: string): boolean {
  if (JS_HEAVY_DOMAINS.has(domain)) return true;
  // Also match subdomains of the listed roots (e.g., m.amazon.com, en.wikipedia.org).
  for (const d of JS_HEAVY_DOMAINS) {
    if (domain.endsWith('.' + d)) return true;
  }
  return false;
}

function isHardDomain(domain: string): boolean {
  if (HARD_DOMAINS.has(domain)) return true;
  for (const d of HARD_DOMAINS) {
    if (domain.endsWith('.' + d)) return true;
  }
  return false;
}

/**
 * Single decision gate used by every tier in the router. Returns either
 * `{ ok: true, score }` if we should accept the tier's response, or
 * `{ ok: false, reason }` if the router should continue escalating.
 *
 * Layered checks:
 *   1. `isValidContent` — fast keyword/structural block detection
 *   2. `calculateQualityScore` — catches cloaked 200-OK pages that slip
 *      past step 1 (empty body wrapped in nav/footer markup, app shells)
 *
 * On the terminal tier (T5 stealth) the quality threshold is 0 because
 * there's nowhere left to escalate to; best-effort is better than
 * "all tiers exhausted".
 */
export function assessTier(
  html: string,
  statusCode: number,
  tier: number,
  latencyMs: number,
  url: string,
  terminal = false,
): { ok: true; score: number } | { ok: false; score: number; reason: string } {
  const g = judgeResponse(html, statusCode, tier, latencyMs, url);
  const threshold = terminal ? TERMINAL_TIER_ACCEPT_QUALITY : MIN_TIER_ACCEPT_QUALITY;
  if (!g.valid || g.score < threshold) return { ok: false, score: g.score, reason: g.reason };
  return { ok: true, score: g.score };
}

/** The gate's two checks; `reason` says why the response misses the normal bar. */
function judgeResponse(
  html: string,
  statusCode: number,
  tier: number,
  latencyMs: number,
  url: string,
): { valid: boolean; score: number; reason: string } {
  if (!isValidContent(html, statusCode, url)) {
    return { valid: false, score: 0, reason: `invalid content (status=${statusCode} htmlLen=${html.length})` };
  }
  const { score, signals } = calculateQualityScore(html, statusCode, tier, latencyMs);
  return { valid: true, score, reason: `low quality ${score.toFixed(2)} (${signals[0] || 'no signal'})` };
}

// ─────────────────────────────────────────────────────────────
// Error text
// ─────────────────────────────────────────────────────────────

// Escalation notes end up in the "All tiers exhausted" error, which API
// clients see. Fetch-layer messages can carry proxy URLs with credentials.
const MAX_REASON_CHARS = 120;
const MAX_RAW_MESSAGE_CHARS = 2_000;
const MAX_EXHAUSTED_DETAIL_CHARS = 600;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#@]+@/gi;

/** Strings identifying `proxyUrl` that must not appear in client-visible text. */
function proxySecrets(proxyUrl: string | undefined): string[] {
  if (!proxyUrl) return [];
  const out = new Set<string>([proxyUrl, proxyUrl.replace(/\/+$/, '')]);
  try {
    const u = new URL(proxyUrl);
    if (u.host) out.add(u.host);
    if (u.hostname.length >= 4) out.add(u.hostname);
    for (const part of [u.username, u.password]) {
      if (part.length >= 4) {
        out.add(part);
        try {
          out.add(decodeURIComponent(part));
        } catch {
          /* not percent-encoded */
        }
      }
    }
  } catch {
    /* unparseable proxy URL: only the literal is redacted */
  }
  // Longest first, so a full URL is replaced before its host is.
  return [...out].filter(Boolean).sort((a, b) => b.length - a.length);
}

/** Bounded, single-line, credential-free text for an error or rejection. */
export function redactReason(text: string, proxyUrl?: string): string {
  let out = text.slice(0, MAX_RAW_MESSAGE_CHARS);
  // The token cut by that slice may start a credential ("http://user:pa")
  // that the patterns below no longer recognise without its "@".
  if (text.length > MAX_RAW_MESSAGE_CHARS) out = out.replace(/\S*$/, '…');
  for (const secret of proxySecrets(proxyUrl)) out = out.split(secret).join('[proxy]');
  out = out.replace(URL_USERINFO, '$1***@').replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  return out.slice(0, MAX_REASON_CHARS);
}

// Tier fetchers throw whatever their libraries throw. Read the message
// defensively: a thrown string or null must not crash the escalation loop
// that is meant to absorb tier failures.
function describeError(err: unknown, proxyUrl?: string): string {
  const message = (err as { message?: unknown } | null)?.message;
  if (typeof message === 'string') return redactReason(message, proxyUrl);
  try {
    return redactReason(String(err), proxyUrl);
  } catch {
    return 'unprintable error';
  }
}

/**
 * Errors that no other tier can fix: the destination (or a redirect hop) is
 * refused by the SSRF guard, or the hostname does not resolve. Every tier
 * runs the same checks, so retrying in a browser only re-loads a URL that
 * points inside our network or wastes seconds on a name that does not exist.
 */
function isFatalFetchError(err: unknown): boolean {
  return isOutboundBlockedError(err) || isDnsLookupError(err);
}

/**
 * The browser pool could not hand out a context in time (saturated queue,
 * acquire timeout, shutdown): browser/pool.ts BrowserPoolError, matched by
 * its code so another module copy's error counts too.
 */
function isPoolUnavailable(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'BROWSER_POOL_UNAVAILABLE';
}

// ─────────────────────────────────────────────────────────────
// Domain strategy: per-tier success statistics
// ─────────────────────────────────────────────────────────────
//
// Stored under `domain:{host}` (24 h TTL, refreshed on write). Each tier
// keeps an exponentially decayed success count: every new outcome multiplies
// the old counts by SAMPLE_DECAY (so roughly the last 10 outcomes matter) and
// idle time halves them every HALF_LIFE_MS, so that after a quiet spell new
// outcomes outweigh old ones. Idle decay stops at the evidence a verdict
// needs, so a domain requested every few hours still learns; evidence older
// than the key's TTL counts as none. A request starts at the cheapest
// tier with a recent success rate ≥ GOOD_RATE over ≥ ~3 recent samples, so
// a domain that always ends at T5 stops paying for T1, T2 and T4 after three
// requests. One request in 20 starts at a cheaper tier, each in turn, to find
// out whether a simpler method works again (and follows up a success, see
// planStartTier).
// A tier tried in a request is never fetched again in that request: a miss at
// the learned tier escalates from the next tier.

export const STRATEGY_TTL_SECONDS = 86_400;
const SAMPLE_DECAY = 0.9;
const HALF_LIFE_MS = 6 * 60 * 60 * 1000;
// 1 + 0.9 + 0.81: three fresh outcomes.
const MIN_SAMPLE_WEIGHT = 2.5;
const GOOD_RATE = 0.6;
export const DEFAULT_REPROBE_RATE = 0.05;
const LATENCY_EWMA = 0.3;
const MAX_TIER = 5;

export interface TierStats {
  /** Decayed number of accepted responses. */
  ok: number;
  /** Decayed number of attempts. */
  total: number;
  /** Epoch ms of the last attempt (decay reference). */
  lastAt: number;
  /** Epoch ms of the last accepted response. */
  lastOkAt?: number;
  /** Whether the most recent attempt was accepted. */
  lastOk?: boolean;
  /** Moving average latency of accepted responses. */
  latencyMs?: number;
}

export interface StoredStrategy {
  v: 2;
  tiers: Partial<Record<string, TierStats>>;
  /** Requests recorded (not decayed). */
  requests: number;
  // Summary in the legacy DomainStrategy shape, for dashboards and scripts
  // that read the key; routing only uses `tiers`.
  tier: number;
  successRate: number;
  sampleSize: number;
  avgLatencyMs: number;
  proxyTier: string;
  lastUpdated: string;
}

export interface TierOutcome {
  tier: number;
  ok: boolean;
  latencyMs?: number;
}

function finiteNonNegative(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

/**
 * Reads a stored strategy. Values written by older versions (one pooled
 * success rate) and malformed values yield null: they carry no per-tier
 * information, so the domain starts learning again and the next write
 * replaces them.
 */
export function parseStrategy(raw: string | null): StoredStrategy | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (obj.v !== 2 || typeof obj.tiers !== 'object' || obj.tiers === null) return null;

  const tiers: Partial<Record<string, TierStats>> = {};
  for (let t = 1; t <= MAX_TIER; t++) {
    const s = (obj.tiers as Record<string, unknown>)[String(t)] as Record<string, unknown> | undefined;
    if (!s || typeof s !== 'object') continue;
    const { ok, total, lastAt, lastOkAt, lastOk, latencyMs } = s;
    if (!finiteNonNegative(ok) || !finiteNonNegative(total) || !finiteNonNegative(lastAt) || ok > total) continue;
    // Decay bounds total at 1 / (1 - SAMPLE_DECAY); anything larger is not ours.
    if (total > 1 / (1 - SAMPLE_DECAY) + 1e-6) continue;
    tiers[String(t)] = {
      ok,
      total,
      lastAt,
      ...(finiteNonNegative(lastOkAt) ? { lastOkAt } : {}),
      ...(typeof lastOk === 'boolean' ? { lastOk } : {}),
      ...(finiteNonNegative(latencyMs) ? { latencyMs } : {}),
    };
  }
  return {
    v: 2,
    tiers,
    requests: finiteNonNegative(obj.requests) ? Math.floor(obj.requests) : 0,
    tier: typeof obj.tier === 'number' ? obj.tier : 1,
    successRate: typeof obj.successRate === 'number' ? obj.successRate : 0,
    sampleSize: typeof obj.sampleSize === 'number' ? obj.sampleSize : 0,
    avgLatencyMs: typeof obj.avgLatencyMs === 'number' ? obj.avgLatencyMs : 0,
    proxyTier: typeof obj.proxyTier === 'string' ? obj.proxyTier : 'datacenter',
    lastUpdated: typeof obj.lastUpdated === 'string' ? obj.lastUpdated : '',
  };
}

// A tier last tried longer ago than this has no evidence left (the key
// would have expired had no other tier been written meanwhile).
const EVIDENCE_TTL_MS = STRATEGY_TTL_SECONDS * 1000;

/**
 * Stats as of `now`: idle time decays both counts (the rate is unchanged),
 * but not below MIN_SAMPLE_WEIGHT. Decaying further would leave a domain
 * requested less often than every ~2.3 h "unknown" at every tier forever,
 * starting each request from T1.
 */
function decayedStats(s: TierStats | undefined, now: number): { ok: number; total: number } {
  if (!s) return { ok: 0, total: 0 };
  const idle = Math.max(0, now - s.lastAt);
  if (idle > EVIDENCE_TTL_MS) return { ok: 0, total: 0 };
  let f = 0.5 ** (idle / HALF_LIFE_MS);
  if (s.total * f < MIN_SAMPLE_WEIGHT) f = s.total > 0 ? Math.min(1, MIN_SAMPLE_WEIGHT / s.total) : 1;
  return { ok: s.ok * f, total: s.total * f };
}

type TierVerdict = 'good' | 'bad' | 'unknown';

function tierVerdict(s: TierStats | undefined, now: number): { verdict: TierVerdict; rate: number } {
  const { ok, total } = decayedStats(s, now);
  if (total < MIN_SAMPLE_WEIGHT) return { verdict: 'unknown', rate: total > 0 ? ok / total : 0 };
  const rate = ok / total;
  return { verdict: rate >= GOOD_RATE ? 'good' : 'bad', rate };
}

export type StartReason = 'cold' | 'js-heavy' | 'learned' | 'skip-failing' | 'best-effort' | 'reprobe' | 'confirm';

export interface StartPlanOptions {
  /** Tiers the router can run, cheapest first (e.g. [1, 2, 4, 5]). */
  tiers: readonly number[];
  jsHeavy: boolean;
  now: number;
  random: () => number;
  reprobeRate: number;
}

/** The learned start tier, without re-probing. */
function learnedStart(
  s: StoredStrategy | null,
  opts: Pick<StartPlanOptions, 'tiers' | 'jsHeavy' | 'now'>,
): { tier: number; reason: StartReason } {
  const { tiers, now } = opts;
  const verdicts = tiers.map((t) => ({ t, ...tierVerdict(s?.tiers[String(t)], now) }));
  const good = verdicts.find((v) => v.verdict === 'good');
  if (good) return { tier: good.t, reason: 'learned' };

  if (verdicts.every((v) => v.verdict === 'unknown')) {
    const start = opts.jsHeavy ? tiers.find((t) => t >= 4) ?? tiers[0] : tiers[0];
    return { tier: start, reason: opts.jsHeavy ? 'js-heavy' : 'cold' };
  }
  // No tier is reliable yet: skip tiers that keep failing.
  const firstNotBad = verdicts.find((v) => v.verdict !== 'bad');
  if (firstNotBad) return { tier: firstNotBad.t, reason: 'skip-failing' };
  // Everything fails more often than not: start where it fails least. When
  // nothing succeeded at all, every request ends at the last tier anyway (the
  // terminal tier returns what it gets), so the cheaper attempts are skipped.
  let best = verdicts[0];
  for (const v of verdicts) if (v.rate > best.rate) best = v;
  if (best.rate === 0) best = verdicts[verdicts.length - 1];
  return { tier: best.t, reason: 'best-effort' };
}

/**
 * Where a request for this domain starts escalating, and why. Once learned,
 * one request in 1/reprobeRate starts at a cheaper tier (see reprobeTarget);
 * while a cheaper tier keeps succeeding it is tried again on the next request
 * ('confirm'), so a domain gets back to the simpler method in a few requests
 * instead of waiting for more lucky draws. One failure ends the follow-ups.
 */
export function planStartTier(
  s: StoredStrategy | null,
  opts: StartPlanOptions,
): { tier: number; reason: StartReason } {
  const plan = learnedStart(s, opts);
  const idx = opts.tiers.indexOf(plan.tier);
  if (idx <= 0 || plan.reason === 'cold' || plan.reason === 'js-heavy') return plan;
  const cheaper = opts.tiers.slice(0, idx);
  const followUp = cheaper.find((t) => s?.tiers[String(t)]?.lastOk === true);
  if (followUp !== undefined) return { tier: followUp, reason: 'confirm' };
  if (opts.random() < opts.reprobeRate) return { tier: reprobeTarget(s, cheaper, opts.now), reason: 'reprobe' };
  return plan;
}

/**
 * The cheaper tier a re-probe tries: the cheapest one without a verdict
 * (never tried, or too little evidence), else the one whose last attempt is
 * oldest (the nearest on a tie). Successive probes so visit every cheaper
 * tier; probing only the next one would never reach T1 past a middle tier
 * that keeps failing (T2 behind a blocked proxy pool, or Lightpanda at T3),
 * since escalation only moves up.
 */
function reprobeTarget(s: StoredStrategy | null, cheaper: readonly number[], now: number): number {
  const unknown = cheaper.find((t) => tierVerdict(s?.tiers[String(t)], now).verdict === 'unknown');
  if (unknown !== undefined) return unknown;
  let target = cheaper[cheaper.length - 1];
  let oldest = s?.tiers[String(target)]?.lastAt ?? 0;
  for (let k = cheaper.length - 2; k >= 0; k--) {
    const at = s?.tiers[String(cheaper[k])]?.lastAt ?? 0;
    if (at < oldest) {
      target = cheaper[k];
      oldest = at;
    }
  }
  return target;
}

/** Folds one request's tier outcomes into the strategy. Pure. */
export function applyOutcomes(
  prev: StoredStrategy | null,
  outcomes: readonly TierOutcome[],
  now: number,
  summaryTiers: readonly number[] = [1, 2, 3, 4, 5],
): StoredStrategy {
  const tiers: Partial<Record<string, TierStats>> = {};
  for (const [k, v] of Object.entries(prev?.tiers ?? {})) if (v) tiers[k] = { ...v };

  for (const o of outcomes) {
    if (!Number.isInteger(o.tier) || o.tier < 1 || o.tier > MAX_TIER) continue;
    const key = String(o.tier);
    const cur = tiers[key];
    const decayed = decayedStats(cur, now);
    const next: TierStats = {
      ok: decayed.ok * SAMPLE_DECAY + (o.ok ? 1 : 0),
      total: decayed.total * SAMPLE_DECAY + 1,
      lastAt: now,
      ...(cur?.lastOkAt !== undefined ? { lastOkAt: cur.lastOkAt } : {}),
      lastOk: o.ok,
      ...(cur?.latencyMs !== undefined ? { latencyMs: cur.latencyMs } : {}),
    };
    if (o.ok) {
      next.lastOkAt = now;
      if (finiteNonNegative(o.latencyMs)) {
        next.latencyMs =
          next.latencyMs === undefined ? o.latencyMs : next.latencyMs + LATENCY_EWMA * (o.latencyMs - next.latencyMs);
      }
    }
    // Compact JSON; three decimals is far below the decay resolution.
    next.ok = Math.round(next.ok * 1000) / 1000;
    next.total = Math.round(next.total * 1000) / 1000;
    if (next.latencyMs !== undefined) next.latencyMs = Math.round(next.latencyMs);
    tiers[key] = next;
  }

  const strategy: StoredStrategy = {
    v: 2,
    tiers,
    requests: (prev?.requests ?? 0) + 1,
    tier: 1,
    successRate: 0,
    sampleSize: 0,
    avgLatencyMs: 0,
    proxyTier: prev?.proxyTier ?? 'datacenter',
    lastUpdated: new Date(now).toISOString(),
  };
  const start = learnedStart(strategy, { tiers: summaryTiers, jsHeavy: false, now });
  const chosen = tiers[String(start.tier)];
  const d = decayedStats(chosen, now);
  strategy.tier = start.tier;
  strategy.successRate = d.total > 0 ? Math.round((d.ok / d.total) * 1000) / 1000 : 0;
  strategy.sampleSize = strategy.requests;
  strategy.avgLatencyMs = chosen?.latencyMs ?? 0;
  return strategy;
}

// ─────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────

// Router tracing: every tier attempt is logged with its duration (on the
// tracer's clock, from the start of the attempt including browser-context
// acquisition) and how it ended. `outcome` reflects the acceptance gate; the
// terminal tier's response may still be returned when rejected.
function attemptStart(tracer: StageTracer | undefined): number {
  return tracer ? tracer.now() : 0;
}

function traceAttempt(
  tracer: StageTracer | undefined,
  tier: number,
  t0: number,
  outcome: AttemptOutcome,
  reason?: string,
): void {
  tracer?.recordAttempt({ tier, ms: tracer.now() - t0, outcome, reason });
}

interface TierResponse {
  html: string;
  statusCode: number;
  latencyMs: number;
  screenshot?: string;
}

/** A browser context could not be acquired: the pool's problem, not the tier's. */
class ContextAcquireError extends Error {
  constructor(readonly original: unknown) {
    super('browser context unavailable');
  }
}

type AttemptResult =
  | { kind: 'response'; r: TierResponse; ok: boolean }
  | { kind: 'error'; error: unknown; acquire: boolean };

/** Per-request state shared by the tier attempts. */
interface RequestContext {
  url: string;
  domain: string;
  options: ScrapeOptions;
  proxy: SelectedProxy | null;
  tracer?: StageTracer;
  /** Escalation notes for the "All tiers exhausted" error. */
  notes: string[];
  /** Outcomes to fold into the domain strategy once the request is done. */
  outcomes: TierOutcome[];
}

export interface SmartRouterOptions {
  /** Wall clock (epoch ms) for strategy statistics. */
  now?: () => number;
  /** Uniform [0, 1) source deciding re-probes. */
  random?: () => number;
  /** Share of learned-tier requests that start one tier cheaper. */
  reprobeRate?: number;
  /** A slower strategy read is abandoned and the request starts cold. */
  strategyReadTimeoutMs?: number;
  logger?: Pick<Console, 'warn'>;
}

// Strategy writes queued while Redis is slow or down are dropped beyond this.
const MAX_PENDING_STRATEGY_WRITES = 1_000;
const DEFAULT_STRATEGY_READ_TIMEOUT_MS = 500;

export class SmartRouter {
  private proxyManager: ProxyManager;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly reprobeRate: number;
  private readonly strategyReadTimeoutMs: number;
  private readonly logger: Pick<Console, 'warn'>;
  // Writes for one domain are chained so this process never loses its own
  // updates; separate workers can still interleave (statistics tolerate it).
  private readonly writeChains = new Map<string, Promise<void>>();
  private readonly pendingWrites = new Set<Promise<void>>();
  private droppedWrites = 0;

  constructor(
    private redis: Redis,
    private getBrowserContext: () => Promise<BrowserContext>,
    private releaseBrowserContext: (ctx: BrowserContext) => void,
    options: SmartRouterOptions = {},
  ) {
    this.proxyManager = new ProxyManager(redis);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.reprobeRate = options.reprobeRate ?? DEFAULT_REPROBE_RATE;
    this.strategyReadTimeoutMs = options.strategyReadTimeoutMs ?? DEFAULT_STRATEGY_READ_TIMEOUT_MS;
    this.logger = options.logger ?? console;
  }

  /**
   * @param tracer Optional per-request tracer: receives one entry per tier
   *   attempt and the accumulated "browser_acquire" stage.
   */
  async route(url: string, options: ScrapeOptions, tracer?: StageTracer): Promise<RouterResult> {
    const domain = new URL(url).hostname;
    const requiresBrowser = Boolean(options.screenshot || options.waitFor || options.mobile);
    // Known-hard domains go straight to the browser tier: these sites
    // (Cloudflare Enterprise, DataDome, aggressive Akamai) materially only
    // succeed at T4+. Their outcomes are still recorded so the statistics
    // reflect reality.
    const browserOnly = requiresBrowser || isHardDomain(domain);

    // One proxy per request, resolved alongside the strategy read.
    const [proxy, strategy] = await Promise.all([
      this.resolveProxy(domain, options.proxy),
      browserOnly ? Promise.resolve(null) : this.loadStrategy(domain),
    ]);
    const c: RequestContext = { url, domain, options, proxy, tracer, notes: [], outcomes: [] };

    try {
      if (browserOnly) return await this.executeBrowser(c);
      const tiers = this.availableTiers();
      const plan = planStartTier(strategy, {
        tiers,
        jsHeavy: isJsHeavyDomain(domain),
        now: this.now(),
        random: this.random,
        reprobeRate: this.reprobeRate,
      });
      return await this.escalate(c, plan.tier);
    } finally {
      // A forced browser request (screenshot, waitFor, mobile) says nothing
      // about whether a cheaper tier would have worked, so it is not learned.
      if (!requiresBrowser) this.recordOutcomes(domain, c.outcomes);
    }
  }

  /** Resolves once every strategy write started so far has settled. */
  async drainStrategyWrites(): Promise<void> {
    while (this.pendingWrites.size > 0) await Promise.allSettled([...this.pendingWrites]);
  }

  private availableTiers(): number[] {
    return isLightpandaConfigured() ? [1, 2, 3, 4, 5] : [1, 2, 4, 5];
  }

  // ── Full escalation chain ──────────────────────────────

  /**
   * Runs tiers from `startTier` upward and never goes back: a tier tried in
   * this request is not fetched again.
   */
  private async escalate(c: RequestContext, startTier: number): Promise<RouterResult> {
    const { url, options, proxy } = c;
    const proxyMeta = { proxyTier: proxy?.tier || 'none', proxyCost: proxy?.cost || 0 };
    const httpTimeout = Math.min(options.timeout || 15_000, 15_000);

    // ─── Tier 1: plain HTTP with impit defaults ───
    if (startTier <= 1) {
      const a = await this.attempt(c, 1, () =>
        tier1Fetch(url, { headers: options.headers, timeout: httpTimeout }),
      );
      if (a.kind === 'response' && a.ok) return { ...a.r, tierUsed: 1, ...proxyMeta };
    }

    // ─── Tier 2: HTTP with rotated browser TLS profile + proxy ───
    if (startTier <= 2) {
      const a = await this.attempt(c, 2, () =>
        tier2Fetch(url, { headers: options.headers, timeout: httpTimeout, proxy: proxy?.url }),
      );
      if (a.kind === 'response') {
        if (proxy) this.recordProxyResult(proxy, c.domain, a.ok, a.r.latencyMs);
        if (a.ok) return { ...a.r, tierUsed: 2, ...proxyMeta };
      }
    }

    // ─── Tier 3: Lightpanda lightweight browser ───
    if (startTier <= 3 && isLightpandaConfigured()) {
      const a = await this.attempt(c, 3, () =>
        tier3Fetch(url, { waitFor: options.waitFor, timeout: options.timeout, proxy: proxy?.url }),
      );
      if (a.kind === 'response' && a.ok) return { ...a.r, tierUsed: 3, ...proxyMeta };
    }

    // ─── Tier 4: full Patchright headless browser ───
    let t4Result: TierResponse | null = null;
    if (startTier <= 4) {
      const a = await this.attempt(c, 4, () =>
        this.withContext(c, (ctx) =>
          tier4Fetch(url, ctx, {
            waitFor: options.waitFor,
            timeout: options.timeout,
            blockResources: options.blockResources,
            mobile: options.mobile,
            screenshot: options.screenshot,
          }),
        ),
      );
      if (a.kind === 'response') {
        if (a.ok) return { ...a.r, tierUsed: 4, ...proxyMeta };
        t4Result = a.r;
      } else if (a.acquire) {
        // The stealth tier needs a context from the same pool; waiting for it
        // again would only double the delay. A saturated or closed pool is
        // temporary: its own error is thrown, not "All tiers exhausted"
        // (which the worker fails without retry).
        if (isPoolUnavailable(a.error)) throw a.error;
        c.notes.push('T5:skipped (no browser context)');
        throw new Error(this.exhaustedMessage(c));
      }
    }

    // ─── Tier 5 (stealth): anti-detect patches — TERMINAL ───
    //
    // Last stop. The quality gate is relaxed here so we always return
    // *something* rather than throwing "all tiers exhausted"; the caller
    // can decide based on qualityScore whether the result is usable.
    let stealthProxy: SelectedProxy | null = null;
    const a5 = await this.attempt(
      c,
      5,
      async () => {
        // Escalate proxy if current one failed at browser tier
        stealthProxy = proxy ? (await this.proxyManager.escalate(c.domain, proxy.tier)) || proxy : null;
        return this.withContext(c, (ctx) =>
          tier4StealthFetch(url, ctx, {
            waitFor: options.waitFor,
            timeout: options.timeout,
            blockResources: options.blockResources,
            screenshot: options.screenshot,
          }),
        );
      },
      true,
    );
    if (a5.kind === 'response' && a5.ok) {
      const sp = stealthProxy as SelectedProxy | null;
      return {
        ...a5.r,
        tierUsed: 5,
        proxyTier: sp?.tier || proxy?.tier || 'none',
        proxyCost: sp?.cost || proxy?.cost || 0,
      };
    }

    // Last-resort: return T4's body with a low quality flag baked in via
    // the quality scorer downstream, instead of throwing. This is what the
    // user wants 99% of the time (they already paid for the browser fetch,
    // returning empty markdown is strictly better than 500-ing the API).
    if (t4Result) return { ...t4Result, tierUsed: 4, ...proxyMeta };
    if (a5.kind === 'error' && a5.acquire && isPoolUnavailable(a5.error)) throw a5.error;

    throw new Error(this.exhaustedMessage(c));
  }

  /** Browser-only path: T4, then T5 whose response is returned even when rejected. */
  private async executeBrowser(c: RequestContext): Promise<RouterResult> {
    const { url, options, proxy } = c;
    const proxyMeta = { proxyTier: proxy?.tier || 'none', proxyCost: proxy?.cost || 0 };

    // ── T4: Patchright browser ──
    // Acquisition failures propagate (no stealth fallback), as before.
    const a4 = await this.attempt(c, 4, () => this.withContext(c, (ctx) => tier4Fetch(url, ctx, options)));
    if (a4.kind === 'response' && a4.ok) return { ...a4.r, tierUsed: 4, ...proxyMeta };
    if (a4.kind === 'error' && a4.acquire) throw a4.error;

    // ── T5: stealth (terminal — accept whatever we get) ──
    const a5 = await this.attempt(
      c,
      5,
      () =>
        this.withContext(c, (ctx) =>
          tier4StealthFetch(url, ctx, {
            waitFor: options.waitFor,
            timeout: options.timeout,
            blockResources: options.blockResources,
            screenshot: options.screenshot,
          }),
        ),
      true,
    );
    if (a5.kind === 'error') throw a5.error;
    return { ...a5.r, tierUsed: 5, ...proxyMeta };
  }

  /**
   * One tier attempt: fetch, acceptance gate, trace entry, escalation note
   * and strategy outcome. SSRF refusals and DNS failures are rethrown at
   * once (no further tier may try the URL). Any other error is returned with
   * the original error object (`acquire` marks browser-pool failures, which
   * are not held against the tier).
   */
  private async attempt(
    c: RequestContext,
    tier: number,
    fetch: () => Promise<TierResponse | null>,
    terminal = false,
  ): Promise<AttemptResult> {
    const t0 = attemptStart(c.tracer);
    let r: TierResponse | null;
    try {
      r = await fetch();
    } catch (err) {
      const acquire = err instanceof ContextAcquireError;
      const error = acquire ? err.original : err;
      const msg = describeError(error, c.proxy?.url);
      traceAttempt(c.tracer, tier, t0, 'error', msg);
      if (isFatalFetchError(error)) throw error;
      c.notes.push(`T${tier}:threw ${msg}`);
      if (!acquire) c.outcomes.push({ tier, ok: false });
      return { kind: 'error', error, acquire };
    }

    if (!r) {
      // tier3Fetch swallows its own failures and returns null.
      traceAttempt(c.tracer, tier, t0, 'error', 'no result');
      c.notes.push(`T${tier}:no result`);
      c.outcomes.push({ tier, ok: false });
      return { kind: 'error', error: new Error('no result'), acquire: false };
    }

    const g = judgeResponse(r.html, r.statusCode, tier, r.latencyMs, c.url);
    // Every tier is learned (and traced) by the normal bar. The terminal tier
    // still returns a valid response below it, because nothing is left to
    // try, but a challenge page handed back as a last resort is no success:
    // learned as one, it would make the domain start at the terminal tier.
    const accepted = g.valid && g.score >= MIN_TIER_ACCEPT_QUALITY;
    c.outcomes.push({ tier, ok: accepted, latencyMs: r.latencyMs });
    if (accepted) {
      traceAttempt(c.tracer, tier, t0, 'accepted');
    } else {
      traceAttempt(c.tracer, tier, t0, 'rejected', g.reason);
      c.notes.push(`T${tier}:${g.reason}`);
    }
    const returnable = accepted || (terminal && g.valid && g.score >= TERMINAL_TIER_ACCEPT_QUALITY);
    return { kind: 'response', r, ok: returnable };
  }

  private exhaustedMessage(c: RequestContext): string {
    let detail = c.notes.join(' | ');
    if (detail.length > MAX_EXHAUSTED_DETAIL_CHARS) detail = `${detail.slice(0, MAX_EXHAUSTED_DETAIL_CHARS - 1)}…`;
    return `All tiers exhausted for ${c.domain} — ${detail}`;
  }

  // ── Browser contexts ───────────────────────────────────

  // Waiting for a pooled context is pure queueing latency, so it is timed
  // separately (accumulated across T4 and T5 within one request).
  private acquireContext(tracer?: StageTracer): Promise<BrowserContext> {
    return tracer
      ? tracer.time('browser_acquire', () => this.getBrowserContext())
      : this.getBrowserContext();
  }

  private async withContext<T>(c: RequestContext, run: (ctx: BrowserContext) => Promise<T>): Promise<T> {
    let context: BrowserContext;
    try {
      context = await this.acquireContext(c.tracer);
    } catch (err) {
      throw new ContextAcquireError(err);
    }
    try {
      return await run(context);
    } finally {
      this.releaseBrowserContext(context);
    }
  }

  // ── Proxy resolution ───────────────────────────────────

  private async resolveProxy(
    domain: string,
    preference?: string,
  ): Promise<SelectedProxy | null> {
    return this.proxyManager.select(domain, (preference || 'auto') as any);
  }

  private recordProxyResult(proxy: SelectedProxy, domain: string, success: boolean, latencyMs: number): void {
    this.background(`proxy stats for ${domain}`, () =>
      this.proxyManager.recordResult(proxy, domain, success, latencyMs),
    );
  }

  // ── Domain strategy cache ──────────────────────────────

  private async loadStrategy(domain: string): Promise<StoredStrategy | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const raw = await Promise.race([
        this.redis.get(`domain:${domain}`),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${this.strategyReadTimeoutMs} ms`)),
            this.strategyReadTimeoutMs,
          );
        }),
      ]);
      return parseStrategy(raw);
    } catch (err) {
      // Without statistics the request simply escalates from the bottom.
      this.logger.warn(`[router] domain strategy read failed for ${domain}: ${describeError(err)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fire-and-forget: the response never waits for Redis. */
  private recordOutcomes(domain: string, outcomes: readonly TierOutcome[]): void {
    if (outcomes.length === 0) return;
    const prev = this.writeChains.get(domain) ?? Promise.resolve();
    const next = this.background(`domain strategy write for ${domain}`, async () => {
      await prev;
      const key = `domain:${domain}`;
      const now = this.now();
      const updated = applyOutcomes(parseStrategy(await this.redis.get(key)), outcomes, now, this.availableTiers());
      await this.redis.set(key, JSON.stringify(updated), 'EX', STRATEGY_TTL_SECONDS);
    });
    if (!next) return;
    this.writeChains.set(domain, next);
    void next.then(() => {
      if (this.writeChains.get(domain) === next) this.writeChains.delete(domain);
    });
  }

  /** Runs `task` off the critical path; failures are logged, never thrown. */
  private background(what: string, task: () => Promise<unknown>): Promise<void> | null {
    if (this.pendingWrites.size >= MAX_PENDING_STRATEGY_WRITES) {
      if (this.droppedWrites++ % 100 === 0) {
        this.logger.warn(`[router] ${this.pendingWrites.size} bookkeeping writes pending; dropping ${what}`);
      }
      return null;
    }
    const p = Promise.resolve()
      .then(task)
      .then(
        () => undefined,
        (err) => {
          this.logger.warn(`[router] ${what} failed: ${describeError(err)}`);
        },
      );
    this.pendingWrites.add(p);
    void p.then(() => this.pendingWrites.delete(p));
    return p;
  }
}
