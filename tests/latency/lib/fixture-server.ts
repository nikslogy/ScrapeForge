// Local stand-in for the target website (there is no internet access here).
// Pages are pre-encoded once so the server adds as little time as possible.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureServer {
  server: Server;
  /** Base URL without trailing slash, e.g. http://127.0.0.1:43123 */
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Serves `pages` (path → HTML) on 127.0.0.1 at an ephemeral port.
 * Unknown paths get 404; non-GET/HEAD methods get 405.
 */
export async function startFixtureServer(pages: Readonly<Record<string, string>>): Promise<FixtureServer> {
  const bodies = new Map<string, Buffer>();
  for (const [path, html] of Object.entries(pages)) {
    if (!path.startsWith('/')) throw new Error(`fixture path must start with "/": ${path}`);
    bodies.set(path, Buffer.from(html, 'utf8'));
  }

  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    // Query strings are ignored so callers can bust caches without new fixtures.
    const path = (req.url ?? '/').split('?')[0];
    const body = bodies.get(path);
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
