// worker.ts job processor with its I/O stubbed: the job-level deadline
// (fetch + content + structured extraction) and which failures BullMQ may
// retry. The processor is the real one, taken from the stubbed BullMQ Worker.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScrapeJobData, ScrapeOptions } from '@scrapeforge/shared';

interface FakePage {
  closed: boolean;
  close: () => Promise<void>;
  onClose: Promise<void>;
}
interface FakeContext {
  id: number;
  page: FakePage;
  pages: () => FakePage[];
}

const h = vi.hoisted(() => {
  const state = {
    kv: new Map<string, string>(),
    processors: [] as Array<(job: unknown) => Promise<unknown>>,
    /** The router's injected browser-context callbacks (worker.ts wraps the pool). */
    acquire: null as null | (() => Promise<unknown>),
    release: null as null | ((ctx: unknown) => void),
    route: null as null | ((url: string, options: unknown, tracer: unknown) => Promise<unknown>),
    extractContent: null as null | ((html: string, url: string, formats: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>),
    poolAcquired: [] as unknown[],
    poolReleased: [] as unknown[],
    nextContextId: 1,
    newContext: null as null | (() => unknown),
    UnrecoverableError: null as null | (new (message: string) => Error),
  };
  return state;
});

vi.mock('ioredis', () => ({
  Redis: class {
    async get(key: string) {
      return h.kv.get(key) ?? null;
    }
    async set(key: string, value: string) {
      h.kv.set(key, value);
      return 'OK';
    }
    async del(key: string) {
      return h.kv.delete(key) ? 1 : 0;
    }
    async quit() {}
  },
}));
vi.mock('pg', () => ({
  Pool: class {
    async query() {
      return { rows: [] };
    }
    async end() {}
  },
}));
vi.mock('bullmq', () => {
  class UnrecoverableError extends Error {}
  h.UnrecoverableError = UnrecoverableError;
  return {
    Worker: class {
      constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
        h.processors.push(processor);
      }
      on() {}
      async close() {}
    },
    UnrecoverableError,
  };
});
vi.mock('../../src/browser/pool.js', () => ({
  BrowserPool: class {
    async initialize() {}
    async acquire() {
      const ctx = h.newContext!();
      h.poolAcquired.push(ctx);
      return ctx;
    }
    release(ctx: unknown) {
      h.poolReleased.push(ctx);
    }
    async shutdown() {}
  },
}));
vi.mock('../../src/engine/router.js', () => ({
  SmartRouter: class {
    constructor(_redis: unknown, acquire: () => Promise<unknown>, release: (ctx: unknown) => void) {
      h.acquire = acquire;
      h.release = release;
    }
    route(url: string, options: unknown, tracer: unknown) {
      return h.route!(url, options, tracer);
    }
    async drainStrategyWrites() {}
  },
}));
vi.mock('../../src/extraction/pipeline.js', () => ({
  extractContent: (html: string, url: string, formats: unknown, options?: { signal?: AbortSignal }) =>
    h.extractContent!(html, url, formats, options),
}));
vi.mock('../../src/delivery/webhook.js', () => ({ deliverWebhook: async () => undefined }));
vi.mock('../../src/delivery/sse-emitter.js', () => ({
  SseEmitter: class {
    async emit() {}
    async emitHeaders() {}
    async emitContent() {}
    async emitExtraction() {}
    async emitComplete() {}
    async emitError() {}
  },
}));
vi.mock('../../src/metrics.js', () => {
  const metric = { inc() {}, observe() {}, set() {} };
  return {
    scrapeRequestsTotal: metric,
    scrapeDuration: metric,
    scrapeCost: metric,
    browserPoolSize: metric,
    llmCostTotal: metric,
    observeStages() {},
    observeTierAttempts() {},
    startMetricsServer() {},
  };
});
vi.mock('../../src/extract/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/extract/index.js')>();
  const { fakeClient } = await import('../engine/helpers.js');
  const { client } = fakeClient((() => {
    throw new Error('unexpected model call');
  }) as never);
  return { ...orig, createDefaultModelClient: () => client };
});

