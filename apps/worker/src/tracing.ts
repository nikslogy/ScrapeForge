// Per-request stage timing.
//
// One StageTracer lives for one request. Stage times accumulate (two waits for
// a browser context add up under "browser_acquire") and router tier attempts
// are logged in order, so one snapshot answers both "where did the time go"
// and "why did the router escalate". Snapshots feed ExtractionOutcome.timings
// and the scrapeforge_stage_duration_seconds histogram (see metrics.ts).

export type AttemptOutcome = 'accepted' | 'rejected' | 'error';

export interface TierAttempt {
  tier: number;
  ms: number;
  outcome: AttemptOutcome;
  reason?: string;
}

export interface TraceSnapshot {
  /** Stage → accumulated milliseconds, in first-recorded order. */
  stages: Record<string, number>;
  /** Tier attempts in the order they finished. */
  attempts: TierAttempt[];
  /** Wall time since the tracer was created. */
  totalMs: number;
}

// Reasons end up in API responses and logs. Error messages from fetch layers
// can carry proxy URLs (http://user:pass@host), so they are bounded and
// credential-redacted before they are stored.
const MAX_REASON_CHARS = 200;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#@]+@/gi;
// A URL cut off by truncation before its "@" may still expose "user:pass".
// The first class excludes ':' so the match cannot backtrack across colons.
const TRAILING_PARTIAL_USERINFO = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#@:]*:[^\s/?#@]*$/i;
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]+/g;

const defaultNow = (): number => performance.now();

/** Rounds to 0.1 ms; negative, NaN and infinite inputs become 0. */
export function roundMs(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms * 10) / 10 : 0;
}

function sanitizeReason(reason: string): string {
  // Truncate first so every regex below runs on bounded input.
  return reason
    .slice(0, MAX_REASON_CHARS)
    .replace(URL_USERINFO, '$1***@')
    .replace(TRAILING_PARTIAL_USERINFO, '$1***')
    .replace(WHITESPACE_OR_CONTROL, ' ')
    .trim();
}

export class StageTracer {
  private readonly startedAt: number;
  // Raw (unrounded) sums so rounding error does not build up across adds.
  private readonly stageMs = new Map<string, number>();
  private readonly attemptLog: TierAttempt[] = [];

  /**
   * @param now Monotonic clock in milliseconds. Injected in tests; callers
   *   that time work themselves (the router) read it so their durations agree
   *   with the tracer's.
   */
  constructor(readonly now: () => number = defaultNow) {
    this.startedAt = now();
  }

  /**
   * Starts timing `stage`. The returned function records the elapsed time
   * and returns it (rounded). Calling it again does not record twice.
   */
  start(stage: string): () => number {
    const t0 = this.now();
    let elapsed = -1;
    return () => {
      if (elapsed < 0) {
        const raw = this.now() - t0;
        this.add(stage, raw);
        elapsed = roundMs(raw);
      }
      return elapsed;
    };
  }

  /** Times `fn` under `stage`; the time is recorded even when `fn` throws. */
  async time<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const t0 = this.now();
    try {
      return await fn();
    } finally {
      this.add(stage, this.now() - t0);
    }
  }

  /** Adds `ms` to `stage`. Invalid durations count as 0 but still register the stage. */
  add(stage: string, ms: number): void {
    const valid = Number.isFinite(ms) && ms > 0 ? ms : 0;
    this.stageMs.set(stage, (this.stageMs.get(stage) ?? 0) + valid);
  }

  recordAttempt(attempt: TierAttempt): void {
    // Copied so the caller cannot mutate recorded history afterwards.
    const entry: TierAttempt = {
      tier: attempt.tier,
      ms: roundMs(attempt.ms),
      outcome: attempt.outcome,
    };
    if (attempt.reason) entry.reason = sanitizeReason(String(attempt.reason));
    this.attemptLog.push(entry);
  }

  snapshot(): TraceSnapshot {
    // Object.fromEntries defines own properties, so even a stage named
    // "__proto__" survives instead of silently setting the prototype.
    const stages: Record<string, number> = Object.fromEntries(
      Array.from(this.stageMs, ([stage, ms]) => [stage, roundMs(ms)]),
    );
    return {
      stages,
      attempts: this.attemptLog.map((a) => ({ ...a })),
      totalMs: roundMs(this.now() - this.startedAt),
    };
  }
}
