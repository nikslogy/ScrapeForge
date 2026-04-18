import { FastifyRequest, FastifyReply } from 'fastify';

const PUBLIC_ROUTES = ['/health', '/metrics', '/docs', '/docs/json'];

export async function rateLimiter(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (PUBLIC_ROUTES.some((r) => request.url.startsWith(r))) return;
  if (!request.user) return;

  const { rateLimit, apiKeyId } = request.user;
  if (!rateLimit || rateLimit <= 0) return;

  const { redis } = request.server;
  const key = `rl:${apiKeyId}`;
  const now = Date.now();
  const window = 60_000;

  const multi = redis.multi();
  multi.zremrangebyscore(key, 0, now - window);
  multi.zadd(key, now.toString(), `${now}:${Math.random()}`);
  multi.zcard(key);
  multi.pexpire(key, window);
  const results = await multi.exec();

  const count = (results?.[2]?.[1] as number) || 0;

  reply.header('X-RateLimit-Limit', rateLimit);
  reply.header('X-RateLimit-Remaining', Math.max(0, rateLimit - count));
  reply.header('X-RateLimit-Reset', Math.ceil((now + window) / 1000));

  if (count > rateLimit) {
    return reply.status(429).send({
      error: 'Rate limit exceeded. Upgrade your plan or wait.',
      retryAfter: Math.ceil(window / 1000),
    });
  }
}
