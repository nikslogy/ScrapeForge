import { Impit } from 'impit';

export interface FetchResult {
  html: string;
  statusCode: number;
  headers: Record<string, string>;
  latencyMs: number;
}

const client = new Impit();

export async function tier1Fetch(
  url: string,
  options: {
    headers?: Record<string, string>;
    timeout?: number;
    proxy?: string;
  } = {},
): Promise<FetchResult> {
  const start = performance.now();

  const response = await client.fetch(url, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
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

/**
 * Returns false if the page looks like a bot-detection challenge
 * rather than real content.
 */
export function isValidContent(html: string, statusCode: number): boolean {
  if (statusCode === 403 || statusCode === 429 || statusCode === 503) return false;
  if (statusCode >= 500) return false;
  // No length floor here. Legitimate tiny pages (example.com = 167 bytes)
  // were being flagged as blocked and re-routed all the way to the browser
  // tier. Status codes + block-phrase matches below are sufficient.
  if (!html) return false;

  const blockIndicators = [
    'cf-browser-verification',
    'challenge-platform',
    'ddos-protection',
    'captcha-delivery',
    'access denied',
    'please verify you are human',
    'just a moment',
    'enable javascript and cookies to continue',
    'to discuss automated access to amazon data',
    'errors/validatecaptcha',
  ];

  const lowerHtml = html.toLowerCase();
  return !blockIndicators.some((indicator) => lowerHtml.includes(indicator));
}
