import { FastifyInstance } from 'fastify';
import { generateApiKey } from '@scrapeforge/shared';

export async function keyRotationRoutes(app: FastifyInstance) {
  app.post('/keys/rotate', async (request, reply) => {
    const user = request.user!;
    const { pg } = app;

    const { raw, hash, prefix } = generateApiKey();

    const old = await pg.query(
      `UPDATE api_keys SET is_active = false, revoked_at = NOW()
       WHERE id = $1 AND user_id = $2 AND is_active = true
       RETURNING id`,
      [user.apiKeyId, user.userId],
    );

    if (old.rowCount === 0) {
      return reply.status(404).send({ error: 'Current key not found or already revoked.' });
    }

    const row = await pg.query(
      `INSERT INTO api_keys (user_id, key_hash, key_prefix, name, rate_limit_per_minute)
       SELECT $1, $2, $3, CONCAT(name, ' (rotated)'), rate_limit_per_minute
       FROM api_keys WHERE id = $4
       RETURNING id`,
      [user.userId, hash, prefix, user.apiKeyId],
    );

    return reply.status(200).send({
      message: 'Key rotated. The old key is now deactivated.',
      key: raw,
      keyId: row.rows[0].id,
      prefix,
    });
  });
}
