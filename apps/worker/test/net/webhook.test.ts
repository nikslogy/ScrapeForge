import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setOutboundPolicyForTests } from '@scrapeforge/shared';
import { deliverWebhook, type WebhookDeliveryOptions } from '../../src/delivery/webhook.js';
import {
  FAKE_DNS,
  INTERNAL_IP,
  PUBLIC_IP,
  fakeLookup,
  html,
  redirect,
  routes,
  startServer,
  useFixturePolicy,
  type FixtureServer,
} from './fixtures.js';

const BLOCKED = 'Webhook URL targets a private or reserved address range.';
const FAST: WebhookDeliveryOptions = { initialDelayMs: 1, timeoutMs: 2_000 };

let hooks: FixtureServer;
let internal: FixtureServer;
let flaky = 0;

beforeAll(async () => {
  internal = await startServer(INTERNAL_IP, html('internal'));
  hooks = await startServer(
    PUBLIC_IP,
    routes({
      '/ok': html('thanks'),
      '/created': html('', 201),
      '/redirect': (_req, res) => redirect(302, `http://${PUBLIC_IP}:${hooks.port}/ok`)(_req, res, ''),
      '/redirect-internal': (_req, res) => redirect(307, `${internal.origin}/`)(_req, res, ''),
      '/gone': html('gone', 410),
      '/busy': html('busy', 503),
      '/rate-limited': html('slow down', 429),
      '/flaky': (_req, res) => html('', flaky++ < 2 ? 502 : 200)(_req, res, ''),
      '/hang': () => {
        /* never responds */
      },
    }),
  );
  FAKE_DNS['hooks.test'] = [PUBLIC_IP];
});

afterAll(async () => {
  delete FAKE_DNS['hooks.test'];
  await Promise.all([hooks?.close(), internal?.close()]);
});

beforeEach(() => {
  useFixturePolicy();
  hooks.requests.length = 0;
  internal.requests.length = 0;
  flaky = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setOutboundPolicyForTests(null);
  vi.restoreAllMocks();
});

const send = (url: string, options: WebhookDeliveryOptions = FAST) =>
  deliverWebhook(url, 'job_1', { ok: true }, 'scrape.completed', 'sk_test_secret', options);

describe('deliverWebhook', () => {
  it('delivers a signed POST to a public host (resolved through the guarded lookup)', async () => {
    const r = await send(`http://hooks.test:${hooks.port}/ok`);
    expect(r).toEqual({ delivered: true, attempts: 1, statusCode: 200 });
    const [req] = hooks.requests;
    expect(req.method).toBe('POST');
    expect(req.headers['content-type']).toBe('application/json');
    const expected = createHmac('sha256', 'sk_test_secret').update(req.body).digest('hex');
    expect(req.headers['x-scrapeforge-signature']).toBe(`sha256=${expected}`);
    expect(JSON.parse(req.body)).toMatchObject({ event: 'scrape.completed', jobId: 'job_1', data: { ok: true } });
  });

  it('treats any 2xx as delivered', async () => {
    expect((await send(`${hooks.origin}/created`)).delivered).toBe(true);
  });

  it.each([
    () => `${internal.origin}/hook`,
    () => `http://[::ffff:${INTERNAL_IP}]:${internal.port}/hook`,
    () => 'http://internal.test/hook',
    () => 'http://mixed.test/hook',
    () => 'http://localhost:9999/hook',
    () => 'http://169.254.169.254/latest/meta-data/',
    () => 'file:///etc/passwd',
  ])('refuses blocked destination #%# without retrying', async (url) => {
    const r = await send(url());
    expect(r).toEqual({ delivered: false, attempts: 1, error: BLOCKED });
    expect(internal.requests).toHaveLength(0);
  });

  it('does not follow redirects and does not retry them', async () => {
    const r = await send(`${hooks.origin}/redirect`);
    expect(r).toEqual({
      delivered: false,
      attempts: 1,
      statusCode: 302,
      error: 'Redirect not followed (HTTP 302)',
    });
    expect(hooks.requests.map((q) => q.url)).toEqual(['/redirect']);
  });

  it('does not follow a redirect to an internal address', async () => {
    const r = await send(`${hooks.origin}/redirect-internal`);
    expect(r.statusCode).toBe(307);
    expect(r.delivered).toBe(false);
    expect(internal.requests).toHaveLength(0);
  });

  it('refuses a host that re-resolves to a blocked address after the pre-check (DNS rebinding)', async () => {
    let calls = 0;
    useFixturePolicy(async (host) => {
      if (host !== 'rebind.test') return fakeLookup(host);
      return calls++ === 0 ? [PUBLIC_IP] : [INTERNAL_IP];
    });
    const r = await send(`http://rebind.test:${internal.port}/hook`);
    expect(r).toEqual({ delivered: false, attempts: 1, error: BLOCKED });
    expect(calls).toBe(2);
    expect(internal.requests).toHaveLength(0);
  });

  it('does not retry other 4xx responses', async () => {
    expect(await send(`${hooks.origin}/gone`)).toEqual({
      delivered: false,
      attempts: 1,
      statusCode: 410,
      error: 'HTTP 410',
    });
  });

  it.each(['/busy', '/rate-limited'])('retries %s and reports the last status', async (path) => {
    const r = await send(`${hooks.origin}${path}`);
    expect(r.delivered).toBe(false);
    expect(r.attempts).toBe(3);
    expect(r.statusCode).toBe(path === '/busy' ? 503 : 429);
    expect(hooks.requests).toHaveLength(3);
  });

  it('succeeds after transient server errors', async () => {
    expect(await send(`${hooks.origin}/flaky`)).toEqual({ delivered: true, attempts: 3, statusCode: 200 });
  });

  it('retries DNS failures and reports them', async () => {
    const r = await send('http://nowhere.test/hook');
    expect(r.delivered).toBe(false);
    expect(r.attempts).toBe(3);
    expect(r.error).toMatch(/^DNS lookup failed for nowhere\.test/);
  });

  it('gives up on a hung receiver after the timeout', async () => {
    const t0 = performance.now();
    const r = await send(`${hooks.origin}/hang`, { initialDelayMs: 1, timeoutMs: 200, maxRetries: 1 });
    expect(r.delivered).toBe(false);
    expect(r.attempts).toBe(1);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});
