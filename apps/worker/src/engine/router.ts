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

export class SmartRouter {
  private proxyManager: ProxyManager;

  constructor(
    private redis: Redis,
    private getBrowserContext: () => Promise<BrowserContext>,
    private releaseBrowserContext: (ctx: BrowserContext) => void,
  ) {
    this.proxyManager = new ProxyManager(redis);
  }

  async route(url: string, options: ScrapeOptions): Promise<RouterResult> {
    const domain = new URL(url).hostname;
    const requiresBrowser =
      options.screenshot || options.waitFor || options.mobile;

    if (requiresBrowser) {
      const proxy = await this.resolveProxy(domain, options.proxy);
      return this.executeBrowser(url, options, domain, proxy);
    }

    // Known-hard domains: go straight to the browser tier and don't let the
    // adaptive cache fool us with a lucky T2 success into pinning a flaky
    // tier. These sites (Cloudflare Enterprise, DataDome, aggressive Akamai)
    // materially only succeed at T4+, so the 30s of T1→T2→T3 timeout is pure
    // waste. Cache updates still happen so metrics reflect reality.
    if (isHardDomain(domain)) {
      const proxy = await this.resolveProxy(domain, options.proxy);
      return this.executeBrowser(url, options, domain, proxy);
    }

    const cached = await this.getDomainStrategy(domain);
    // Trust the cached tier once we've seen it succeed ≥50% of the time over
    // at least 3 samples. The previous 0.8 bar meant a domain like wikipedia,
    // which blocks our T1 fingerprint every time, never got to cache T4 and
    // kept paying the full-escalation cost on every request.
    if (cached && cached.successRate >= 0.5 && cached.sampleSize >= 3) {
      return this.executeAtTier(cached.tier, url, options, domain);
    }

    // Cold-start shortcut: well-known JS-heavy domains skip T1/T2 but
    // still fall back to T5/stealth if the browser is blocked.
    const skipHttpTiers = !cached && isJsHeavyDomain(domain);
    return this.escalate(url, options, domain, { skipHttpTiers });
  }

  // ── Full escalation chain ──────────────────────────────

  private async escalate(
    url: string,
    options: ScrapeOptions,
    domain: string,
    flags: { skipHttpTiers?: boolean } = {},
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
      try {
        const r = await tier1Fetch(url, {
          headers: options.headers,
          timeout: Math.min(options.timeout || 15_000, 15_000),
        });
        const v = assessTier(r.html, r.statusCode, 1, r.latencyMs, url);
        if (v.ok) {
          await this.updateDomainStrategy(domain, 1, true, r.latencyMs);
          return { ...r, tierUsed: 1, ...proxyMeta };
        }
        note(1, v.reason);
        await this.updateDomainStrategy(domain, 1, false, r.latencyMs);
      } catch (err) {
        note(1, `threw ${(err as Error).message.slice(0, 120)}`);
      }

      // ─── Tier 2: HTTP with rotated browser TLS profile + proxy ───
      try {
        const r = await tier2Fetch(url, {
          headers: options.headers,
          timeout: Math.min(options.timeout || 15_000, 15_000),
          proxy: proxyUrl,
        });
        const v = assessTier(r.html, r.statusCode, 2, r.latencyMs, url);
        if (v.ok) {
          await this.updateDomainStrategy(domain, 2, true, r.latencyMs);
          if (proxy) await this.proxyManager.recordResult(proxy, domain, true, r.latencyMs);
          return { ...r, tierUsed: 2, ...proxyMeta };
        }
        note(2, v.reason);
        await this.updateDomainStrategy(domain, 2, false, r.latencyMs);
        if (proxy) await this.proxyManager.recordResult(proxy, domain, false, r.latencyMs);
      } catch (err) {
        note(2, `threw ${(err as Error).message.slice(0, 120)}`);
      }
    }

    // ─── Tier 3: Lightpanda lightweight browser ───
    if (isLightpandaConfigured()) {
      try {
        const r = await tier3Fetch(url, {
          waitFor: options.waitFor,
          timeout: options.timeout,
          proxy: proxyUrl,
        });
        if (r) {
          const v = assessTier(r.html, r.statusCode, 3, r.latencyMs, url);
          if (v.ok) {
            await this.updateDomainStrategy(domain, 3, true, r.latencyMs);
            return { ...r, tierUsed: 3, ...proxyMeta };
          }
          note(3, v.reason);
        } else {
          note(3, 'no result');
        }
      } catch (err) {
        note(3, `threw ${(err as Error).message.slice(0, 120)}`);
      }
    }

