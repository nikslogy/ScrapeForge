import { Redis } from 'ioredis';
import type { BrowserContext } from 'patchright';
import type { ScrapeOptions, DomainStrategy } from '@scrapeforge/shared';
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
// `isValidContent` (no block keywords, normal size) but scores < 0.6
// because the visible text is thin and there's no semantic content.
//
// Set as conservatively as possible: legitimate thin pages (example.com)
// score 0.8 thanks to the short-content carve-out in quality-scorer, so
// 0.55 is the sweet spot — blocks T1/T2 soft-blocks, allows genuine
// minimal pages through.
const MIN_TIER_ACCEPT_QUALITY = 0.55;

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

// Single decision gate used by every tier in the router. Returns either
// `{ ok: true, score }` if we should accept the tier's response, or
// `{ ok: false, reason }` if the router should continue escalating.
//
// Layered checks:
//   1. `isValidContent` — fast keyword/structural block detection
//   2. `calculateQualityScore` — catches cloaked 200-OK pages that slip
//      past step 1 (empty body wrapped in nav/footer markup)
//
// On the terminal tier (T5 stealth) we skip the quality gate because
// there's nowhere left to escalate to; best-effort is better than
// "all tiers exhausted".
function assessTier(
  html: string,
  statusCode: number,
  tier: number,
  latencyMs: number,
  url: string,
  terminal = false,
): { ok: true; score: number } | { ok: false; score: number; reason: string } {
  if (!isValidContent(html, statusCode, url)) {
    return {
      ok: false,
      score: 0,
      reason: `invalid content (status=${statusCode} htmlLen=${html.length})`,
    };
  }
  const { score, signals } = calculateQualityScore(html, statusCode, tier, latencyMs);
  const threshold = terminal ? TERMINAL_TIER_ACCEPT_QUALITY : MIN_TIER_ACCEPT_QUALITY;
  if (score < threshold) {
    return {
      ok: false,
      score,
      reason: `low quality ${score.toFixed(2)} (${signals[0] || 'no signal'})`,
    };
  }
  return { ok: true, score };
}

// Tier fetchers throw whatever their libraries throw. Read the message
// defensively: a thrown string or null must not crash the escalation loop
// that is meant to absorb tier failures.
function describeError(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  if (typeof message === 'string') return message.slice(0, 120);
  try {
    return String(err).slice(0, 120);
  } catch {
    return 'unprintable error';
  }
}

// Router tracing: every tier attempt is logged with its duration (on the
// tracer's clock, from the start of the attempt including browser-context
// acquisition) and how it ended. `outcome` reflects the acceptance gate; the
// terminal tier's response may still be returned when rejected. If bookkeeping
// after a decision throws, the router treats the tier as failed (unchanged
// behavior) and a second 'error' entry for that tier records why.
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

export class SmartRouter {
  private proxyManager: ProxyManager;

  constructor(
    private redis: Redis,
    private getBrowserContext: () => Promise<BrowserContext>,
    private releaseBrowserContext: (ctx: BrowserContext) => void,
  ) {
    this.proxyManager = new ProxyManager(redis);
  }

  /**
   * @param tracer Optional per-request tracer: receives one entry per tier
   *   attempt and the accumulated "browser_acquire" stage.
   */
  async route(url: string, options: ScrapeOptions, tracer?: StageTracer): Promise<RouterResult> {
    const domain = new URL(url).hostname;
    const requiresBrowser =
      options.screenshot || options.waitFor || options.mobile;

    if (requiresBrowser) {
      const proxy = await this.resolveProxy(domain, options.proxy);
      return this.executeBrowser(url, options, domain, proxy, tracer);
    }

    // Known-hard domains: go straight to the browser tier and don't let the
    // adaptive cache fool us with a lucky T2 success into pinning a flaky
    // tier. These sites (Cloudflare Enterprise, DataDome, aggressive Akamai)
    // materially only succeed at T4+, so the 30s of T1→T2→T3 timeout is pure
    // waste. Cache updates still happen so metrics reflect reality.
    if (isHardDomain(domain)) {
      const proxy = await this.resolveProxy(domain, options.proxy);
      return this.executeBrowser(url, options, domain, proxy, tracer);
    }

    const cached = await this.getDomainStrategy(domain);
    // Trust the cached tier once we've seen it succeed ≥50% of the time over
    // at least 3 samples. The previous 0.8 bar meant a domain like wikipedia,
    // which blocks our T1 fingerprint every time, never got to cache T4 and
    // kept paying the full-escalation cost on every request.
    if (cached && cached.successRate >= 0.5 && cached.sampleSize >= 3) {
      return this.executeAtTier(cached.tier, url, options, domain, tracer);
    }

    // Cold-start shortcut: well-known JS-heavy domains skip T1/T2 but
    // still fall back to T5/stealth if the browser is blocked.
    const skipHttpTiers = !cached && isJsHeavyDomain(domain);
    return this.escalate(url, options, domain, { skipHttpTiers }, tracer);
  }

