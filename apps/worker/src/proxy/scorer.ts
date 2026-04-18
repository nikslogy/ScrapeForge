import { Redis } from 'ioredis';

export interface ProxyStats {
  proxyId: string;
  successes: number;
  failures: number;
  avgLatency: number;
  lastUsed: number;
  domainStats: Record<string, { successes: number; failures: number }>;
}

const SCORE_TTL = 86400 * 7; // 7 days

export class ProxyScorer {
  constructor(private redis: Redis) {}

  /**
   * score = (success_rate × 0.5) + (speed_score × 0.3) + (freshness × 0.2)
   * speed_score = 1 / (1 + avgLatency/5000)  → normalised 0-1
   * freshness = recency of last use (more recent = higher)
   */
  computeScore(stats: ProxyStats): number {
    const total = stats.successes + stats.failures;
    if (total === 0) return 0.5; // unknown proxy gets neutral score

    const successRate = stats.successes / total;
    const speedScore = 1 / (1 + stats.avgLatency / 5000);
    const hoursSinceUse = (Date.now() - stats.lastUsed) / 3_600_000;
    const freshness = Math.max(0, 1 - hoursSinceUse / 168); // decays over 7 days

    return successRate * 0.5 + speedScore * 0.3 + freshness * 0.2;
  }

  computeDomainScore(stats: ProxyStats, domain: string): number {
    const ds = stats.domainStats[domain];
    if (!ds) return this.computeScore(stats);

    const total = ds.successes + ds.failures;
    if (total < 3) return this.computeScore(stats);

    const domainSuccessRate = ds.successes / total;
    const globalScore = this.computeScore(stats);
    return domainSuccessRate * 0.6 + globalScore * 0.4;
  }

  async recordResult(
    proxyId: string,
    domain: string,
    success: boolean,
    latencyMs: number,
  ): Promise<void> {
    const key = `proxy-stats:${proxyId}`;
    const raw = await this.redis.get(key);
    const stats: ProxyStats = raw
      ? JSON.parse(raw)
      : { proxyId, successes: 0, failures: 0, avgLatency: 0, lastUsed: 0, domainStats: {} };

    const total = stats.successes + stats.failures;
    stats.avgLatency = total > 0
      ? Math.round((stats.avgLatency * total + latencyMs) / (total + 1))
      : latencyMs;

    if (success) stats.successes++;
    else stats.failures++;
    stats.lastUsed = Date.now();

    if (!stats.domainStats[domain]) {
      stats.domainStats[domain] = { successes: 0, failures: 0 };
    }
    if (success) stats.domainStats[domain].successes++;
    else stats.domainStats[domain].failures++;

    await this.redis.set(key, JSON.stringify(stats), 'EX', SCORE_TTL);
  }

  async getStats(proxyId: string): Promise<ProxyStats | null> {
    const raw = await this.redis.get(`proxy-stats:${proxyId}`);
    return raw ? JSON.parse(raw) : null;
  }

  shouldDemote(stats: ProxyStats): boolean {
    const total = stats.successes + stats.failures;
    if (total < 5) return false;
    return (stats.successes / total) < 0.7;
  }

  shouldPromote(stats: ProxyStats): boolean {
    const total = stats.successes + stats.failures;
    if (total < 10) return false;
    return (stats.successes / total) > 0.95;
  }
}