// Must match worker.ts: the job deadline is options.timeout plus this margin.
const MARGIN_MS = 2_000;
const HTML = '<html><head><title>Fine</title></head><body><p>Hello there, this is a page.</p></body></html>';
const OK_ROUTE = { html: HTML, statusCode: 200, tierUsed: 1, proxyTier: 'none', latencyMs: 5, proxyCost: 0 };
const OK_CONTENT = { markdown: '# Fine', extractionMethod: 'test', title: 'Fine' };

const { TiersExhaustedError } = await vi.importActual<typeof import('../../src/engine/router.js')>('../../src/engine/router.js');

let processor: (job: unknown) => Promise<unknown>;
let jobSeq = 0;

function fakeContext(): FakeContext {
  let resolveClose!: () => void;
  const onClose = new Promise<void>((r) => (resolveClose = r));
  const page: FakePage = {
    closed: false,
    onClose,
    close: vi.fn(async () => {
      page.closed = true;
      resolveClose();
    }),
  };
  return { id: h.nextContextId++, page, pages: () => (page.closed ? [] : [page]) };
}

function run(options: ScrapeOptions) {
  const jobId = `job_${++jobSeq}`;
  const data: ScrapeJobData = {
    jobId,
    userId: 'tenant-a',
    apiKeyId: 'key-a',
    url: 'http://public.test/page',
    options,
    priority: 1,
    createdAt: new Date().toISOString(),
  };
  const t0 = performance.now();
  const promise = processor({ data, updateProgress: async () => undefined });
  const settled = promise.then(
    (value) => ({ ok: true as const, value, ms: performance.now() - t0 }),
    (error: unknown) => ({ ok: false as const, error: error as Error, ms: performance.now() - t0 }),
  );
  return { jobId, settled };
}

function storedResult(jobId: string): { status: string; error?: string } {
  return JSON.parse(h.kv.get(`result:${jobId}`) ?? 'null');
}

beforeAll(async () => {
  await import('../../src/worker.js');
  expect(h.processors.length).toBeGreaterThan(0);
  processor = h.processors[0];
});

afterAll(async () => {
  const { flushRecipeLearning } = await import('../../src/extract/index.js');
  await flushRecipeLearning();
});

beforeEach(() => {
  h.kv.clear();
  h.poolAcquired.length = 0;
  h.poolReleased.length = 0;
  h.newContext = fakeContext;
  h.route = async () => OK_ROUTE;
  h.extractContent = async () => OK_CONTENT;
});

