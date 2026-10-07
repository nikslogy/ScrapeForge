import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {
  assertPublicUrl,
  guardedLookup,
  isOutboundBlockedError,
} from '@scrapeforge/shared';

const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1_000;
const WEBHOOK_TIMEOUT_MS = 10_000;

const BLOCKED_ERROR = 'Webhook URL targets a private or reserved address range.';

interface WebhookPayload {
  event: 'scrape.completed' | 'scrape.failed';
  jobId: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface WebhookDeliveryResult {
  delivered: boolean;
  attempts: number;
  statusCode?: number;
  error?: string;
}

/** Overrides for tests; production uses the defaults. */
export interface WebhookDeliveryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  timeoutMs?: number;
}

/**
 * POST once and return the status code. Uses node:http(s) rather than fetch
 * for two reasons: it never follows redirects, and `guardedLookup` checks the
 * addresses it actually connects to, so a webhook host cannot pass the
 * pre-check and then re-resolve to an internal address (DNS rebinding).
 */
function postOnce(
  url: URL,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<number> {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
        lookup: guardedLookup,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        // Only the status matters; dropping the body keeps a slow or huge
        // response from holding the attempt open.
        res.destroy();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Deliver a signed webhook with exponential backoff retry.
 *
 * Signature: HMAC-SHA256 of the raw JSON body using the API key as secret.
 * Header: `X-ScrapeForge-Signature: sha256=<hex>`
 *
 * The URL is re-checked against the SSRF policy before every attempt. A
 * blocked destination or a redirect (never followed) fails without retry.
 */
export async function deliverWebhook(
  webhookUrl: string,
  jobId: string,
  data: Record<string, unknown>,
  event: 'scrape.completed' | 'scrape.failed',
  signingSecret: string,
  deliveryOptions: WebhookDeliveryOptions = {},
): Promise<WebhookDeliveryResult> {
  const maxRetries = deliveryOptions.maxRetries ?? MAX_RETRIES;
  const initialDelayMs = deliveryOptions.initialDelayMs ?? INITIAL_DELAY_MS;
  const timeoutMs = deliveryOptions.timeoutMs ?? WEBHOOK_TIMEOUT_MS;

  const payload: WebhookPayload = {
    event,
    jobId,
    data,
    timestamp: new Date().toISOString(),
  };

  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', signingSecret)
    .update(body)
    .digest('hex');

  const headers = {
    'Content-Type': 'application/json',
    'X-ScrapeForge-Signature': `sha256=${signature}`,
    'X-ScrapeForge-Delivery': randomUUID(),
    'X-ScrapeForge-Event': event,
    'User-Agent': 'ScrapeForge-Webhook/1.0',
  };

  let lastError = 'Exhausted retries';
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const target = await assertPublicUrl(webhookUrl);
      const status = await postOnce(target, body, headers, timeoutMs);

      if (status >= 200 && status < 300) {
        console.log(`[Webhook] Delivered ${event} for ${jobId} → ${status} (attempt ${attempt})`);
        return { delivered: true, attempts: attempt, statusCode: status };
      }

      if (status >= 300 && status < 400) {
        console.warn(`[Webhook] Redirect ${status} for ${jobId}, not following`);
        return {
          delivered: false,
          attempts: attempt,
          statusCode: status,
          error: `Redirect not followed (HTTP ${status})`,
        };
      }

      if (status >= 400 && status < 500 && status !== 429) {
        console.warn(`[Webhook] Client error ${status} for ${jobId}, not retrying`);
        return {
          delivered: false,
          attempts: attempt,
          statusCode: status,
          error: `HTTP ${status}`,
        };
      }

      lastStatus = status;
      lastError = `HTTP ${status}`;
      console.warn(`[Webhook] ${status} for ${jobId}, attempt ${attempt}/${maxRetries}`);
    } catch (err) {
      // Raised by the pre-check, or by guardedLookup when the host
      // re-resolved to a blocked address after the pre-check.
      if (isOutboundBlockedError(err)) {
        console.warn(`[Webhook] Blocked destination for ${jobId}, not retrying`);
        return { delivered: false, attempts: attempt, error: BLOCKED_ERROR };
      }
      lastStatus = undefined;
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(`[Webhook] Error for ${jobId}, attempt ${attempt}/${maxRetries}: ${lastError}`);
    }

    if (attempt < maxRetries) {
      const delay = initialDelayMs * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return { delivered: false, attempts: maxRetries, statusCode: lastStatus, error: lastError };
}