    // ─── Tier 4: full Patchright headless browser ───
    let context: BrowserContext | null = null;
    let t4Result: { html: string; statusCode: number; latencyMs: number; screenshot?: string } | null = null;
    try {
      context = await this.getBrowserContext();
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
        await this.updateDomainStrategy(domain, 4, true, r.latencyMs);
        return { ...r, tierUsed: 4, ...proxyMeta };
      }
      note(4, v.reason);
      await this.updateDomainStrategy(domain, 4, false, r.latencyMs);
    } catch (err) {
      note(4, `threw ${(err as Error).message.slice(0, 120)}`);
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
    try {
      // Escalate proxy if current one failed at browser tier
      const stealthProxy = proxy
        ? (await this.proxyManager.escalate(domain, proxy.tier)) || proxy
        : null;

      context = await this.getBrowserContext();
      const r = await tier4StealthFetch(url, context, {
        waitFor: options.waitFor,
        timeout: options.timeout,
        blockResources: options.blockResources,
        screenshot: options.screenshot,
      });
      const v = assessTier(r.html, r.statusCode, 5, r.latencyMs, url, true);
      if (v.ok) {
        await this.updateDomainStrategy(domain, 5, true, r.latencyMs);
        return {
          ...r,
          tierUsed: 5,
          proxyTier: stealthProxy?.tier || proxy?.tier || 'none',
          proxyCost: stealthProxy?.cost || proxy?.cost || 0,
        };
      }
      note(5, v.reason);
    } catch (err) {
      note(5, `threw ${(err as Error).message.slice(0, 120)}`);
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
  ): Promise<RouterResult> {
    const proxy = await this.resolveProxy(domain, options.proxy);
    const proxyUrl = proxy?.url;
    const proxyMeta = { proxyTier: proxy?.tier || 'none', proxyCost: proxy?.cost || 0 };

    if (tier <= 1) {
      try {
        const r = await tier1Fetch(url, { headers: options.headers });
        const v = assessTier(r.html, r.statusCode, 1, r.latencyMs, url);
        if (v.ok) {
          await this.updateDomainStrategy(domain, tier, true, r.latencyMs);
          return { ...r, tierUsed: tier, ...proxyMeta };
        }
      } catch { /* fall through */ }
      return this.escalate(url, options, domain);
    }

    if (tier === 2) {
      try {
        const r = await tier2Fetch(url, { headers: options.headers, proxy: proxyUrl });
        const v = assessTier(r.html, r.statusCode, 2, r.latencyMs, url);
        if (v.ok) {
          await this.updateDomainStrategy(domain, 2, true, r.latencyMs);
          return { ...r, tierUsed: 2, ...proxyMeta };
        }
      } catch { /* fall through */ }
      return this.escalate(url, options, domain);
    }

    // Tiers 3-5 use browser
    return this.executeBrowser(url, options, domain, proxy);
  }

  private async executeBrowser(
    url: string,
    options: ScrapeOptions,
    domain: string,
    proxy: SelectedProxy | null,
  ): Promise<RouterResult> {
    const proxyMeta = { proxyTier: proxy?.tier || 'none', proxyCost: proxy?.cost || 0 };

    // ── T4: Patchright browser ──
    let context = await this.getBrowserContext();
    try {
      const r = await tier4Fetch(url, context, options);
      const v = assessTier(r.html, r.statusCode, 4, r.latencyMs, url);
      if (v.ok) {
        await this.updateDomainStrategy(domain, 4, true, r.latencyMs);
        return { ...r, tierUsed: 4, ...proxyMeta };
      }
      await this.updateDomainStrategy(domain, 4, false, r.latencyMs);
    } catch {
      /* fall through to stealth */
    } finally {
      this.releaseBrowserContext(context);
    }

    // ── T5: stealth (terminal — accept whatever we get) ──
    context = await this.getBrowserContext();
    try {
      const r = await tier4StealthFetch(url, context, {
        waitFor: options.waitFor,
        timeout: options.timeout,
        blockResources: options.blockResources,
        screenshot: options.screenshot,
      });
      const v = assessTier(r.html, r.statusCode, 5, r.latencyMs, url, true);
      if (v.ok) {
        await this.updateDomainStrategy(domain, 5, true, r.latencyMs);
      } else {
        await this.updateDomainStrategy(domain, 5, false, r.latencyMs);
      }
      return { ...r, tierUsed: 5, ...proxyMeta };
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
