// Admission gate used to show what a fair queue in front of the extraction
// pool would change. Piscina 5.1.4 re-appends a task it could not place to
// the tail of its queue each time a thread frees up (index.js _onWorkerAvailable
// → _distributeTask), so under saturation the oldest waiting task keeps
// rotating to the back. Holding excess tasks here, strictly in arrival order,
// keeps Piscina's own queue empty.

export class FifoGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be an integer >= 1, got ${limit}`);
  }

  get inFlight(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Joining behind existing waiters even when a slot looks free keeps FIFO strict.
    if (this.active < this.limit && this.waiters.length === 0) this.active++;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the oldest waiter; `active` is unchanged.
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}
