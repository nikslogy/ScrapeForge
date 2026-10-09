// HTTP tiers (Impit) connect through the local egress guard, so the address
// connected to is the address the outbound policy checked (finding
// impit-dns-rebinding). Names here exist only in the test policy's DNS: the
// system resolver Impit would use on its own cannot resolve them, so a
// successful fetch proves the connection went through the guard's checked
// resolution, and a rebinding answer at connect time is refused.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { Impit } from 'impit';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboundBlockedError, setOutboundPolicyForTests } from '@scrapeforge/shared';
import { tier1Fetch } from '../../src/engine/tier1-http.js';
import { tier2Fetch } from '../../src/engine/tier2-tls.js';
import { egressGuard, egressProxyUrl, throughEgressGuard } from '../../src/net/egress.js';
import { INTERNAL_IP, PUBLIC_IP, html, routes, startServer, useFixturePolicy, type FixtureServer } from './fixtures.js';

let site: FixtureServer;
let internal: FixtureServer;

beforeAll(async () => {
  internal = await startServer(INTERNAL_IP, html('<p>INTERNAL SECRET</p>'));
  site = await startServer(PUBLIC_IP, routes({ '/page': html('<p>PUBLIC PAGE</p>') }));
});

afterAll(async () => {
  await Promise.all([site?.close(), internal?.close()]);
});

beforeEach(() => {
  site.requests.length = 0;
  internal.requests.length = 0;
});

afterEach(() => setOutboundPolicyForTests(null));

describe.each([
  ['tier1', tier1Fetch],
  ['tier2', tier2Fetch],
] as const)('%s through the egress guard', (_name, fetchTier) => {
  it('connects to the address the policy resolved and checked', async () => {
    useFixturePolicy(async (host) => (host === 'shop.test' ? [PUBLIC_IP] : Promise.reject(new Error('ENOTFOUND'))));
    const r = await fetchTier(`http://shop.test:${site.port}/page`);
    expect(r.statusCode).toBe(200);
    expect(r.html).toContain('PUBLIC PAGE');
    expect(site.requests.map((q) => [q.url, q.headers.host])).toEqual([['/page', `shop.test:${site.port}`]]);
  });

  it('refuses a name that rebinds to a private address between the check and the connect', async () => {
    // First answer (the pre-request check, cached for 30 s): public. Every
    // later answer: the internal server's address, on the same port.
    let lookups = 0;
    useFixturePolicy(async () => (lookups++ === 0 ? [PUBLIC_IP] : [INTERNAL_IP]));
    const err = await fetchTier(`http://rebind.test:${internal.port}/secret`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutboundBlockedError);
    expect(internal.requests).toEqual([]);
    expect(lookups).toBe(2);
  });

  it('still refuses a blocked destination before any connection', async () => {
    useFixturePolicy();
    const guard = await egressGuard();
    const before = guard.stats();
    await expect(fetchTier(`${internal.origin}/secret`)).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(internal.requests).toEqual([]);
    expect(guard.stats().refused).toBe(before.refused);
  });
});

describe('upstream proxy configured', () => {
  let upstream: FixtureServer;

  beforeAll(async () => {
    upstream = await startServer(PUBLIC_IP, html('<p>VIA UPSTREAM</p>'));
  });
  afterAll(() => upstream.close());

  it('sends the request to the upstream proxy, not the guard (it resolves outside our network)', async () => {
    useFixturePolicy();
    const guard = await egressGuard();
    const before = guard.stats();
    const r = await tier1Fetch(`${site.origin}/page`, { proxy: upstream.origin });
    expect(r.html).toContain('VIA UPSTREAM');
    expect(guard.stats().requests).toBe(before.requests);
    expect(guard.stats().tunnels).toBe(before.tunnels);
  });
});

/** A throwaway self-signed certificate for `name`, or null without openssl. */
function selfSignedCert(name: string): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(os.tmpdir(), 'egress-tls-'));
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${name}`,
        '-addext', `subjectAltName=DNS:${name}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tls = selfSignedCert('secure.test');

// HTTPS goes through a CONNECT tunnel. The tiers verify certificates, so a
// client that accepts the test certificate stands in for them here.
describe.skipIf(!tls)('HTTPS through the egress guard (CONNECT)', () => {
  let server: https.Server;
  let tlsPort: number;
  const hits: string[] = [];

  beforeAll(async () => {
    server = https.createServer(tls!, (req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<p>TLS OK</p>');
    });
    await new Promise<void>((r) => server.listen(0, INTERNAL_IP, r));
    tlsPort = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('tunnels to the checked address and reports a connect-time refusal as OutboundBlockedError', async () => {
    // The server sits on the "internal" address; the policy says whether it may be reached.
    const proxyUrl = await egressProxyUrl();
    // A new client per case: a pooled connection is not checked again (it
    // stays bound to the address checked when it was opened).
    const client = () => new Impit({ proxyUrl, ignoreTlsErrors: true, followRedirects: false });
    const url = new URL(`https://secure.test:${tlsPort}/page`);

    setOutboundPolicyForTests({ lookup: async () => [INTERNAL_IP], isBlocked: () => false });
    const ok = await throughEgressGuard(url, () => client().fetch(url.href));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('TLS OK');
    expect(hits).toEqual(['/page']);

    useFixturePolicy(async () => [INTERNAL_IP]); // 127.0.0.2 is blocked under the fixture policy
    const err = await throughEgressGuard(url, () => client().fetch(url.href)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutboundBlockedError);
    expect(hits).toEqual(['/page']);
  });
});
