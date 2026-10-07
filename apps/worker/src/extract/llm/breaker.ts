// In-memory circuit breaker for model providers.
//
// Keys are a provider name ("openrouter") to stop every model of that
// provider (bad key, account out of credit) or a registry key
// ("openrouter:google/gemini-2.5-flash") to stop one model (per-model daily
// quota). Registry keys always contain ':' and provider names never do, so
// the two never collide. State is per process: each worker learns on its own,
// which is fine for minutes-long trips.

export interface BreakerEntry {
  /** Epoch ms (breaker clock) when the circuit closes again. */
  until: number;
  /** Why it was tripped; the model client stores the error category here. */
  reason: string;
}

export interface CircuitBreakerOptions {
  now?: () => number;
  /** Bound on remembered keys; keys come from configuration, so this is a safety net. */
  maxEntries?: number;
}

export class CircuitBreaker {
  readonly #entries = new Map<string, BreakerEntry>();
  readonly #now: () => number;
  readonly #maxEntries: number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#maxEntries = Math.max(1, opts.maxEntries ?? 1_000);
  }

  /** Opens the circuit for `ms`. A trip never shortens an existing longer one. */
  trip(key: string, ms: number, reason: string): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const until = this.#now() + ms;
    const existing = this.#entries.get(key);
    if (existing && existing.until >= until) return;
    if (!existing && this.#entries.size >= this.#maxEntries) this.#evict();
    this.#entries.set(key, { until, reason });
  }

  isOpen(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** The open entry for `key`, if any. Expired entries are dropped. */
  get(key: string): BreakerEntry | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.until <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Closes one circuit, or all of them. */
  reset(key?: string): void {
    if (key === undefined) this.#entries.clear();
    else this.#entries.delete(key);
  }

  get size(): number {
    return this.#entries.size;
  }

  #evict(): void {
    const now = this.#now();
    for (const [k, e] of this.#entries) if (e.until <= now) this.#entries.delete(k);
    // Still full: drop the oldest insertion.
    if (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
  }
}

/** Process-wide breaker shared by every ModelClient that does not inject one. */
export const defaultBreaker = new CircuitBreaker();
