// Tracker and resource-type blocking rules. Applied by the browser tiers'
// single route handler together with the SSRF check (see outbound-guard.ts),
// so a page can never get resource blocking without the guard.

const BLOCKED_RESOURCE_TYPES = new Set([
  'media', 'font', 'manifest', 'prefetch',
]);

// Always allowed by type (still subject to the domain list): SPAs need these
// to load their content.
const CONTENT_RESOURCE_TYPES = new Set([
  'document', 'script', 'xhr', 'fetch', 'stylesheet',
]);

const BLOCKED_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com',
  'facebook.net', 'doubleclick.net', 'hotjar.com',
  'segment.com', 'mixpanel.com', 'amplitude.com',
  'adservice.google.com', 'pagead2.googlesyndication.com',
  'cdn.jsdelivr.net/npm/cookieconsent',
  'ads.', 'tracking.',
];

/** True when a request is a tracker or a resource type the scrape does not need. */
export function shouldBlockResource(resourceType: string, url: string): boolean {
  if (BLOCKED_DOMAINS.some((d) => url.includes(d))) return true;
  if (CONTENT_RESOURCE_TYPES.has(resourceType)) return false;
  return BLOCKED_RESOURCE_TYPES.has(resourceType);
}
