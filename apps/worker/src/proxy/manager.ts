import { Redis } from 'ioredis';
import { getProvidersByTier, hasAnyProxy, type ProxyProvider } from './providers.js';
import { ProxyScorer, type ProxyStats } from './scorer.js';

export type ProxyTier = 'datacenter' | 'residential' | 'mobile';
const TIER_ORDER: ProxyTier[] = ['datacenter', 'residential', 'mobile'];
const PROXY_COST: Record<ProxyTier, number> = {
  datacenter: 0.00005,
  residential: 0.0003,
  mobile: 0.0008,
};

export interface SelectedProxy {
  url: string;
  provider: ProxyProvider;
  tier: ProxyTier;
  cost: number;
}

export class ProxyManager {
  private scorer: ProxyScorer;
  private roundRobinIndex: Record<string, number> = {};

  constructor(private redis: Redis) {
    this.scorer = new ProxyScorer(redis);
  }

  get available(): boolean {
    return hasAnyProxy();
  }

  async select(
    domain: string,
    preference: 'none' | 'datacenter' | 'residential' | 'mobile' | 'auto',
  ): Promise<SelectedProxy | null> {
    if (preference === 'none' || !this.available) return null;

    if (preference !== 'auto') {
      return this.selectFromTier(preference, domain);
    }

    // Auto mode: check cached domain proxy tier, else start with datacenter
    const cached = await this.getCachedProxyTier(domain);
    const startTier = cached || 'datacenter';
    return this.selectFromTier(startTier, domain);
  }

  async escalate(
    domain: string,
    currentTier: ProxyTier,
  ): Promise<SelectedProxy | null> {
    const idx = TIER_ORDER.indexOf(currentTier);
    for (let i = idx + 1; i < TIER_ORDER.length; i++) {
      const proxy = await this.selectFromTier(TIER_ORDER[i], domain);
      if (proxy) return proxy;
    }
    return null;
  }

  async recordResult(
    proxy: SelectedProxy,
    domain: string,
    success: boolean,
    latencyMs: number,
  ): Promise<void> {
    await this.scorer.recordResult(proxy.provider.name, domain, success, latencyMs);

    if (success) {
      await this.cacheProxyTier(domain, proxy.tier);
    }
  }

  private async selectFromTier(
    tier: ProxyTier,
    domain: string,
  ): Promise<SelectedProxy | null> {
    const candidates = getProvidersByTier(tier);
    if (candidates.length === 0) return null;

    // Rank by domain-specific score
    const scored: Array<{ provider: ProxyProvider; score: number }> = [];
    for (const p of candidates) {
      const stats = await this.scorer.getStats(p.name);
      const score = stats
        ? this.scorer.computeDomainScore(stats, domain)
        : 0.5;
      if (stats && this.scorer.shouldDemote(stats)) continue;
      scored.push({ provider: p, score });
    }

    if (scored.length === 0) return null;

    scored.sort((a, b) => b.score - a.score);

    // Weighted random among top candidates to avoid hammering one proxy
    const pick = scored.length <= 2
      ? scored[0]
      : scored[Math.floor(Math.random() * Math.min(3, scored.length))];

    const url = pick.provider.buildUrl({ session: this.nextSession(pick.provider.name) });

    return {
      url,
      provider: pick.provider,
      tier,
      cost: PROXY_COST[tier],
    };
  }

  private nextSession(providerName: string): string {
    const idx = (this.roundRobinIndex[providerName] || 0) + 1;
    this.roundRobinIndex[providerName] = idx;
    return `sf${idx.toString(36)}${Date.now().toString(36).slice(-4)}`;
  }

  private async getCachedProxyTier(domain: string): Promise<ProxyTier | null> {
    const raw = await this.redis.get(`proxy-tier:${domain}`);
    return raw as ProxyTier | null;
  }

  private async cacheProxyTier(domain: string, tier: ProxyTier): Promise<void> {
    await this.redis.set(`proxy-tier:${domain}`, tier, 'EX', 86400);
  }
}