  // ── Full escalation chain ──────────────────────────────

  private async escalate(
    url: string,
    options: ScrapeOptions,
    domain: string,
    flags: { skipHttpTiers?: boolean } = {},
    tracer?: StageTracer,
  ): Promise<RouterResult> {
    const proxy = await this.resolveProxy(domain, options.proxy);
    const proxyUrl = proxy?.url;
    const proxyMeta = { proxyTier: proxy?.tier || 'none', proxyCost: proxy?.cost || 0 };

    // Each tier pushes a short diagnostic string so the final error tells us
    // why every attempt failed instead of the opaque "All tiers exhausted".
    const attempts: string[] = [];
    const note = (tier: number, msg: string) => {
      attempts.push(`T${tier}:${msg}`);
    };

    // ─── Tier 1: plain HTTP with impit defaults ───
    if (!flags.skipHttpTiers) {
      let t0 = attemptStart(tracer);
      try {
        const r = await tier1Fetch(url, {
          headers: options.headers,
          timeout: Math.min(options.timeout || 15_000, 15_000),
        });
        const v = assessTier(r.html, r.statusCode, 1, r.latencyMs, url);
        if (v.ok) {
          traceAttempt(tracer, 1, t0, 'accepted');
          await this.updateDomainStrategy(domain, 1, true, r.latencyMs);
          return { ...r, tierUsed: 1, ...proxyMeta };
        }
        note(1, v.reason);
        traceAttempt(tracer, 1, t0, 'rejected', v.reason);
        await this.updateDomainStrategy(domain, 1, false, r.latencyMs);
      } catch (err) {
        const msg = describeError(err);
        note(1, `threw ${msg}`);
        traceAttempt(tracer, 1, t0, 'error', msg);
      }

      // ─── Tier 2: HTTP with rotated browser TLS profile + proxy ───
      t0 = attemptStart(tracer);
      try {
        const r = await tier2Fetch(url, {
          headers: options.headers,
          timeout: Math.min(options.timeout || 15_000, 15_000),
          proxy: proxyUrl,
        });
        const v = assessTier(r.html, r.statusCode, 2, r.latencyMs, url);
        if (v.ok) {
          traceAttempt(tracer, 2, t0, 'accepted');
          await this.updateDomainStrategy(domain, 2, true, r.latencyMs);
          if (proxy) await this.proxyManager.recordResult(proxy, domain, true, r.latencyMs);
          return { ...r, tierUsed: 2, ...proxyMeta };
        }
        note(2, v.reason);
        traceAttempt(tracer, 2, t0, 'rejected', v.reason);
        await this.updateDomainStrategy(domain, 2, false, r.latencyMs);
        if (proxy) await this.proxyManager.recordResult(proxy, domain, false, r.latencyMs);
      } catch (err) {
        const msg = describeError(err);
        note(2, `threw ${msg}`);
        traceAttempt(tracer, 2, t0, 'error', msg);
      }
    }

    // ─── Tier 3: Lightpanda lightweight browser ───
    if (isLightpandaConfigured()) {
      const t0 = attemptStart(tracer);
      try {
        const r = await tier3Fetch(url, {
          waitFor: options.waitFor,
          timeout: options.timeout,
          proxy: proxyUrl,
        });
        if (r) {
          const v = assessTier(r.html, r.statusCode, 3, r.latencyMs, url);
          if (v.ok) {
            traceAttempt(tracer, 3, t0, 'accepted');
            await this.updateDomainStrategy(domain, 3, true, r.latencyMs);
            return { ...r, tierUsed: 3, ...proxyMeta };
          }
          note(3, v.reason);
          traceAttempt(tracer, 3, t0, 'rejected', v.reason);
        } else {
          // tier3Fetch swallows its own failures and returns null.
          note(3, 'no result');
          traceAttempt(tracer, 3, t0, 'error', 'no result');
        }
      } catch (err) {
        const msg = describeError(err);
        note(3, `threw ${msg}`);
        traceAttempt(tracer, 3, t0, 'error', msg);
      }
    }

    // ─── Tier 4: full Patchright headless browser ───
    let context: BrowserContext | null = null;
    let t4Result: { html: string; statusCode: number; latencyMs: number; screenshot?: string } | null = null;
    let t0 = attemptStart(tracer);
    try {
      context = await this.acquireContext(tracer);
      const r = await tier4Fetch(url, context, {
        waitFor: options.waitFor,
        timeout: options.timeout,
        blockResources: options.blockResources,
        mobile: options.mobile,
        screenshot: options.screenshot,
      });
      t4Result = r;
      const v = assessTier(r.html, r.statusCode, 4, r.latencyMs, url);
      if (v.ok) {
        traceAttempt(tracer, 4, t0, 'accepted');
        await this.updateDomainStrategy(domain, 4, true, r.latencyMs);
        return { ...r, tierUsed: 4, ...proxyMeta };
      }
      note(4, v.reason);
      traceAttempt(tracer, 4, t0, 'rejected', v.reason);
      await this.updateDomainStrategy(domain, 4, false, r.latencyMs);
    } catch (err) {
      const msg = describeError(err);
      note(4, `threw ${msg}`);
      traceAttempt(tracer, 4, t0, 'error', msg);
    } finally {
      if (context) this.releaseBrowserContext(context);
      context = null;
    }

    // ─── Tier 5 (stealth): anti-detect patches — TERMINAL ───
    //
    // Last stop. The quality gate is relaxed here so we always return
    // *something* rather than throwing "all tiers exhausted"; the caller
    // can decide based on qualityScore whether the result is usable.
    // If T5 itself throws, we still want to fall back to T4's data if
    // we captured it — otherwise the caller gets nothing at all.
    t0 = attemptStart(tracer);
    try {
      // Escalate proxy if current one failed at browser tier
      const stealthProxy = proxy
        ? (await this.proxyManager.escalate(domain, proxy.tier)) || proxy
        : null;

      context = await this.acquireContext(tracer);
      const r = await tier4StealthFetch(url, context, {
        waitFor: options.waitFor,
        timeout: options.timeout,
        blockResources: options.blockResources,
        screenshot: options.screenshot,
      });
      const v = assessTier(r.html, r.statusCode, 5, r.latencyMs, url, true);
      if (v.ok) {
        traceAttempt(tracer, 5, t0, 'accepted');
        await this.updateDomainStrategy(domain, 5, true, r.latencyMs);
        return {
          ...r,
          tierUsed: 5,
          proxyTier: stealthProxy?.tier || proxy?.tier || 'none',
          proxyCost: stealthProxy?.cost || proxy?.cost || 0,
        };
      }
      note(5, v.reason);
      traceAttempt(tracer, 5, t0, 'rejected', v.reason);
    } catch (err) {
      const msg = describeError(err);
      note(5, `threw ${msg}`);
      traceAttempt(tracer, 5, t0, 'error', msg);
    } finally {
      if (context) this.releaseBrowserContext(context);
    }

    // Last-resort: return T4's body with a zero quality flag baked in via
    // the quality scorer downstream, instead of throwing. This is what the
    // user wants 99% of the time (they already paid for the browser fetch,
    // returning empty markdown is strictly better than 500-ing the API).
    if (t4Result) {
      return {
        ...t4Result,
        tierUsed: 4,
        ...proxyMeta,
      };
    }

    throw new Error(`All tiers exhausted for ${domain} — ${attempts.join(' | ')}`);
  }

