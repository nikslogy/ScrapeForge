// Request coalescing: identical requests in flight at the same time do the
// work once.
//
// A job claims its request key (the result-cache key: tenant, URL, formats,
// schema, credentials digest, ...) in Redis with SET NX PX. A second job with
// the same key finds the claim, waits for the leader's `result:<jobId>` and
// returns a copy of it instead of fetching and extracting again. If the
// leader fails, or its claim expires without a result, the follower does
// the work itself. Claims expire at the leader's deadline, so a crashed
// worker never blocks a key.

export interface FlightKv {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface CoalescerOptions {
  /** How often a follower checks for the leader's result. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// Deletes the claim only while it is still this job's (it may have expired
// and been taken by another job).
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export function flightKey(requestKey: string): string {
  return `flight:${requestKey}`;
}

export class Coalescer {
  readonly #kv: FlightKv;
  readonly #pollMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  constructor(kv: FlightKv, opts: CoalescerOptions = {}) {
    this.#kv = kv;
    this.#pollMs = opts.pollMs ?? 200;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = opts.now ?? Date.now;
  }

  /**
   * Claims `key` for `jobId` for `ttlMs`. Returns null when this job now
   * leads (or already led: a retried job), otherwise the leader's job id.
   * A store failure counts as leading: coalescing never fails a job.
   */
  async claim(key: string, jobId: string, ttlMs: number): Promise<string | null> {
    try {
      const ttl = Math.max(1, Math.ceil(ttlMs));
      if ((await this.#kv.set(key, jobId, 'PX', ttl, 'NX')) === 'OK') return null;
      const leader = await this.#kv.get(key);
      return leader === null || leader === jobId ? null : leader;
    } catch {
      return null;
    }
  }

  /** Gives the key up (only while this job still holds it). */
  async release(key: string, jobId: string): Promise<void> {
    try {
      await this.#kv.eval(RELEASE, 1, key, jobId);
    } catch {
      // The claim expires on its own.
    }
  }

  /**
   * The leader's stored result, polled until `deadlineMs`. Stops early, with
   * one last read, once the leader no longer holds the key (finished, failed
   * or expired). A result `isFinal` rejects while the leader still holds the
   * key is from an earlier attempt of the same job (a BullMQ retry keeps its
   * id), and is waited past. Null when no result appeared in time.
   */
  async waitFor(
    key: string,
    leader: string,
    deadlineMs: number,
    readResult: (jobId: string) => Promise<string | null>,
    isFinal: (result: string) => boolean = () => true,
  ): Promise<string | null> {
    for (;;) {
      const result = await readResult(leader).catch(() => null);
      if (result !== null && isFinal(result)) return result;
      let holder: string | null = null;
      try {
        holder = await this.#kv.get(key);
      } catch {
        return null;
      }
      if (holder !== leader) return readResult(leader).catch(() => null);
      const left = deadlineMs - this.#now();
      if (left <= 0) return null;
      await this.#sleep(Math.min(this.#pollMs, left));
    }
  }
}
