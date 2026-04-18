import { createHmac, randomUUID } from 'node:crypto';

const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1_000;
const WEBHOOK_TIMEOUT_MS = 10_000;

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

/**
 * Deliver a signed webhook with exponential backoff retry.
 *
 * Signature: HMAC-SHA256 of the raw JSON body using the API key as secret.
 * Header: `X-ScrapeForge-Signature: sha256=<hex>`
 */
export async function deliverWebhook(
  webhookUrl: string,
  jobId: string,
  data: Record<string, unknown>,
  event: 'scrape.completed' | 'scrape.failed',
  signingSecret: string,
): Promise<WebhookDeliveryResult> {
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

  const deliveryId = randomUUID();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ScrapeForge-Signature': `sha256=${signature}`,
          'X-ScrapeForge-Delivery': deliveryId,
          'X-ScrapeForge-Event': event,
          'User-Agent': 'ScrapeForge-Webhook/1.0',
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (res.ok) {
        console.log(`[Webhook] Delivered ${event} for ${jobId} → ${res.status} (attempt ${attempt})`);
        return { delivered: true, attempts: attempt, statusCode: res.status };
      }

      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        console.warn(`[Webhook] Client error ${res.status} for ${jobId}, not retrying`);
        return {
          delivered: false,
          attempts: attempt,
          statusCode: res.status,
          error: `HTTP ${res.status}`,
        };
      }

      console.warn(`[Webhook] ${res.status} for ${jobId}, attempt ${attempt}/${MAX_RETRIES}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Webhook] Error for ${jobId}, attempt ${attempt}/${MAX_RETRIES}: ${msg}`);

      if (attempt === MAX_RETRIES) {
        return { delivered: false, attempts: attempt, error: msg };
      }
    }

    const delay = INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
    await new Promise((r) => setTimeout(r, delay));
  }

  return { delivered: false, attempts: MAX_RETRIES, error: 'Exhausted retries' };
}
