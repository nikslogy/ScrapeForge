import { FastifyInstance } from 'fastify';

export async function statusRoutes(app: FastifyInstance) {
  app.get('/status/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const { redis } = app;

    const result = await redis.get(`result:${jobId}`);
    if (result) {
      return reply.send({ status: 'completed', data: JSON.parse(result) });
    }

    const progress = await redis.get(`progress:${jobId}`);
    if (progress) {
      return reply.send({ status: 'processing', progress: JSON.parse(progress) });
    }

    return reply.status(404).send({ error: 'Job not found' });
  });
}
