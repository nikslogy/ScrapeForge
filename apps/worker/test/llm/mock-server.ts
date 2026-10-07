// Local HTTP server that stands in for provider APIs (no network access).

import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  rawBody: string;
  body: Record<string, unknown>;
}

export type MockHandler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

export interface MockServer {
  baseUrl: string;
  requests: RecordedRequest[];
  handle(handler: MockHandler): void;
  close(): Promise<void>;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
}

export async function startMockServer(): Promise<MockServer> {
  let handler: MockHandler = (_req, res) => sendJson(res, 500, { error: 'no handler' });
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      const recorded: RecordedRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, rawBody, body };
      requests.push(recorded);
      Promise.resolve(handler(recorded, res)).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'handler failed' });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    handle(h) {
      handler = h;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** OpenAI-style chat completion body. */
export function chatCompletion(
  content: string | null,
  opts: { finish?: string | null; usage?: Record<string, unknown>; model?: string; provider?: string } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: 'gen-1',
    object: 'chat.completion',
    model: opts.model ?? 'upstream/model-1',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: opts.finish === undefined ? 'stop' : opts.finish }],
    usage: opts.usage ?? { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  };
  if (opts.provider) body.provider = opts.provider;
  return body;
}

/** Gemini generateContent body. */
export function geminiResponse(
  parts: Array<{ text: string; thought?: boolean }>,
  opts: { finish?: string; usage?: Record<string, unknown>; modelVersion?: string } = {},
): Record<string, unknown> {
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: opts.finish ?? 'STOP', index: 0 }],
    usageMetadata: opts.usage ?? { promptTokenCount: 200, candidatesTokenCount: 40, totalTokenCount: 240 },
    modelVersion: opts.modelVersion ?? 'gemini-2.5-flash-001',
  };
}
