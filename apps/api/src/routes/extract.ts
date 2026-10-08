import { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { ScrapeJobData, checkPublicUrl, createCacheKey } from '@scrapeforge/shared';

const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const optionalStr = z.preprocess(emptyToUndefined, z.string().optional());

// Cheap pre-checks before a job is queued. The worker normalizes and
// validates the schema fully (refs, patterns, property counts) and reports
// problems as an `invalid_schema:*` extraction warning.
export const MAX_SCHEMA_BYTES = 64 * 1024;
export const MAX_SCHEMA_DEPTH = 10;
// Raw JSON nesting beyond this is rejected outright (bounds the walk below).
const MAX_JSON_NESTING = 64;
// Keywords whose value maps names to subschemas: the map itself is not a level.
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
// Keywords holding data, not schemas.
const SCHEMA_DATA = new Set(['enum', 'const', 'default', 'examples', 'example']);

/**
 * Nesting depth in schema levels: the root is 0 and every nested subschema
 * (or nested shorthand object) adds one. Infinity for JSON nested deeper
 * than MAX_JSON_NESTING. Iterative, so hostile input cannot overflow the stack.
 */
export function schemaDepth(schema: unknown): number {
  let max = 0;
  const stack: Array<{ value: unknown; level: number; nesting: number }> = [{ value: schema, level: 0, nesting: 0 }];
  while (stack.length > 0) {
    const { value, level, nesting } = stack.pop()!;
    if (nesting > MAX_JSON_NESTING) return Number.POSITIVE_INFINITY;
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, level, nesting: nesting + 1 });
      continue;
    }
    if (typeof value !== 'object' || value === null) continue;
    max = Math.max(max, level);
    for (const [key, child] of Object.entries(value)) {
      if (SCHEMA_DATA.has(key) || typeof child !== 'object' || child === null) continue;
      if (SCHEMA_MAPS.has(key) && !Array.isArray(child)) {
        for (const sub of Object.values(child)) stack.push({ value: sub, level: level + 1, nesting: nesting + 2 });
      } else {
        stack.push({ value: child, level: level + 1, nesting: nesting + 1 });
      }
    }
  }
  return max;
}

/** Why a customer schema is refused before queueing, or null. */
export function schemaLimitIssue(schema: unknown): string | null {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(schema) ?? '', 'utf8');
  } catch {
    return 'Schema is not serializable JSON';
  }
  if (bytes > MAX_SCHEMA_BYTES) return `Schema is larger than ${MAX_SCHEMA_BYTES} bytes`;
  if (schemaDepth(schema) > MAX_SCHEMA_DEPTH) return `Schema is nested deeper than ${MAX_SCHEMA_DEPTH} levels`;
  return null;
}

/** Customer schema: a non-empty object within the size and depth limits. */
export const customerSchema = z.record(z.unknown()).superRefine((s, ctx) => {
  const issue = schemaLimitIssue(s);
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
});

/** Request options of the extraction engine (also accepted by /v1/scrape). */
export const extractionOptions = {
  includeEvidence: z.boolean().default(false),
  maxLlmCostUsd: z.number().min(0).max(1).optional(),
};

/**
 * Queue options. A synchronous caller is waiting on the HTTP response, so a
 * failing job gets one quick retry (permanent failures are unrecoverable in
 * the worker and are not retried at all); webhook jobs have time to back off.
 */
export function jobRetryOptions(isSync: boolean): { attempts: number; backoff: { type: 'fixed' | 'exponential'; delay: number } } {
  return isSync
    ? { attempts: 2, backoff: { type: 'fixed', delay: 250 } }
    : { attempts: 3, backoff: { type: 'exponential', delay: 1000 } };
}

const ExtractRequestSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  schema: customerSchema.refine(
    (s) => Object.keys(s).length > 0,
    { message: 'Schema must have at least one property' },
  ),
  ...extractionOptions,
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
      // Only present when set, so keys of plain requests are unchanged.
      includeEvidence: body.includeEvidence || undefined,
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
      ...jobRetryOptions(isSync),
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
