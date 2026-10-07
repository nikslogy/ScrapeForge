// Local fixture servers and outbound policy for SSRF tests. No internet.
//
// Policy used by these tests: 127.0.0.1 counts as "public" so fixture
// servers there are reachable; everything else keeps the strict default, so
// 127.0.0.2 (a second loopback address, where the "internal" server listens)
// stays blocked. Fake hostnames resolve through FAKE_DNS.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isBlockedAddress, setOutboundPolicyForTests } from '@scrapeforge/shared';

export const PUBLIC_IP = '127.0.0.1';
export const INTERNAL_IP = '127.0.0.2';

export const FAKE_DNS: Record<string, string[]> = {
  'public.test': [PUBLIC_IP],
  'internal.test': ['10.0.0.1'],
  'mixed.test': [PUBLIC_IP, '169.254.169.254'],
};

export function fakeLookup(hostname: string): Promise<string[]> {
  const answers = FAKE_DNS[hostname];
  if (!answers) {
    return Promise.reject(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
  }
  return Promise.resolve([...answers]);
}

export function useFixturePolicy(lookup: (host: string) => Promise<string[]> = fakeLookup): void {
  setOutboundPolicyForTests({
    lookup,
    isBlocked: (ip) => ip !== PUBLIC_IP && isBlockedAddress(ip),
  });
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface FixtureServer {
  origin: string;
  port: number;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

export async function startServer(host: string, handler: Handler): Promise<FixtureServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${host}:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Serves `routes[path]`; anything else is 404. */
export function routes(table: Record<string, Handler>): Handler {
  return (req, res, body) => {
    const path = (req.url ?? '/').split('?')[0];
    const route = table[path];
    if (route) return route(req, res, body);
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  };
}

export const redirect =
  (status: number, location: string): Handler =>
  (_req, res) => {
    res.writeHead(status, { location });
    res.end();
  };

export const html =
  (body: string, status = 200): Handler =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  };
