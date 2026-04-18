import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Redis } from 'ioredis';

/**
 * SSE streaming endpoint: GET /v1/scrape/stream?jobId=xxx
 *
 * Subscribes to the Redis pub/sub channel `sse:{jobId}` and forwards
 * events to the client as Server-Sent Events.
 *
 * Event types: headers, content, extraction, complete, error
 */
export async function ssePlugin(app: FastifyInstance) {
  app.get('/scrape/stream', async (request: FastifyRequest, reply: FastifyReply) => {
    const { jobId } = request.query as { jobId?: string };
    if (!jobId) {
      return reply.status(400).send({ error: 'jobId query parameter is required' });
    }

    reply.hijack();

    const origin = request.headers.origin || '*';
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
    });

    reply.raw.write(`:ok\n\n`);

    const existingResult = await app.redis.get(`result:${jobId}`);
    if (existingResult) {
      const parsed = JSON.parse(existingResult);
      writeSseEvent(reply, parsed.status === 'failed' ? 'error' : 'complete', parsed);
      reply.raw.end();
      return;
    }

    const subscriber = new Redis(
      app.redis.options.port ?? 6379,
      app.redis.options.host ?? 'localhost',
      { password: app.redis.options.password as string | undefined },
    );

    const channel = `sse:${jobId}`;
    await subscriber.subscribe(channel);

    let closed = false;
    const timeout = setTimeout(() => {
      if (!closed) {
        writeSseEvent(reply, 'error', { error: 'Stream timeout' });
        cleanup();
      }
    }, 60_000);

    subscriber.on('message', (_ch: string, message: string) => {
      if (closed) return;
      try {
        const { event, data } = JSON.parse(message);
        writeSseEvent(reply, event, data);

        if (event === 'complete' || event === 'error') {
          cleanup();
        }
      } catch {
        /* ignore malformed messages */
      }
    });

    request.raw.on('close', cleanup);

    function cleanup() {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      subscriber.unsubscribe(channel).catch(() => {});
      subscriber.disconnect();
      reply.raw.end();
    }
  });
}

function writeSseEvent(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
