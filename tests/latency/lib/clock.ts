// Cross-process timestamps.
//
// The producer (API role) and the BullMQ worker run in separate processes, as
// in production, so phase boundaries are stamped on two clocks. Both use
// `performance.timeOrigin + performance.now()`: monotonic within a process
// and anchored to the same system clock, so on one host they agree to well
// under a millisecond. The residual offset is still measured (NTP-style
// ping/pong over IPC) and subtracted, so the report can state it instead of
// assuming it.

/** Sub-millisecond epoch timestamp, comparable across processes on one host. */
export function wallNow(): number {
  return performance.timeOrigin + performance.now();
}

export interface PingSample {
  /** Parent clock when the ping was sent. */
  t0: number;
  /** Child clock when the child answered. */
  t1: number;
  /** Parent clock when the answer arrived. */
  t2: number;
}

export interface OffsetEstimate {
  /** child clock − parent clock, ms. Subtract from child timestamps. */
  offsetMs: number;
  /** Round trip of the sample the estimate came from; bounds the error to ±rtt/2. */
  rttMs: number;
  samples: number;
}

/**
 * Picks the sample with the smallest round trip (least queueing noise) and
 * assumes the answer was stamped halfway through it.
 */
export function estimateOffset(samples: readonly PingSample[]): OffsetEstimate {
  const valid = samples.filter(
    (s) => Number.isFinite(s.t0) && Number.isFinite(s.t1) && Number.isFinite(s.t2) && s.t2 >= s.t0,
  );
  if (valid.length === 0) throw new Error('no valid clock samples');
  let best = valid[0];
  for (const s of valid) if (s.t2 - s.t0 < best.t2 - best.t0) best = s;
  return {
    offsetMs: best.t1 - (best.t0 + best.t2) / 2,
    rttMs: best.t2 - best.t0,
    samples: valid.length,
  };
}
