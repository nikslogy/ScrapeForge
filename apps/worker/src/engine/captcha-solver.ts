import type { Page } from 'patchright';

export interface CaptchaResult {
  solved: boolean;
  type: CaptchaType | null;
  cost: number;
  latencyMs: number;
}

type CaptchaType = 'recaptcha-v2' | 'recaptcha-v3' | 'hcaptcha' | 'turnstile';

const COST_PER_SOLVE: Record<CaptchaType, number> = {
  'recaptcha-v2': 0.003,
  'recaptcha-v3': 0.004,
  'hcaptcha':     0.003,
  'turnstile':    0.002,
};

const CAPSOLVER_ENDPOINT = 'https://api.capsolver.com/createTask';
const POLL_ENDPOINT = 'https://api.capsolver.com/getTaskResult';

/**
 * Detects and solves CAPTCHAs on the current page using CapSolver.
 * Returns early with { solved: false } if no CAPTCHA is found or
 * if the API key is not configured.
 */
export async function solveCaptcha(page: Page): Promise<CaptchaResult> {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) return { solved: false, type: null, cost: 0, latencyMs: 0 };

  const start = Date.now();

  const detected = await detectCaptchaType(page);
  if (!detected) return { solved: false, type: null, cost: 0, latencyMs: 0 };

  const { type, siteKey } = detected;
  const pageUrl = page.url();

  try {
    const token = await solveWithCapsolver(apiKey, type, siteKey, pageUrl);
    await injectToken(page, type, token);

    return {
      solved: true,
      type,
      cost: COST_PER_SOLVE[type],
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    console.error(`[CAPTCHA] Failed to solve ${type}:`, (err as Error).message);
    return { solved: false, type, cost: 0, latencyMs: Date.now() - start };
  }
}

// ── Detection ───────────────────────────────────────────

interface DetectedCaptcha {
  type: CaptchaType;
  siteKey: string;
}

async function detectCaptchaType(page: Page): Promise<DetectedCaptcha | null> {
  return page.evaluate(() => {
    // reCAPTCHA v2/v3
    const recaptchaEl = document.querySelector('[data-sitekey]');
    if (recaptchaEl) {
      const siteKey = recaptchaEl.getAttribute('data-sitekey') || '';
      const isV3 =
        recaptchaEl.getAttribute('data-size') === 'invisible' ||
        !!document.querySelector('script[src*="recaptcha/api.js?render="]');
      return { type: isV3 ? 'recaptcha-v3' : 'recaptcha-v2', siteKey } as const;
    }

    // hCaptcha
    const hcaptchaEl = document.querySelector('[data-sitekey].h-captcha, .h-captcha[data-sitekey]');
    if (hcaptchaEl) {
      return { type: 'hcaptcha', siteKey: hcaptchaEl.getAttribute('data-sitekey') || '' } as const;
    }

    // Cloudflare Turnstile
    const turnstileEl = document.querySelector('.cf-turnstile[data-sitekey]');
    if (turnstileEl) {
      return { type: 'turnstile', siteKey: turnstileEl.getAttribute('data-sitekey') || '' } as const;
    }

    // Script-based detection fallback
    const scripts = Array.from(document.querySelectorAll('script[src]'));
    for (const s of scripts) {
      const src = (s as HTMLScriptElement).src;
      if (src.includes('recaptcha')) {
        const m = src.match(/render=([A-Za-z0-9_-]+)/);
        return { type: 'recaptcha-v3', siteKey: m?.[1] || '' } as const;
      }
      if (src.includes('hcaptcha.com')) {
        return { type: 'hcaptcha', siteKey: '' } as const;
      }
      if (src.includes('challenges.cloudflare.com')) {
        return { type: 'turnstile', siteKey: '' } as const;
      }
    }

    return null;
  }) as Promise<DetectedCaptcha | null>;
}

// ── CapSolver integration ───────────────────────────────

const CAPSOLVER_TASK_TYPE: Record<CaptchaType, string> = {
  'recaptcha-v2': 'ReCaptchaV2TaskProxyLess',
  'recaptcha-v3': 'ReCaptchaV3TaskProxyLess',
  'hcaptcha':     'HCaptchaTaskProxyLess',
  'turnstile':    'AntiTurnstileTaskProxyLess',
};

async function solveWithCapsolver(
  apiKey: string,
  type: CaptchaType,
  siteKey: string,
  pageUrl: string,
): Promise<string> {
  const taskPayload: Record<string, unknown> = {
    type: CAPSOLVER_TASK_TYPE[type],
    websiteURL: pageUrl,
    websiteKey: siteKey,
  };

  if (type === 'recaptcha-v3') {
    taskPayload.pageAction = 'verify';
    taskPayload.minScore = 0.7;
  }

  const createRes = await fetch(CAPSOLVER_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: apiKey, task: taskPayload }),
  });

  const createJson = (await createRes.json()) as any;
  if (createJson.errorId && createJson.errorId !== 0) {
    throw new Error(`CapSolver create: ${createJson.errorDescription || createJson.errorCode}`);
  }
  const taskId: string = createJson.taskId;

  // Poll for result (max ~120 seconds)
  for (let i = 0; i < 40; i++) {
    await sleep(3000);

    const pollRes = await fetch(POLL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });

    const pollJson = (await pollRes.json()) as any;
    if (pollJson.status === 'ready') {
      return (
        pollJson.solution?.gRecaptchaResponse ||
        pollJson.solution?.token ||
        pollJson.solution?.text ||
        ''
      );
    }
    if (pollJson.errorId && pollJson.errorId !== 0) {
      throw new Error(`CapSolver poll: ${pollJson.errorDescription || pollJson.errorCode}`);
    }
  }

  throw new Error('CapSolver timeout');
}

// ── Token injection ─────────────────────────────────────

async function injectToken(page: Page, type: CaptchaType, token: string): Promise<void> {
  if (type === 'recaptcha-v2' || type === 'recaptcha-v3') {
    await page.evaluate((t) => {
      const el = document.querySelector('#g-recaptcha-response') as HTMLTextAreaElement;
      if (el) { el.value = t; el.style.display = 'block'; }
      if (typeof (window as any).___grecaptcha_cfg !== 'undefined') {
        const clients = (window as any).___grecaptcha_cfg?.clients;
        if (clients) {
          for (const c of Object.values(clients) as any[]) {
            const cb = c?.rresp?.callback || c?.callback;
            if (typeof cb === 'function') cb(t);
          }
        }
      }
    }, token);
    return;
  }

  if (type === 'hcaptcha') {
    await page.evaluate((t) => {
      const el = document.querySelector('[name="h-captcha-response"]') as HTMLTextAreaElement;
      if (el) el.value = t;
      const iframe = document.querySelector('iframe[src*="hcaptcha.com"]');
      if (iframe) (iframe as any).contentWindow?.postMessage({ type: 'response', token: t }, '*');
    }, token);
    return;
  }

  if (type === 'turnstile') {
    await page.evaluate((t) => {
      const el = document.querySelector('[name="cf-turnstile-response"]') as HTMLInputElement;
      if (el) el.value = t;
      if (typeof (window as any).turnstile?.getResponse === 'function') {
        const widgetId = (window as any).turnstile?.getResponse();
        if (widgetId) (window as any).turnstile.remove(widgetId);
      }
    }, token);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