  // ── Cached-tier fast path ──────────────────────────────

  private async executeAtTier(
    tier: number,
    url: string,
    options: ScrapeOptions,
    domain: string,
    tracer?: StageTracer,
  ): Promise<RouterResult> {
    const proxy = await this.resolveProxy(domain, options.proxy);
    const proxyUrl = proxy?.url;
    const proxyMeta = { proxyTier: proxy?.tier || 'none', proxyCost: proxy?.cost || 0 };

    if (tier <= 1) {
      const t0 = attemptStart(tracer);
      try {
        const r = await tier1Fetch(url, { headers: options.headers });
        const v = assessTier(r.html, r.statusCode, 1, r.latencyMs, url);
        if (v.ok) {
          traceAttempt(tracer, 1, t0, 'accepted');
          await this.updateDomainStrategy(domain, tier, true, r.latencyMs);
          return { ...r, tierUsed: tier, ...proxyMeta };
        }
        traceAttempt(tracer, 1, t0, 'rejected', v.reason);
      } catch (err) {
        traceAttempt(tracer, 1, t0, 'error', describeError(err));
      }
      return this.escalate(url, options, domain, {}, tracer);
    }

    if (tier === 2) {
      const t0 = attemptStart(tracer);
      try {
        const r = await tier2Fetch(url, { headers: options.headers, proxy: proxyUrl });
        const v = assessTier(r.html, r.statusCode, 2, r.latencyMs, url);
        if (v.ok) {
          traceAttempt(tracer, 2, t0, 'accepted');
          await this.updateDomainStrategy(domain, 2, true, r.latencyMs);
          return { ...r, tierUsed: 2, ...proxyMeta };
        }
        traceAttempt(tracer, 2, t0, 'rejected', v.reason);
      } catch (err) {
        traceAttempt(tracer, 2, t0, 'error', describeError(err));
      }
      return this.escalate(url, options, domain, {}, tracer);
    }

    // Tiers 3-5 use browser
    return this.executeBrowser(url, options, domain, proxy, tracer);
  }

