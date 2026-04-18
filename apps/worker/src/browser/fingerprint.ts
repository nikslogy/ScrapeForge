import crypto from 'node:crypto';

export interface BrowserFingerprint {
  userAgent: string;
  viewport: { width: number; height: number };
  locale: string;
  timezoneId: string;
  platform: string;
  screenSize: { width: number; height: number };
  colorDepth: number;
  deviceScaleFactor: number;
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 2560, height: 1440 },
];

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Denver',
  'Europe/London',
  'Europe/Berlin',
];

const LOCALES = ['en-US', 'en-GB', 'en-US', 'en-US']; // weighted towards en-US

function pick<T>(arr: T[]): T {
  return arr[crypto.randomInt(arr.length)];
}

/**
 * Generates an internally consistent fingerprint.
 * The UA, platform, viewport, and timezone all align so
 * fingerprint-checking scripts don't see contradictions.
 */
export function generateFingerprint(): BrowserFingerprint {
  const ua = pick(USER_AGENTS);
  const viewport = pick(VIEWPORTS);
  const timezoneId = pick(TIMEZONES);
  const locale = pick(LOCALES);

  let platform = 'Win32';
  if (ua.includes('Macintosh')) platform = 'MacIntel';
  else if (ua.includes('Linux')) platform = 'Linux x86_64';

  const screenSize = {
    width: viewport.width + (viewport.width < 2000 ? crypto.randomInt(0, 200) : 0),
    height: viewport.height + crypto.randomInt(40, 120),
  };

  return {
    userAgent: ua,
    viewport,
    locale,
    timezoneId,
    platform,
    screenSize,
    colorDepth: 24,
    deviceScaleFactor: viewport.width > 1920 ? 2 : 1,
  };
}

/**
 * Returns Patchright-compatible context options
 * for applying a fingerprint to a new browser context.
 */
export function toContextOptions(fp: BrowserFingerprint) {
  return {
    userAgent: fp.userAgent,
    viewport: fp.viewport,
    locale: fp.locale,
    timezoneId: fp.timezoneId,
    screen: fp.screenSize,
    colorScheme: 'light' as const,
    deviceScaleFactor: fp.deviceScaleFactor,
  };
}
