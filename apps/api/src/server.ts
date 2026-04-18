// Entry point: Fastify API server for ScrapeForge.
// (touched to pick up webhookUrl empty-string fix)
import './types.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { Queue, QueueEvents } from 'bullmq';
import { QUEUE_NAMES } from '@scrapeforge/shared';
import { scrapeRoutes } from './routes/scrape.js';
import { extractRoutes } from './routes/extract.js';
import { healthRoutes } from './routes/health.js';
import { statusRoutes } from './routes/status.js';
import { ssePlugin } from './plugins/sse.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimiter } from './middleware/rate-limiter.js';
import { keyRotationRoutes } from './routes/key-rotation.js';
import { registry, httpRequestsTotal, httpDuration } from './metrics.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import ScalarApiReference from '@scalar/fastify-api-reference';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty' }
      : undefined,
  },
  requestTimeout: 65_000,
  bodyLimit: 1_048_576,
});

// --- Connections ---
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const pg = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://scrapeforge:localdev123@localhost:5433/scrapeforge',
  max: 20,
  idleTimeoutMillis: 30_000,
});

// --- BullMQ ---
function parseBullConnection(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379'),
    password: parsed.password || undefined,
  };
}

const bullConnection = parseBullConnection(redisUrl);

const queues = {
  realtime:   new Queue(QUEUE_NAMES.SCRAPE_REALTIME,   { connection: bullConnection }),
  standard:   new Queue(QUEUE_NAMES.SCRAPE_STANDARD,   { connection: bullConnection }),
  batch:      new Queue(QUEUE_NAMES.SCRAPE_BATCH,      { connection: bullConnection }),
  background: new Queue(QUEUE_NAMES.SCRAPE_BACKGROUND, { connection: bullConnection }),
};

const queueEvents = {
  realtime: new QueueEvents(QUEUE_NAMES.SCRAPE_REALTIME, { connection: bullConnection }),
};

// --- Decorate Fastify ---
app.decorate('redis', redis);
app.decorate('pg', pg);
app.decorate('queues', queues);
app.decorate('queueEvents', queueEvents);

// --- Plugins ---
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
  : true;
await app.register(cors, { origin: allowedOrigins });

// --- Middleware ---
app.addHook('onRequest', authMiddleware);
app.addHook('onRequest', rateLimiter);

app.addHook('onResponse', (request, reply, done) => {
  const route = request.routeOptions?.url || request.url;
  httpRequestsTotal.inc({ method: request.method, route, status: reply.statusCode });
  httpDuration.observe(
    { method: request.method, route },
    reply.elapsedTime / 1000,
  );
  done();
});

// --- Metrics endpoint (no auth) ---
app.get('/metrics', async (_req, reply) => {
  reply.header('Content-Type', registry.contentType);
  return registry.metrics();
});

// --- API Docs ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const specCandidates = [
  resolve(__dirname, '../../../docs/openapi.yaml'),
  resolve(process.cwd(), 'docs/openapi.yaml'),
  resolve(process.cwd(), '../../docs/openapi.yaml'),
];
let openApiSpec: Record<string, unknown> = {};
for (const candidate of specCandidates) {
  try {
    openApiSpec = parseYaml(readFileSync(candidate, 'utf-8'));
    app.log.info(`Loaded OpenAPI spec from ${candidate}`);
    break;
  } catch {
    /* try next */
  }
}
if (!openApiSpec.openapi) {
  app.log.warn(`OpenAPI spec not found. Tried: ${specCandidates.join(', ')}`);
}

app.get('/openapi.json', async (_req, reply) => reply.send(openApiSpec));

await app.register(ScalarApiReference, {
  routePrefix: '/docs',
  configuration: {
    title: 'ScrapeForge API',
    url: '/openapi.json',
  },
} as any);

// --- Routes ---
app.register(healthRoutes);
app.register(scrapeRoutes, { prefix: '/v1' });
app.register(extractRoutes, { prefix: '/v1' });
app.register(statusRoutes, { prefix: '/v1' });
app.register(ssePlugin, { prefix: '/v1' });
app.register(keyRotationRoutes, { prefix: '/v1' });

// --- Start ---
const PORT = parseInt(process.env.PORT || '3000');
try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`ScrapeForge API running on port ${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// --- Graceful Shutdown ---
async function shutdown() {
  app.log.info('Shutting down API server...');
  await app.close();
  await queueEvents.realtime.close();
  for (const q of Object.values(queues)) await q.close();
  await redis.quit();
  await pg.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
