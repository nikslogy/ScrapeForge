import { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (request, reply) => {
    const { redis, pg } = app;
    const checks: Record<string, string> = {};

    try {
      await redis.ping();
      checks.redis = 'ok';
    } catch {
      checks.redis = 'unhealthy';
    }

    try {
      await pg.query('SELECT 1');
      checks.postgres = 'ok';
    } catch {
      checks.postgres = 'unhealthy';
    }

    const allHealthy = Object.values(checks).every(v => v === 'ok');

    return reply.status(allHealthy ? 200 : 503).send({
      status: allHealthy ? 'healthy' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    });
  });
}
