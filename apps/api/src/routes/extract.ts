import { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { ScrapeJobData, checkPublicUrl, createCacheKey } from '@scrapeforge/shared';

const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const optionalStr = z.preprocess(emptyToUndefined, z.string().optional());

const ExtractRequestSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  schema: z.record(z.unknown()).refine(
    (s) => Object.keys(s).length > 0,
    { message: 'Schema must have at least one property' },
  ),
  formats: z
    .array(z.enum(['html', 'markdown', 'text', 'screenshot', 'json']))
    .default(['json']),
  waitFor: optionalStr,
  timeout: z.number().min(1000).max(120000).default(60000),
  proxy: z
    .enum(['none', 'datacenter', 'residential', 'mobile', 'auto'])
    .default('auto'),
  headers: z.record(z.string()).optional(),
  cookies: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string().optional(),
        path: z.string().optional(),
      }),
    )
    .optional(),
  screenshot: z.boolean().default(false),
  mobile: z.boolean().default(false),
  blockResources: z.boolean().default(true),
  cacheTtl: z.number().min(0).max(2592000).default(3600),
  webhookUrl: optionalUrl,
});

export async function extractRoutes(app: FastifyInstance) {
  app.post('/extract', async (request, reply) => {
    const parseResult = ExtractRequestSchema.safeParse(request.body);
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

    // Check cache — uses the same `cache:<hash>` namespace and key shape as
    // the worker writes to (see apps/worker/src/worker.ts → Stage 5). Previously
    // this route read from an `extract:...` key that nothing ever wrote to,
    // so extract cache hits never occurred and every request re-hit the LLM.
    const formatsForKey = [...new Set([...body.formats, 'json', 'markdown'])];
    const cacheKey = `cache:${createCacheKey(body.url, {
      formats: formatsForKey,
      proxy: body.proxy,
      extractSchema: body.schema,
    })}`;
    if (body.cacheTtl > 0) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const data = JSON.parse(cached);
        return reply.status(200).send({
          ...data,
          metadata: { ...data.metadata, cached: true },
        });
      }
    }

    const jobId = `ext_${nanoid(16)}`;

    // Always include 'markdown' so the pipeline returns content even if AI fails
    const formats = [...new Set([...body.formats, 'json' as const, 'markdown' as const])];

    const jobData: ScrapeJobData = {
      jobId,
      userId: user.userId,
      apiKeyId: user.apiKeyId,
      url: body.url,
      options: {
        ...body,
        extractSchema: body.schema,
        formats,
      },
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
      } catch {
        // Race-safe fallback: check job state directly.
        try {
          const freshJob = await queues.realtime.getJob(jobId);
          if (freshJob) {
            const state = await freshJob.getState();
            if (state === 'completed' && freshJob.returnvalue) {
              return reply.status(200).send(freshJob.returnvalue);
            }
            if (state === 'failed') {
              return reply.status(502).send({
                error: freshJob.failedReason || 'Extraction failed.',
                jobId,
                statusUrl: `/v1/status/${jobId}`,
              });
            }
          }
        } catch {
          /* ignore */
        }
        return reply.status(504).send({
          error: 'Extraction timed out. Use webhook mode for slow sites.',
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