  private async executeBrowser(
    url: string,
    options: ScrapeOptions,
    domain: string,
    proxy: SelectedProxy | null,
    tracer?: StageTracer,
  ): Promise<RouterResult> {
    const proxyMeta = { proxyTier: proxy?.tier || 'none', proxyCost: proxy?.cost || 0 };

    // ── T4: Patchright browser ──
    // Acquisition failures propagate (no stealth fallback), as before.
    let t0 = attemptStart(tracer);
    let context = await this.acquireForAttempt(tracer, 4, t0);
    try {
      const r = await tier4Fetch(url, context, options);
      const v = assessTier(r.html, r.statusCode, 4, r.latencyMs, url);
      if (v.ok) {
        traceAttempt(tracer, 4, t0, 'accepted');
        await this.updateDomainStrategy(domain, 4, true, r.latencyMs);
        return { ...r, tierUsed: 4, ...proxyMeta };
      }
      traceAttempt(tracer, 4, t0, 'rejected', v.reason);
      await this.updateDomainStrategy(domain, 4, false, r.latencyMs);
    } catch (err) {
      traceAttempt(tracer, 4, t0, 'error', describeError(err));
      /* fall through to stealth */
    } finally {
      this.releaseBrowserContext(context);
    }

    // ── T5: stealth (terminal — accept whatever we get) ──
    t0 = attemptStart(tracer);
    context = await this.acquireForAttempt(tracer, 5, t0);
    try {
      const r = await tier4StealthFetch(url, context, {
        waitFor: options.waitFor,
        timeout: options.timeout,
        blockResources: options.blockResources,
        screenshot: options.screenshot,
      });
      const v = assessTier(r.html, r.statusCode, 5, r.latencyMs, url, true);
      if (v.ok) {
        traceAttempt(tracer, 5, t0, 'accepted');
        await this.updateDomainStrategy(domain, 5, true, r.latencyMs);
      } else {
        traceAttempt(tracer, 5, t0, 'rejected', v.reason);
        await this.updateDomainStrategy(domain, 5, false, r.latencyMs);
      }
      return { ...r, tierUsed: 5, ...proxyMeta };
    } catch (err) {
      traceAttempt(tracer, 5, t0, 'error', describeError(err));
      throw err;
    } finally {
      this.releaseBrowserContext(context);
    }
  }

  // ── Browser contexts ───────────────────────────────────

  // Waiting for a pooled context is pure queueing latency, so it is timed
  // separately (accumulated across T4 and T5 within one request).
  private acquireContext(tracer?: StageTracer): Promise<BrowserContext> {
    return tracer
      ? tracer.time('browser_acquire', () => this.getBrowserContext())
      : this.getBrowserContext();
  }

  // For call sites where an acquisition failure escapes the tier's own
  // try/catch: record the failed attempt, then rethrow unchanged.
  private async acquireForAttempt(
    tracer: StageTracer | undefined,
    tier: number,
    t0: number,
  ): Promise<BrowserContext> {
    try {
      return await this.acquireContext(tracer);
    } catch (err) {
      traceAttempt(tracer, tier, t0, 'error', describeError(err));
      throw err;
    }
  }

  // ── Proxy resolution ───────────────────────────────────

  private async resolveProxy(
    domain: string,
    preference?: string,
  ): Promise<SelectedProxy | null> {
    return this.proxyManager.select(domain, (preference || 'auto') as any);
  }

  // ── Domain strategy cache ──────────────────────────────

  private async getDomainStrategy(domain: string): Promise<DomainStrategy | null> {
    const data = await this.redis.get(`domain:${domain}`);
    return data ? JSON.parse(data) : null;
  }

  private async updateDomainStrategy(
    domain: string,
    tier: number,
    success: boolean,
    latencyMs: number,
  ): Promise<void> {
    const key = `domain:${domain}`;
    const existing = await this.getDomainStrategy(domain);

    const sampleSize = (existing?.sampleSize || 0) + 1;
    const successCount =
      (existing ? existing.successRate * existing.sampleSize : 0) + (success ? 1 : 0);

    const strategy: DomainStrategy = {
      tier: (success ? Math.min(tier, 4) : Math.min(tier + 1, 4)) as 1 | 2 | 3 | 4,
      proxyTier: existing?.proxyTier || 'datacenter',
      successRate: successCount / sampleSize,
      avgLatencyMs: existing
        ? Math.round((existing.avgLatencyMs * (sampleSize - 1) + latencyMs) / sampleSize)
        : latencyMs,
      sampleSize,
      lastUpdated: new Date().toISOString(),
    };

    await this.redis.set(key, JSON.stringify(strategy), 'EX', 86400);
  }
}
