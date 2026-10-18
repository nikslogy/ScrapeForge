// Concurrency budgets.
//
// * Semaphore: a process-wide cap on one kind of work (model calls).
// * DomainLimiter: a cap on fetches in flight per site, across every worker
//   process, held as expiring leases in a Redis sorted set (one per host).
//   A crashed worker's leases expire on their own. Too many parallel
//   requests to one site get it blocked; the limit spreads them out. Slots
//   are shared max-min between the tenants waiting for a site: a tenant
//   gets a free slot only when no other waiting tenant holds fewer, so one
//   tenant's crawl cannot take every slot from the rest. A lease is renewed
//   while its fetch runs, so it never expires under a fetch still running.

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
  /** How long a waiting tenant counts as waiting after its last try (default 5 polls, at least 1 s). */
  waitTtlMs?: number;
  /** How often a waiting fetch retries. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// KEYS[1] leases of the host ("tenant|token" → expiry); KEYS[2] tenants
// waiting for it (tenant → until when it counts as waiting).
// ARGV: now, limit, lease expiry, "tenant|token", tenant, waiting expiry.
// Neither key's TTL is ever shortened: it is the latest expiry in the set.
const ACQUIRE = `
local now, limit, tenant = tonumber(ARGV[1]), tonumber(ARGV[2]), ARGV[5]
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local function wait()
  redis.call('ZADD', KEYS[2], ARGV[6], tenant)
  local last = redis.call('ZRANGE', KEYS[2], -1, -1, 'WITHSCORES')
  redis.call('PEXPIREAT', KEYS[2], last[2])
  return 0
end
local held = redis.call('ZRANGE', KEYS[1], 0, -1)
if #held >= limit then return wait() end
-- Max-min: no slot while another waiting tenant holds fewer.
local counts = {}
for _, m in ipairs(held) do
  local t = string.match(m, '^(.-)|') or ''
  counts[t] = (counts[t] or 0) + 1
end
local mine = counts[tenant] or 0
for _, t in ipairs(redis.call('ZRANGE', KEYS[2], 0, -1)) do
  if t ~= tenant and (counts[t] or 0) < mine then return wait() end
end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
redis.call('ZREM', KEYS[2], tenant)
local last = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
redis.call('PEXPIREAT', KEYS[1], last[2])
return 1`;
const RELEASE = `return redis.call('ZREM', KEYS[1], ARGV[1])`;
// KEYS[1] leases; ARGV: until, member. Moves the lease's expiry later (never earlier), and the key's with it.
const RENEW = `
local cur = redis.call('ZSCORE', KEYS[1], ARGV[2])
if not cur then return 0 end
if tonumber(ARGV[1]) > tonumber(cur) then redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2]) end
local last = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
redis.call('PEXPIREAT', KEYS[1], last[2])
return 1`;

/** A held slot: call it to release; renew() keeps it past its expiry while the fetch runs. */
export type Lease = (() => Promise<void>) & { renew(untilMs: number): Promise<void> };

function noLease(): Lease {
  return Object.assign(async () => undefined, { renew: async () => undefined });
}

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

export interface AcquireOptions {
  signal?: AbortSignal;
  /** Who is asking: slots are shared fairly between tenants waiting for one site. */
  tenant?: string;
  /**
   * The lease expires this long after it is granted unless renewed,
   * whatever the wait deadline (default: it expires at the wait deadline).
   */
  leaseTtlMs?: number;
}

export class DomainLimiter {
  readonly #kv: LeaseKv;
  readonly #limit: number;
  readonly #pollMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #waitTtlMs: number;
  #seq = 0;

  constructor(kv: LeaseKv, opts: DomainLimiterOptions) {
    this.#kv = kv;
    this.#limit = opts.limit;
    this.#pollMs = opts.pollMs ?? 100;
    this.#waitTtlMs = opts.waitTtlMs ?? Math.max(1_000, this.#pollMs * 5);
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = opts.now ?? Date.now;
  }

  /**
   * Waits for a slot for `url`'s site until `deadlineMs`; the lease expires
   * `leaseTtlMs` after the grant (default: at the deadline) unless renewed.
   * Returns its release. With the limit off, an unparseable URL, or a store failure, it
   * returns at once: a limiter never fails a job. Rejects only if `signal`
   * aborts or the deadline passes while waiting.
   */
  async acquire(url: string, deadlineMs: number, opts: AcquireOptions = {}): Promise<Lease> {
    const key = domainKey(url);
    if (this.#limit <= 0 || key === null) return noLease();
    const { signal } = opts;
    // "|" separates the tenant from the token in a lease.
    const tenant = (opts.tenant ?? '').replace(/\|/g, '_') || '-';
    const member = `${tenant}|${process.pid}:${++this.#seq}:${Math.random().toString(36).slice(2)}`;
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const now = this.#now();
      if (now >= deadlineMs) throw new DomainBusyError(url);
      let granted: unknown;
      // Counted from this try: a slot granted late in the wait still lives its full TTL.
      const leaseUntil = Math.ceil(opts.leaseTtlMs !== undefined ? now + opts.leaseTtlMs : deadlineMs);
      try {
        granted = await this.#kv.eval(ACQUIRE, 2, key, `${key}:waiting`, now, this.#limit, leaseUntil, member, tenant, now + this.#waitTtlMs);
      } catch {
        return noLease();
      }
      if (granted === 1) {
        const release = async (): Promise<void> => {
          try {
            await this.#kv.eval(RELEASE, 1, key, member);
          } catch {
            // The lease expires on its own.
          }
        };
        const renew = async (untilMs: number): Promise<void> => {
          try {
            await this.#kv.eval(RENEW, 1, key, Math.ceil(untilMs), member);
          } catch {
            // Best effort: the lease keeps its current expiry.
          }
        };
        return Object.assign(release, { renew });
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
