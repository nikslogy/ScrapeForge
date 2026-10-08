// Minimal local HTTP server for the fetch-path tests and bench. Routes map a
// path to a body, optionally answered after a delay; every request is logged
// so tests can count fetches.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Route {
  body: string;
  status?: number;
  contentType?: string;
  /** Answer after this many ms (the connection stays open meanwhile). */
  delayMs?: number;
  /** Extra response headers (e.g. Location for a redirect). */
  headers?: Record<string, string>;
}

export interface LocalServer {
  origin: string;
  /** Request paths (without query) in arrival order. */
  hits: string[];
  count(path: string): number;
  close(): Promise<void>;
}

export async function startLocalServer(routes: Record<string, Route | string>): Promise<LocalServer> {
  const hits: string[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    hits.push(path);
    const entry = routes[path];
    const route: Route | undefined = typeof entry === 'string' ? { body: entry } : entry;
    const send = () => {
      if (!route) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
        return;
      }
      const body = Buffer.from(route.body, 'utf8');
      res.writeHead(route.status ?? 200, {
        'Content-Type': route.contentType ?? 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        ...route.headers,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (route?.delayMs) {
      const t = setTimeout(() => {
        timers.delete(t);
        send();
      }, route.delayMs);
      timers.add(t);
    } else {
      send();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    count: (p) => hits.filter((h) => h === p).length,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
