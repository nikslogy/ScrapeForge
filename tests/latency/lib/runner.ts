// Closed-loop load generator: `concurrency` virtual clients each issue the
// next request as soon as their previous one finishes, until `total`
// requests have been issued. Matches how the earlier API harness
// (tests/perf/percentiles.ts) drove the API, so numbers are comparable.

export interface LoadOptions<T> {
  /** Measured requests (after warm-up). */
  total: number;
  /** Simultaneous in-flight requests. */
  concurrency: number;
  /** Requests issued (at the same concurrency) and discarded before measuring. */
  warmup?: number;
  /** Receives 0..total-1 for measured requests and a negative index during warm-up. */
  task: (index: number) => Promise<T>;
}

export interface LoadError {
  index: number;
  message: string;
}

export interface LoadResult<T> {
  /** Results of successful measured requests, in completion order. */
  results: T[];
  errors: LoadError[];
  /** Wall time of the measured phase, ms. */
  wallMs: number;
  /** Successful measured requests per second over the measured phase. */
  throughputPerSec: number;
}

function assertCount(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${value}`);
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 300);
  try {
    return String(err).slice(0, 300);
  } catch {
    return 'unprintable error';
  }
}

async function drive<T>(
  total: number,
  concurrency: number,
  task: (index: number) => Promise<T>,
  results: T[],
  errors: LoadError[],
): Promise<void> {
  let next = 0;
  const client = async (): Promise<void> => {
    for (;;) {
      // Claim the index before awaiting so two clients never share one.
      const index = next++;
      if (index >= total) return;
      try {
        results.push(await task(index));
      } catch (err) {
        errors.push({ index, message: describe(err) });
      }
    }
  };
  const clients = Math.min(concurrency, total);
  await Promise.all(Array.from({ length: clients }, client));
}

export async function runLoad<T>(opts: LoadOptions<T>): Promise<LoadResult<T>> {
  const warmup = opts.warmup ?? 0;
  assertCount('total', opts.total, 0);
  assertCount('concurrency', opts.concurrency, 1);
  assertCount('warmup', warmup, 0);

  if (warmup > 0) {
    // Warm-up failures are not reported: they usually reflect one-time
    // initialisation, which the scenario measures separately when it matters.
    await drive(warmup, opts.concurrency, (i) => opts.task(-1 - i), [], []);
  }

  const results: T[] = [];
  const errors: LoadError[] = [];
  const start = performance.now();
  await drive(opts.total, opts.concurrency, opts.task, results, errors);
  const wallMs = performance.now() - start;
  return {
    results,
    errors,
    wallMs,
    throughputPerSec: wallMs > 0 ? (results.length / wallMs) * 1000 : 0,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
