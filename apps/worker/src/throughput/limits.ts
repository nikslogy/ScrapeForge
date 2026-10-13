// Concurrency budgets.
//
// * Semaphore: a process-wide cap on one kind of work (model calls).
// * DomainLimiter: a cap on fetches in flight per site, across every worker
//   process, held as expiring leases in a Redis sorted set (one per host).
//   A crashed worker's leases expire on their own. Too many parallel
//   requests to one site get it blocked; the limit spreads them out.

export class Semaphore {
  readonly limit: number;
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Semaphore: limit must be a positive integer');
    this.limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  get waiting(): number {
    return this.#waiting.length;
  }

  /** Resolves with a release function once a slot is free; rejects if `signal` aborts first. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#active < this.limit) {
      this.#active++;
      return Promise.resolve(this.#releaser());
    }
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        this.#active++;
        resolve(this.#releaser());
      };
      const onAbort = (): void => {
        const i = this.#waiting.indexOf(grant);
        if (i >= 0) this.#waiting.splice(i, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiting.push(grant);
    });
  }

  /** Runs `work` in a slot. */
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await work();
    } finally {
      release();
    }
  }

  #releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#active--;
      this.#waiting.shift()?.();
    };
  }
}

export interface LeaseKv {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface DomainLimiterOptions {
  /** Fetches in flight per host. */
  limit: number;
  /** How often a waiting fetch retries. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// KEYS[1] host set; ARGV: now, limit, lease expiry, token.
const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
  redis.call('PEXPIREAT', KEYS[1], ARGV[3])
  return 1
end
return 0`;
const RELEASE = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

/** Default fetches in flight per site (FETCH_DOMAIN_CONCURRENCY overrides; 0 turns the limit off). */
export const DEFAULT_DOMAIN_CONCURRENCY = 6;

export function domainConcurrency(env: Record<string, string | undefined> = process.env): number {
  const raw = env.FETCH_DOMAIN_CONCURRENCY;
  if (raw === undefined || raw.trim() === '') return DEFAULT_DOMAIN_CONCURRENCY;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DOMAIN_CONCURRENCY;
}

/** "www.shop.example.com" and "shop.example.com" share one budget. */
export function domainKey(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return `domain-slots:${host.replace(/^www\./, '')}`;
  } catch {
    return null;
  }
}

export class DomainLimiter {
  readonly #kv: LeaseKv;
  readonly #limit: number;
  readonly #pollMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  #seq = 0;

  constructor(kv: LeaseKv, opts: DomainLimiterOptions) {
    this.#kv = kv;
    this.#limit = opts.limit;
    this.#pollMs = opts.pollMs ?? 100;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = opts.now ?? Date.now;
  }

  /**
   * Waits for a slot for `url`'s site until `deadlineMs`; the lease expires
   * then at the latest. Returns its release. With the limit off, an
   * unparseable URL, or a store failure, it returns at once: a limiter
   * never fails a job. Rejects only if `signal` aborts or the deadline
   * passes while waiting.
   */
  async acquire(url: string, deadlineMs: number, signal?: AbortSignal): Promise<() => Promise<void>> {
    const key = domainKey(url);
    if (this.#limit <= 0 || key === null) return async () => undefined;
    const token = `${process.pid}:${++this.#seq}:${Math.random().toString(36).slice(2)}`;
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const now = this.#now();
      if (now >= deadlineMs) throw new DomainBusyError(url);
      let granted: unknown;
      try {
        granted = await this.#kv.eval(ACQUIRE, 1, key, now, this.#limit, Math.ceil(deadlineMs), token);
      } catch {
        return async () => undefined;
      }
      if (granted === 1) {
        return async () => {
          try {
            await this.#kv.eval(RELEASE, 1, key, token);
          } catch {
            // The lease expires on its own.
          }
        };
      }
      await this.#sleep(Math.min(this.#pollMs, Math.max(1, deadlineMs - now)));
    }
  }
}

export class DomainBusyError extends Error {
  readonly code = 'DOMAIN_BUSY' as const;

  constructor(url: string) {
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      // keep the raw text
    }
    super(`Timeout: no fetch slot for ${host} before the deadline (too many requests to this site in flight)`);
    this.name = 'DomainBusyError';
  }
}
