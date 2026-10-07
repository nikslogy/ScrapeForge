// Per-request deadline and spend limit shared by every model call made for
// one extraction (extract, repair, recipe proposal).

const MAX_TIMER_MS = 2_147_483_647;

export interface BudgetOptions {
  /** Absolute deadline, epoch ms (same clock as `now`). */
  deadlineMs: number;
  /** Spend cap in USD. 0 allows no calls at all; undefined means no cap. */
  maxCostUsd?: number;
  now?: () => number;
}

export class Budget {
  readonly deadlineMs: number;
  readonly maxCostUsd?: number;
  readonly #now: () => number;
  #spentUsd = 0;

  constructor(opts: BudgetOptions) {
    if (!Number.isFinite(opts.deadlineMs)) throw new RangeError('Budget: deadlineMs must be a finite epoch ms value');
    if (opts.maxCostUsd !== undefined && !(Number.isFinite(opts.maxCostUsd) && opts.maxCostUsd >= 0)) {
      throw new RangeError('Budget: maxCostUsd must be a non-negative number');
    }
    this.deadlineMs = opts.deadlineMs;
    this.maxCostUsd = opts.maxCostUsd;
    this.#now = opts.now ?? Date.now;
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineMs - this.#now());
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }

  /** Adds spend. Non-finite or negative amounts (bad usage data) count as 0. */
  charge(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.#spentUsd += usd;
  }

  /** True while the deadline has not passed and the cost cap is not reached. */
  canSpend(): boolean {
    if (this.remainingMs() <= 0) return false;
    return this.maxCostUsd === undefined || this.#spentUsd < this.maxCostUsd;
  }

  /**
   * Signal that aborts at min(deadline, now + capMs). The timer runs on the
   * real clock and does not keep the process alive.
   */
  signal(capMs: number): AbortSignal {
    const cap = Number.isFinite(capMs) ? Math.max(0, capMs) : Number.POSITIVE_INFINITY;
    const ms = Math.min(this.remainingMs(), cap);
    if (ms <= 0) return AbortSignal.abort(new DOMException('extraction deadline reached', 'TimeoutError'));
    // Node timers overflow above 2^31 - 1 ms (~24.8 days) and fire at once.
    return AbortSignal.timeout(Math.min(Math.ceil(ms), MAX_TIMER_MS));
  }
}
