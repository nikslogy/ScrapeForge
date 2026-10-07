import { describe, expect, it } from 'vitest';
import { runLoad, sleep } from '../lib/runner.js';

describe('runLoad', () => {
  it('runs every measured index exactly once', async () => {
    const seen: number[] = [];
    const load = await runLoad({
      total: 50,
      concurrency: 7,
      task: async (i) => {
        seen.push(i);
        await sleep(i % 3);
        return i;
      },
    });
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(load.results).toHaveLength(50);
    expect(load.errors).toEqual([]);
  });

  it('never exceeds the requested concurrency and reaches it', async () => {
    let inFlight = 0;
    let peak = 0;
    await runLoad({
      total: 40,
      concurrency: 5,
      task: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(2);
        inFlight--;
      },
    });
    expect(peak).toBe(5);
  });

  it('caps clients at the number of requests', async () => {
    let inFlight = 0;
    let peak = 0;
    const load = await runLoad({
      total: 3,
      concurrency: 20,
      task: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(1);
        inFlight--;
        return 1;
      },
    });
    expect(peak).toBe(3);
    expect(load.results).toHaveLength(3);
  });

  it('runs warm-up with negative indices and discards it', async () => {
    const indices: number[] = [];
    const load = await runLoad({
      total: 3,
      concurrency: 2,
      warmup: 4,
      task: async (i) => {
        indices.push(i);
        if (i < 0) throw new Error('warm-up failure is not reported');
        return i;
      },
    });
    expect(indices.filter((i) => i < 0).sort((a, b) => a - b)).toEqual([-4, -3, -2, -1]);
    expect(load.results.sort()).toEqual([0, 1, 2]);
    expect(load.errors).toEqual([]);
  });

  it('records failures (including non-Error throws) and keeps going', async () => {
    const load = await runLoad({
      total: 6,
      concurrency: 2,
      task: async (i) => {
        if (i === 1) throw new Error('boom');
        if (i === 2) throw 'plain string';
        if (i === 3) throw null;
        if (i === 4) throw new Error('x'.repeat(5000));
        return i;
      },
    });
    expect(load.results.sort()).toEqual([0, 5]);
    const byIndex = new Map(load.errors.map((e) => [e.index, e.message]));
    expect(byIndex.get(1)).toBe('boom');
    expect(byIndex.get(2)).toBe('plain string');
    expect(byIndex.get(3)).toBe('null');
    expect(byIndex.get(4)?.length).toBe(300);
  });

  it('handles zero requests', async () => {
    const load = await runLoad({ total: 0, concurrency: 3, task: async () => 1 });
    expect(load.results).toEqual([]);
    expect(load.throughputPerSec).toBe(0);
  });

  it('reports throughput over the measured phase only', async () => {
    const load = await runLoad({ total: 10, concurrency: 10, warmup: 10, task: () => sleep(20) });
    // 10 parallel 20 ms requests: one ~20 ms wave, not two (warm-up excluded).
    expect(load.wallMs).toBeLessThan(200);
    expect(load.throughputPerSec).toBeGreaterThan(50);
  });

  it('rejects nonsensical options', async () => {
    const task = async () => 1;
    await expect(runLoad({ total: -1, concurrency: 1, task })).rejects.toThrow(RangeError);
    await expect(runLoad({ total: 1.5, concurrency: 1, task })).rejects.toThrow(RangeError);
    await expect(runLoad({ total: 1, concurrency: 0, task })).rejects.toThrow(RangeError);
    await expect(runLoad({ total: 1, concurrency: Number.NaN, task })).rejects.toThrow(RangeError);
    await expect(runLoad({ total: 1, concurrency: 1, warmup: -2, task })).rejects.toThrow(RangeError);
  });
});

describe('sleep', () => {
  it('treats negative durations as zero', async () => {
    const t0 = performance.now();
    await sleep(-1000);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
