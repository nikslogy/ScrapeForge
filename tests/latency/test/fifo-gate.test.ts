import { describe, expect, it } from 'vitest';
import { FifoGate } from '../lib/fifo-gate.js';
import { sleep } from '../lib/runner.js';

describe('FifoGate', () => {
  it('never admits more than the limit', async () => {
    const gate = new FifoGate(3);
    let inside = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 30 }, () =>
        gate.run(async () => {
          inside++;
          peak = Math.max(peak, inside);
          await sleep(1);
          inside--;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(gate.inFlight).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it('admits waiters strictly in arrival order', async () => {
    const gate = new FifoGate(2);
    const started: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        gate.run(async () => {
          started.push(i);
          // Later tasks finish first: admission order must not follow completion order.
          await sleep(12 - i);
        }),
      ),
    );
    expect(started).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it('does not let a newcomer overtake a waiter when a slot frees', async () => {
    const gate = new FifoGate(1);
    const order: string[] = [];
    const first = gate.run(async () => {
      await sleep(5);
      order.push('first');
    });
    const waiter = gate.run(async () => {
      order.push('waiter');
    });
    await first;
    const late = gate.run(async () => {
      order.push('late');
    });
    await Promise.all([waiter, late]);
    expect(order).toEqual(['first', 'waiter', 'late']);
  });

  it('releases the slot when the task throws, sync or async', async () => {
    const gate = new FifoGate(1);
    await expect(gate.run(async () => Promise.reject(new Error('async')))).rejects.toThrow('async');
    await expect(
      gate.run(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(await gate.run(async () => 42)).toBe(42);
    expect(gate.inFlight).toBe(0);
  });

  it('rejects invalid limits', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new FifoGate(bad)).toThrow(RangeError);
    }
  });
});
