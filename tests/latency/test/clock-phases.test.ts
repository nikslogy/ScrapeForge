import { describe, expect, it } from 'vitest';
import { estimateOffset, wallNow } from '../lib/clock.js';
import { PHASES, queuePhases, readProcessorTimes } from '../lib/phases.js';

describe('wallNow', () => {
  it('tracks the epoch clock with sub-millisecond resolution', () => {
    expect(Math.abs(wallNow() - Date.now())).toBeLessThan(50);
    const a = wallNow();
    const b = wallNow();
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe('estimateOffset', () => {
  it('recovers a known offset from a symmetric round trip', () => {
    // Child clock runs 5 ms ahead; one-way delay 0.1 ms each way.
    const est = estimateOffset([{ t0: 1000, t1: 1005.1, t2: 1000.2 }]);
    expect(est.offsetMs).toBeCloseTo(5, 6);
    expect(est.rttMs).toBeCloseTo(0.2, 6);
  });

  it('uses the sample with the smallest round trip', () => {
    const est = estimateOffset([
      { t0: 0, t1: 50, t2: 40 }, // queued: rtt 40, biased estimate 30
      { t0: 100, t1: 100.5, t2: 101 }, // rtt 1, estimate 0
      { t0: 200, t1: 230, t2: 210 },
    ]);
    expect(est.offsetMs).toBeCloseTo(0, 6);
    expect(est.rttMs).toBe(1);
    expect(est.samples).toBe(3);
  });

  it('ignores impossible or non-finite samples and fails when none remain', () => {
    const est = estimateOffset([
      { t0: 10, t1: 11, t2: 5 }, // answer before the question
      { t0: Number.NaN, t1: 1, t2: 2 },
      { t0: 0, t1: 1, t2: 2 },
    ]);
    expect(est.samples).toBe(1);
    expect(est.offsetMs).toBe(0);
    expect(() => estimateOffset([])).toThrow('no valid clock samples');
    expect(() => estimateOffset([{ t0: 3, t1: 1, t2: 2 }])).toThrow();
  });
});

describe('queuePhases', () => {
  const raw = {
    jobId: 'job_1',
    addStart: 1000,
    addEnd: 1001,
    resolved: 1010,
    // Worker clock is 2 ms ahead of the producer clock.
    proc: { start: 1004, end: 1007 },
  };

  it('splits the round trip and corrects worker timestamps by the offset', () => {
    const p = queuePhases(raw, 2, 1010.5);
    expect(p.enqueue).toBe(1);
    expect(p.pickup).toBe(1); // 1004-2 = 1002 → 1 ms after addEnd
    expect(p.process).toBe(3);
    expect(p.finalize).toBe(3.5); // completed 1008.5 vs procEnd 1005
    expect(p.notify).toBe(1.5);
    expect(p.afterProcess).toBe(5);
    expect(p.total).toBe(10);
    expect(p.overhead).toBe(7);
    expect(p.finalize + p.notify).toBeCloseTo(p.afterProcess, 9);
    expect(Object.keys(p).sort()).toEqual([...PHASES].sort());
  });

  it('leaves finalize/notify NaN when the completed event never arrived', () => {
    const p = queuePhases(raw, 0);
    expect(p.finalize).toBeNaN();
    expect(p.notify).toBeNaN();
    expect(p.afterProcess).toBe(3);
  });
});

describe('readProcessorTimes', () => {
  it('reads the embedded timestamps', () => {
    expect(readProcessorTimes({ __latency: { start: 1, end: 2, routeMs: 3 } }, '__latency')).toEqual({
      start: 1,
      end: 2,
      routeMs: 3,
    });
  });

  it.each([null, undefined, 42, 'x', {}, { __latency: null }, { __latency: { start: '1', end: 2 } }, { __latency: { start: 1 } }])(
    'rejects a return value without usable timestamps: %j',
    (value) => {
      expect(() => readProcessorTimes(value, '__latency')).toThrow(/no processor timestamps/);
    },
  );
});
