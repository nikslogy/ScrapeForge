import { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { ScrapeJobData, createCacheKey, checkPublicUrl } from '@scrapeforge/shared';

// Empty strings coming from form-style API explorers (Scalar, Swagger UI)
// should be treated as "field not provided" rather than "invalid value".
const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const optionalStr = z.preprocess(emptyToUndefined, z.string().optional());

const ScrapeRequestSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  formats: z.array(z.enum(['html', 'markdown', 'text', 'screenshot', 'json']))
    .default(['markdown']),
  waitFor: optionalStr,
  timeout: z.number().min(1000).max(120000).default(60000),
  proxy: z.enum(['none', 'datacenter', 'residential', 'mobile', 'auto']).default('auto'),
  headers: z.record(z.string()).optional(),
  cookies: z.array(z.object({
    name: z.string(),
    value: z.string(),
    domain: z.string().optional(),
    path: z.string().optional(),
  })).optional(),
  screenshot: z.boolean().default(false),
  mobile: z.boolean().default(false),
  blockResources: z.boolean().default(true),
  cacheTtl: z.number().min(0).max(2592000).default(3600),
  webhookUrl: optionalUrl,
  extractSchema: z.record(z.unknown()).optional(),
});

export async function scrapeRoutes(app: FastifyInstance) {
  app.post('/scrape', async (request, reply) => {
    const parseResult = ScrapeRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.flatten(),
      });
    }
    const body = parseResult.data;
    const user = request.user!;

    const urlCheck = await checkPublicUrl(body.url);
    if (!urlCheck.ok) {
      return reply.status(400).send({
        error: urlCheck.reason === 'dns'
          ? 'Could not resolve host.'
          : 'URL targets a private or reserved address range.',
      });
    }
    if (body.webhookUrl) {
      const webhookCheck = await checkPublicUrl(body.webhookUrl);
      if (!webhookCheck.ok) {
        return reply.status(400).send({
          error: webhookCheck.reason === 'dns'
            ? 'Could not resolve webhookUrl host.'
            : 'webhookUrl targets a private or reserved address range.',
        });
      }
    }

    const { redis, queues, queueEvents } = app;
    const cacheKeyStr = `cache:${createCacheKey(body.url, {
      formats: body.formats,
      proxy: body.proxy,
      extractSchema: body.extractSchema,
    })}`;

    if (body.cacheTtl > 0) {
      const cached = await redis.get(cacheKeyStr);
      if (cached) {
        const data = JSON.parse(cached);
        return reply.status(200).send({
          ...data,
          metadata: { ...data.metadata, cached: true },
        });
      }
    }

    const jobId = `job_${nanoid(16)}`;
    const jobData: ScrapeJobData = {
      jobId,
      userId: user.userId,
      apiKeyId: user.apiKeyId,
      url: body.url,
      options: body,
      priority: body.webhookUrl ? 2 : 1,
      createdAt: new Date().toISOString(),
    };

    const isSync = !body.webhookUrl;
    const queue = isSync ? queues.realtime : queues.standard;

    const job = await queue.add(jobId, jobData, {
      jobId,
      priority: jobData.priority,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    });

    if (isSync) {
      try {
        const result = await job.waitUntilFinished(
          queueEvents.realtime,
          body.timeout,
        );
        return reply.status(200).send(result);
      } catch (err) {
        // Fallback: resolve the race where the job finishes before the
        // QueueEvents subscriber registers the listener. Ask Redis directly.
        try {
          const freshJob = await queues.realtime.getJob(jobId);
          if (freshJob) {
            const state = await freshJob.getState();
            if (state === 'completed' && freshJob.returnvalue) {
              return reply.status(200).send(freshJob.returnvalue);
            }
            if (state === 'failed') {
              return reply.status(502).send({
                error: freshJob.failedReason || 'Scrape failed across all tiers.',
                jobId,
                statusUrl: `/v1/status/${jobId}`,
              });
            }
          }
        } catch {
          /* fall through to 504 */
        }
        return reply.status(504).send({
          error: 'Job timed out. Try again or use webhook mode for slow sites.',
          jobId,
          statusUrl: `/v1/status/${jobId}`,
        });
      }
    }

    return reply.status(202).send({
      jobId,
      status: 'queued',
      statusUrl: `/v1/status/${jobId}`,
    });
  });
}
