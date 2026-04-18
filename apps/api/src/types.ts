import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Queue, QueueEvents } from 'bullmq';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
    pg: Pool;
    queues: {
      realtime: Queue;
      standard: Queue;
      batch: Queue;
      background: Queue;
    };
    queueEvents: {
      realtime: QueueEvents;
    };
  }

  interface FastifyRequest {
    user?: {
      userId: string;
      apiKeyId: string;
      plan: string;
      rateLimit: number;
    };
  }
}
