// A throwaway Redis for the harness: never the developer's 6379, no
// persistence, and shut down at the end only if this run started it.

import { execFileSync } from 'node:child_process';
import { Redis } from 'ioredis';
import { sleep } from './runner.js';

export async function pingRedis(port: number, timeoutMs = 2000): Promise<boolean> {
  const client = new Redis(port, '127.0.0.1', {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    connectTimeout: 1000,
  });
  // Without a listener, a refused connection surfaces as an unhandled 'error'.
  client.on('error', () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  // connectTimeout only covers the TCP handshake: a listener that accepts
  // but never answers (not Redis) would otherwise hang here forever.
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const ping = (async () => {
    await client.connect();
    return (await client.ping()) === 'PONG';
  })().catch(() => false);
  try {
    return await Promise.race([ping, timeout]);
  } finally {
    clearTimeout(timer);
    client.disconnect();
  }
}

/** Starts redis-server on `port` unless one already answers. Returns true if this call started it. */
export async function ensureRedis(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError(`bad redis port ${port}`);
  if (await pingRedis(port)) return false;
  execFileSync('redis-server', [
    '--port', String(port),
    '--bind', '127.0.0.1',
    '--save', '',
    '--appendonly', 'no',
    '--daemonize', 'yes',
  ]);
  for (let i = 0; i < 50; i++) {
    if (await pingRedis(port)) return true;
    await sleep(100);
  }
  throw new Error(`redis-server on port ${port} did not come up within 5 s`);
}

export function shutdownRedis(port: number): void {
  try {
    execFileSync('redis-cli', ['-p', String(port), 'shutdown', 'nosave'], { stdio: 'ignore' });
  } catch {
    // redis-cli exits non-zero when the server closes the connection mid-reply.
  }
}

/** Parses `INFO <section>` text into key → value. */
export function parseInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}
