// === Job Types ===
export interface ScrapeJobData {
  jobId: string;
  userId: string;
  apiKeyId: string;
  url: string;
  options: ScrapeOptions;
  priority: 1 | 2 | 3 | 4;
  createdAt: string;
}

export interface ScrapeOptions {
  formats?: OutputFormat[];
  waitFor?: string;
  timeout?: number;
  proxy?: ProxyPreference;
  headers?: Record<string, string>;
  cookies?: CookieInput[];
  screenshot?: boolean;
  mobile?: boolean;
  blockResources?: boolean;
  cacheTtl?: number;
  webhookUrl?: string;
  extractSchema?: Record<string, unknown>;
}

export type OutputFormat = 'html' | 'markdown' | 'text' | 'screenshot' | 'json';

export type ProxyPreference = 'none' | 'datacenter' | 'residential' | 'mobile' | 'auto';

export interface CookieInput {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

// === Result Types ===
export interface ScrapeResult {
  jobId: string;
  url: string;
  status: 'completed' | 'failed';
  statusCode?: number;
  content: {
    html?: string;
    markdown?: string;
    text?: string;
    screenshot?: string;
    json?: Record<string, unknown>;
  };
  metadata: {
    tierUsed: number;
    proxyTier: string;
    latencyMs: number;
    cached: boolean;
    qualityScore: number;
    extractionMethod?: string;
    costBreakdown: CostBreakdown;
  };
  error?: string;
}

export interface CostBreakdown {
  compute: number;
  proxy: number;
  captcha: number;
  llm: number;
  total: number;
}

// === Domain Strategy ===
export interface DomainStrategy {
  tier: 1 | 2 | 3 | 4;
  proxyTier: 'datacenter' | 'residential' | 'mobile';
  successRate: number;
  avgLatencyMs: number;
  sampleSize: number;
  lastUpdated: string;
}

// === Proxy Types ===
export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  protocol: 'http' | 'https' | 'socks5';
  provider: string;
  tier: 'datacenter' | 'residential' | 'mobile';
  country?: string;
}

export interface ProxyScore {
  proxyId: string;
  successes: number;
  failures: number;
  avgLatency: number;
  lastUsed: string;
  domainScores: Record<string, { successes: number; failures: number }>;
}

// === Queue Constants ===
export const QUEUE_NAMES = {
  SCRAPE_REALTIME: 'scrape-realtime',
  SCRAPE_STANDARD: 'scrape-standard',
  SCRAPE_BATCH: 'scrape-batch',
  SCRAPE_BACKGROUND: 'scrape-background',
} as const;

export const QUEUE_CONFIG = {
  [QUEUE_NAMES.SCRAPE_REALTIME]:   { priority: 1, timeout: 30_000 },
  [QUEUE_NAMES.SCRAPE_STANDARD]:   { priority: 2, timeout: 60_000 },
  [QUEUE_NAMES.SCRAPE_BATCH]:      { priority: 3, timeout: 300_000 },
  [QUEUE_NAMES.SCRAPE_BACKGROUND]: { priority: 4, timeout: 1_800_000 },
} as const;

// === API Key Format ===
export const API_KEY_PREFIX = 'sf_live_';
