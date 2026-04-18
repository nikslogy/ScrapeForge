import { FastifyRequest, FastifyReply } from 'fastify';
import { hashApiKey } from '@scrapeforge/shared';

const PUBLIC_ROUTES = ['/health', '/metrics', '/docs', '/openapi.json', '/v1/scrape/stream'];

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (PUBLIC_ROUTES.some(r => request.url.startsWith(r))) return;

  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({
      error: 'Missing API key. Pass it as: Authorization: Bearer sf_live_...',
    });
  }

  const apiKey = authHeader.slice(7);
  if (!apiKey.startsWith('sf_live_')) {
    return reply.status(401).send({ error: 'Invalid API key format.' });
  }

  const keyHash = hashApiKey(apiKey);
  const { pg } = request.server;

  const result = await pg.query(
    `SELECT ak.id, ak.user_id, ak.rate_limit_per_minute, ak.is_active, u.plan
     FROM api_keys ak JOIN users u ON ak.user_id = u.id
     WHERE ak.key_hash = $1`,
    [keyHash],
  );

  if (result.rows.length === 0 || !result.rows[0].is_active) {
    return reply.status(401).send({ error: 'Invalid or deactivated API key.' });
  }

  const keyData = result.rows[0];

  request.user = {
    userId: keyData.user_id,
    apiKeyId: keyData.id,
    plan: keyData.plan,
    rateLimit: keyData.rate_limit_per_minute,
  };

  pg.query(
    'UPDATE api_keys SET last_used_at = NOW() WHERE id = $1',
    [keyData.id],
  ).catch(() => {});
}
