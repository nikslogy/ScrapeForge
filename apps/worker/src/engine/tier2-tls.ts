import { Impit, type Browser } from 'impit';

export interface FetchResult {
  html: string;
  statusCode: number;
  headers: Record<string, string>;
  latencyMs: number;
}

const BROWSER_PROFILES: Browser[] = [
  'chrome',
  'chrome131',
  'firefox',
  'firefox135',
  'chrome116',
];

/**
 * Tier 2: HTTP fetch with explicit browser TLS fingerprint.
 * Rotates through Chrome/Firefox profiles to evade JA3/JA4-based blocking.
 */
export async function tier2Fetch(
  url: string,
  options: {
    headers?: Record<string, string>;
    timeout?: number;
    proxy?: string;
  } = {},
): Promise<FetchResult> {
  const start = performance.now();

  const profile = BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)];
  const client = new Impit({ browser: profile });

  const response = await client.fetch(url, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'max-age=0',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      ...options.headers,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeout || 15_000),
  });

  const html = await response.text();
  const latencyMs = Math.round(performance.now() - start);

  return {
    html,
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    latencyMs,
  };
}
