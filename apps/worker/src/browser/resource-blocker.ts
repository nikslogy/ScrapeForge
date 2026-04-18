import type { Page } from 'patchright';

const BLOCKED_RESOURCE_TYPES = new Set([
  'media', 'font', 'manifest', 'prefetch',
]);

const BLOCKED_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com',
  'facebook.net', 'doubleclick.net', 'hotjar.com',
  'segment.com', 'mixpanel.com', 'amplitude.com',
  'adservice.google.com', 'pagead2.googlesyndication.com',
  'cdn.jsdelivr.net/npm/cookieconsent',
  'ads.', 'tracking.',
];

export async function installResourceBlocker(page: Page): Promise<void> {
  await page.route('**/*', (route) => {
    const req = route.request();
    const resourceType = req.resourceType();
    const reqUrl = req.url();

    // Always allow document, script, xhr, fetch — needed for SPA content loading
    if (['document', 'script', 'xhr', 'fetch', 'stylesheet'].includes(resourceType)) {
      if (BLOCKED_DOMAINS.some((d) => reqUrl.includes(d))) {
        return route.abort();
      }
      return route.continue();
    }

    if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
      return route.abort();
    }
    if (BLOCKED_DOMAINS.some((d) => reqUrl.includes(d))) {
      return route.abort();
    }
    return route.continue();
  });
}