describe('job deadline', () => {
  it('fails a job whose browser fetch hangs at timeout + margin, closes its page and refuses further browser tiers', async () => {
    const timeout = 300;
    const events: string[] = [];
    let backgroundDone!: () => void;
    const background = new Promise<void>((r) => (backgroundDone = r));
    // A router whose T4 page never finishes on its own (it ends only when the
    // page is closed), followed by a T5 attempt that needs another context.
    h.route = async () => {
      try {
        const ctx = (await h.acquire!()) as FakeContext;
        try {
          await ctx.page.onClose;
          events.push('t4 page closed');
        } finally {
          h.release!(ctx);
        }
        try {
          const ctx5 = (await h.acquire!()) as FakeContext;
          events.push('t5 acquired');
          h.release!(ctx5);
        } catch {
          events.push('t5 refused');
        }
        throw new Error('All tiers exhausted for public.test — T4:threw Target page closed');
      } finally {
        backgroundDone();
      }
    };

    const { jobId, settled } = run({ timeout, formats: ['markdown'] });
    const r = await settled;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/timed out after 300 ms/i);
    expect(r.error.message).toMatch(/fetch/);
    expect(r.ms).toBeGreaterThanOrEqual(timeout + MARGIN_MS - 50);
    expect(r.ms).toBeLessThan(timeout + MARGIN_MS + 1_500);
    // A deadline miss may be retried: the target can be slow only for a while.
    expect(r.error).not.toBeInstanceOf(h.UnrecoverableError!);
    expect(storedResult(jobId)).toMatchObject({ status: 'failed', error: r.error.message });

    // The job's browser work is cut short and its context goes back to the pool.
    await background;
    expect(events).toEqual(['t4 page closed', 't5 refused']);
    expect(h.poolAcquired).toHaveLength(1);
    expect(h.poolReleased).toEqual(h.poolAcquired);
  });

  it('aborts the content extraction when the deadline passes during it', async () => {
    const timeout = 200;
    let seen: AbortSignal | undefined;
    h.extractContent = (_html, _url, _formats, options) =>
      new Promise((_, reject) => {
        seen = options?.signal;
        seen?.addEventListener('abort', () => reject(Object.assign(new Error('extraction aborted'), { name: 'AbortError' })));
      });

    const { settled } = run({ timeout, formats: ['markdown'] });
    const r = await settled;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(true);
    expect(r.error.message).toMatch(/timed out after 200 ms/i);
    expect(r.error.message).toMatch(/content/);
    expect(r.ms).toBeLessThan(timeout + MARGIN_MS + 1_500);
  });

  it('a job that finishes in time is unaffected and its deadline does not fire later', async () => {
    const timeout = 100;
    let seen: AbortSignal | undefined;
    h.extractContent = async (_html, _url, _formats, options) => {
      seen = options?.signal;
      return OK_CONTENT;
    };
    const { jobId, settled } = run({ timeout, formats: ['markdown'] });
    const r = await settled;
    expect(r.ok).toBe(true);
    expect(storedResult(jobId)).toMatchObject({ status: 'completed' });
    await new Promise((resolve) => setTimeout(resolve, timeout + MARGIN_MS + 200));
    expect(seen?.aborted).toBe(false);
  });
});

describe('retry classification', () => {

  async function failure(err: unknown) {
    h.route = async () => {
      throw err;
    };
    const { jobId, settled } = run({ timeout: 5_000, formats: ['markdown'] });
    const r = await settled;
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(storedResult(jobId)).toMatchObject({ status: 'failed' });
    return r.error;
  }

  it('retries exhausted tiers when every tier failed transiently', async () => {
    const err = new TiersExhaustedError(
      'All tiers exhausted for public.test — T1:threw connect ECONNREFUSED | T2:threw socket hang up | T4:threw net::ERR_CONNECTION_REFUSED | T5:threw net::ERR_CONNECTION_REFUSED',
      false,
    );
    const thrown = await failure(err);
    expect(thrown).toBe(err);
    expect(thrown).not.toBeInstanceOf(h.UnrecoverableError!);
  });

  it('does not retry exhausted tiers when a tier got a block or unusable page', async () => {
    const err = new TiersExhaustedError('All tiers exhausted for public.test — T1:invalid content (status=403 htmlLen=900) | T2:threw x', true);
    const thrown = await failure(err);
    expect(thrown).toBeInstanceOf(h.UnrecoverableError!);
    expect(thrown.message).toBe(err.message);
  });

  it('matches the classification by code (another module copy of the router)', async () => {
    const transient = Object.assign(new Error('All tiers exhausted for public.test — T1:threw a'), { code: 'TIERS_EXHAUSTED', transient: true });
    expect(await failure(transient)).not.toBeInstanceOf(h.UnrecoverableError!);
    const definitive = Object.assign(new Error('All tiers exhausted for public.test — T1:low quality'), { code: 'TIERS_EXHAUSTED', transient: false });
    expect(await failure(definitive)).toBeInstanceOf(h.UnrecoverableError!);
  });

  it('still fails private destinations and unresolvable hosts without retry', async () => {
    expect(await failure(new Error('Blocked by SSRF guard: 10.0.0.1 is a private address'))).toBeInstanceOf(h.UnrecoverableError!);
    expect(await failure(new Error('DNS lookup failed for nope.invalid'))).toBeInstanceOf(h.UnrecoverableError!);
    expect(await failure(new Error('socket hang up'))).not.toBeInstanceOf(h.UnrecoverableError!);
  });
});
