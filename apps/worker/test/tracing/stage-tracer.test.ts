import { describe, expect, it } from 'vitest';
import { StageTracer, roundMs } from '../../src/tracing.js';

function fakeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
  };
}

describe('roundMs', () => {
  it.each([
    [0, 0],
    [0.04, 0],
    [0.05, 0.1],
    [1.23456, 1.2],
    [12.349, 12.3],
    [99.95, 100],
    [-5, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [Number.NEGATIVE_INFINITY, 0],
  ])('%d → %d', (input, expected) => {
    expect(roundMs(input)).toBe(expected);
  });
});

describe('StageTracer', () => {
  it('starts empty', () => {
    const clock = fakeClock();
    const tracer = new StageTracer(clock.now);
    expect(tracer.snapshot()).toEqual({ stages: {}, attempts: [], totalMs: 0 });
  });

  it('measures totalMs from construction', () => {
    const clock = fakeClock(5_000);
    const tracer = new StageTracer(clock.now);
    clock.advance(1234.5678);
    expect(tracer.snapshot().totalMs).toBe(1234.6);
  });

  it('exposes the injected clock', () => {
    const clock = fakeClock(42);
    expect(new StageTracer(clock.now).now()).toBe(42);
  });

  it('defaults to a monotonic real clock', async () => {
    const tracer = new StageTracer();
    const end = tracer.start('sleep');
    await new Promise((r) => setTimeout(r, 15));
    const ms = end();
    expect(ms).toBeGreaterThanOrEqual(10);
    expect(tracer.snapshot().totalMs).toBeGreaterThanOrEqual(ms);
  });

  describe('start()', () => {
    it('returns an end function that records and returns elapsed ms', () => {
      const clock = fakeClock();
      const tracer = new StageTracer(clock.now);
      const end = tracer.start('fetch');
      clock.advance(12.34);
      expect(end()).toBe(12.3);
      expect(tracer.snapshot().stages).toEqual({ fetch: 12.3 });
    });

    it('records once even if the end function is called repeatedly', () => {
      const clock = fakeClock();
      const tracer = new StageTracer(clock.now);
      const end = tracer.start('parse');
      clock.advance(5);
      expect(end()).toBe(5);
      clock.advance(100);
      expect(end()).toBe(5);
      expect(tracer.snapshot().stages.parse).toBe(5);
    });

    it('supports overlapping timers for different stages', () => {
      const clock = fakeClock();
      const tracer = new StageTracer(clock.now);
      const outer = tracer.start('total_fetch');
      clock.advance(2);
      const inner = tracer.start('dns');
      clock.advance(3);
      inner();
      clock.advance(4);
      outer();
      expect(tracer.snapshot().stages).toEqual({ total_fetch: 9, dns: 3 });
    });

    it('accumulates repeated timings of the same stage', () => {
      const clock = fakeClock();
      const tracer = new StageTracer(clock.now);
      for (const ms of [1.25, 2.25, 3.25]) {
        const end = tracer.start('browser_acquire');
        clock.advance(ms);
        end();
      }
      expect(tracer.snapshot().stages.browser_acquire).toBe(6.8);
    });

    it('accumulates raw durations so rounding error does not build up', () => {
      const clock = fakeClock();
      const tracer = new StageTracer(clock.now);
      for (let i = 0; i < 10; i++) {
        const end = tracer.start('tiny');
        clock.advance(0.04);
        // Each individual timing rounds to 0 ...
        expect(end()).toBe(0);
      }
      // ... but ten of them are 0.4 ms of real time.
      expect(tracer.snapshot().stages.tiny).toBe(0.4);
    });

    it('treats a clock that goes backwards as 0 ms', () => {
      const clock = fakeClock(100);
      const tracer = new StageTracer(clock.now);
      const end = tracer.start('skewed');
      clock.set(50);
      expect(end()).toBe(0);
      expect(tracer.snapshot().stages.skewed).toBe(0);
    });
  });

  describe('time()', () => {
    it('returns the function result and records the stage', async () => {
      const clock = fakeClock();
      const tracer = new StageTracer(clock.now);
      const result = await tracer.time('llm', async () => {
        clock.advance(250);
        return 'ok';
      });
      expect(result).toBe('ok');
      expect(tracer.snapshot().stages).toEqual({ llm: 250 });
    });

    it('records the stage when the function rejects, and rethrows the same error', async () => {
      const clock = fakeClock();
      const tracer = new StageTracer(clock.now);
      const boom = new Error('boom');
      await expect(
        tracer.time('fetch', async () => {
          clock.advance(40);
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(tracer.snapshot().stages).toEqual({ fetch: 40 });
    });

    it('records the stage when the function throws synchronously', async () => {
      const clock = fakeClock();
      const tracer = new StageTracer(clock.now);
      const fn = (): Promise<never> => {
        clock.advance(7);
        throw new TypeError('sync');
      };
      await expect(tracer.time('validate', fn)).rejects.toThrow('sync');
      expect(tracer.snapshot().stages.validate).toBe(7);
    });

    it('accumulates with add() and start() on the same stage', async () => {
      const clock = fakeClock();
      const tracer = new StageTracer(clock.now);
      await tracer.time('x', async () => clock.advance(1));
      tracer.add('x', 2);
      const end = tracer.start('x');
      clock.advance(3);
      end();
      expect(tracer.snapshot().stages.x).toBe(6);
    });

    it('times concurrent calls independently', async () => {
      const tracer = new StageTracer();
      await Promise.all([
        tracer.time('a', () => new Promise((r) => setTimeout(r, 20))),
        tracer.time('b', () => new Promise((r) => setTimeout(r, 5))),
      ]);
      const { stages } = tracer.snapshot();
      expect(stages.a).toBeGreaterThanOrEqual(15);
      expect(stages.b).toBeGreaterThanOrEqual(3);
      expect(stages.b).toBeLessThan(stages.a);
    });
  });

  describe('add()', () => {
    it('accumulates and rounds only on snapshot', () => {
      const tracer = new StageTracer(fakeClock().now);
      tracer.add('document', 0.33);
      tracer.add('document', 0.33);
      tracer.add('document', 0.33);
      expect(tracer.snapshot().stages.document).toBe(1);
    });

    it.each([Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      'counts invalid duration %d as 0 without poisoning the sum',
      (bad) => {
        const tracer = new StageTracer(fakeClock().now);
        tracer.add('s', 5);
        tracer.add('s', bad);
        tracer.add('s', 1);
        expect(tracer.snapshot().stages.s).toBe(6);
      },
    );

    it('registers a stage even when its only duration is invalid', () => {
      const tracer = new StageTracer(fakeClock().now);
      tracer.add('noop', Number.NaN);
      expect(tracer.snapshot().stages).toEqual({ noop: 0 });
    });

    it('keeps stages in first-recorded order', () => {
      const tracer = new StageTracer(fakeClock().now);
      tracer.add('fetch', 1);
      tracer.add('document', 1);
      tracer.add('fetch', 1);
      tracer.add('llm', 1);
      expect(Object.keys(tracer.snapshot().stages)).toEqual(['fetch', 'document', 'llm']);
    });

    it('handles prototype-like stage names as plain keys', () => {
      const tracer = new StageTracer(fakeClock().now);
      tracer.add('__proto__', 3);
      tracer.add('constructor', 4);
      tracer.add('hasOwnProperty', 5);
      const { stages } = tracer.snapshot();
      expect(Object.keys(stages)).toEqual(['__proto__', 'constructor', 'hasOwnProperty']);
      expect(Object.getOwnPropertyDescriptor(stages, '__proto__')?.value).toBe(3);
      expect(stages.constructor).toBe(4);
      expect(Object.getPrototypeOf(stages)).toBe(Object.prototype);
      expect(JSON.parse(JSON.stringify(stages))).toEqual({
        ['__proto__']: 3,
        constructor: 4,
        hasOwnProperty: 5,
      });
    });

    it('accepts an empty stage name', () => {
      const tracer = new StageTracer(fakeClock().now);
      tracer.add('', 2);
      expect(tracer.snapshot().stages).toEqual({ '': 2 });
    });
  });

  describe('recordAttempt()', () => {
    it('records attempts in order with rounded ms', () => {
      const tracer = new StageTracer(fakeClock().now);
      tracer.recordAttempt({ tier: 1, ms: 101.26, outcome: 'rejected', reason: 'low quality 0.20' });
      tracer.recordAttempt({ tier: 2, ms: 3.04, outcome: 'error', reason: 'timeout' });
      tracer.recordAttempt({ tier: 4, ms: 900, outcome: 'accepted' });
      expect(tracer.snapshot().attempts).toEqual([
        { tier: 1, ms: 101.3, outcome: 'rejected', reason: 'low quality 0.20' },
        { tier: 2, ms: 3, outcome: 'error', reason: 'timeout' },
        { tier: 4, ms: 900, outcome: 'accepted' },
      ]);
    });

    it('omits reason when absent or empty', () => {
      const tracer = new StageTracer(fakeClock().now);
      tracer.recordAttempt({ tier: 1, ms: 1, outcome: 'accepted', reason: undefined });
      tracer.recordAttempt({ tier: 1, ms: 1, outcome: 'accepted', reason: '' });
      for (const a of tracer.snapshot().attempts) expect('reason' in a).toBe(false);
    });

    it('clamps invalid durations to 0', () => {
      const tracer = new StageTracer(fakeClock().now);
      tracer.recordAttempt({ tier: 1, ms: Number.NaN, outcome: 'error' });
      tracer.recordAttempt({ tier: 1, ms: -20, outcome: 'error' });
      expect(tracer.snapshot().attempts.map((a) => a.ms)).toEqual([0, 0]);
    });

    it('copies the attempt so later caller mutation does not change history', () => {
      const tracer = new StageTracer(fakeClock().now);
      const attempt = { tier: 1, ms: 5, outcome: 'rejected' as const, reason: 'thin' };
      tracer.recordAttempt(attempt);
      attempt.tier = 9;
      attempt.reason = 'changed';
      expect(tracer.snapshot().attempts[0]).toEqual({ tier: 1, ms: 5, outcome: 'rejected', reason: 'thin' });
    });

    it('bounds reason length', () => {
      const tracer = new StageTracer(fakeClock().now);
      tracer.recordAttempt({ tier: 1, ms: 1, outcome: 'error', reason: 'x'.repeat(10_000) });
      expect(tracer.snapshot().attempts[0].reason).toHaveLength(200);
    });

    it('collapses newlines and control characters (no log injection)', () => {
      const tracer = new StageTracer(fakeClock().now);
      tracer.recordAttempt({
        tier: 2,
        ms: 1,
        outcome: 'error',
        reason: 'line one\n\r\tline\u0000two\u001b[31m  ',
      });
      expect(tracer.snapshot().attempts[0].reason).toBe('line one line two [31m');
    });

    it('redacts credentials in URLs', () => {
      const tracer = new StageTracer(fakeClock().now);
      tracer.recordAttempt({
        tier: 2,
        ms: 1,
        outcome: 'error',
        reason: 'proxy http://alice:s3cr3t@proxy.example:8080 refused; also socks5://bob@10.0.0.1',
      });
      const reason = tracer.snapshot().attempts[0].reason!;
      expect(reason).not.toContain('s3cr3t');
      expect(reason).not.toContain('alice');
      expect(reason).not.toContain('bob');
      expect(reason).toBe('proxy http://***@proxy.example:8080 refused; also socks5://***@10.0.0.1');
    });

    it('redacts credentials cut off by truncation before the "@"', () => {
      const tracer = new StageTracer(fakeClock().now);
      const prefix = 'p'.repeat(180) + ' ';
      tracer.recordAttempt({
        tier: 2,
        ms: 1,
        outcome: 'error',
        reason: `${prefix}http://user:supersecretpassword@host`,
      });
      const reason = tracer.snapshot().attempts[0].reason!;
      expect(reason.length).toBeLessThanOrEqual(200);
      expect(reason).not.toContain('user');
      expect(reason).not.toContain('supersecret');
      expect(reason.endsWith('http://***')).toBe(true);
    });

    it('leaves URLs without credentials readable', () => {
      const tracer = new StageTracer(fakeClock().now);
      tracer.recordAttempt({
        tier: 1,
        ms: 1,
        outcome: 'error',
        reason: 'GET https://example.com/a?b=c failed; mail me@example.com',
      });
      expect(tracer.snapshot().attempts[0].reason).toBe(
        'GET https://example.com/a?b=c failed; mail me@example.com',
      );
    });

    it('sanitizes adversarial reasons quickly', () => {
      const tracer = new StageTracer(fakeClock().now);
      const nasty = [
        'a'.repeat(1_000_000),
        'a://'.repeat(250_000),
        'http://' + ':'.repeat(1_000_000) + '/',
        ('x://' + ':'.repeat(40) + '/').repeat(10_000),
      ];
      const t0 = performance.now();
      for (const reason of nasty) tracer.recordAttempt({ tier: 1, ms: 1, outcome: 'error', reason });
      expect(performance.now() - t0).toBeLessThan(250);
      for (const a of tracer.snapshot().attempts) expect(a.reason!.length).toBeLessThanOrEqual(200);
    });
  });

  describe('snapshot()', () => {
    it('is a copy: mutating it does not affect the tracer', () => {
      const tracer = new StageTracer(fakeClock().now);
      tracer.add('fetch', 10);
      tracer.recordAttempt({ tier: 1, ms: 1, outcome: 'accepted' });
      const snap = tracer.snapshot();
      snap.stages.fetch = 999;
      snap.stages.injected = 1;
      snap.attempts[0].ms = 999;
      snap.attempts.push({ tier: 9, ms: 1, outcome: 'error' });
      expect(tracer.snapshot()).toEqual({
        stages: { fetch: 10 },
        attempts: [{ tier: 1, ms: 1, outcome: 'accepted' }],
        totalMs: 0,
      });
    });

    it('can be taken repeatedly while the request continues', () => {
      const clock = fakeClock();
      const tracer = new StageTracer(clock.now);
      tracer.add('fetch', 1);
      clock.advance(10);
      const first = tracer.snapshot();
      tracer.add('fetch', 2);
      clock.advance(10);
      const second = tracer.snapshot();
      expect(first).toMatchObject({ stages: { fetch: 1 }, totalMs: 10 });
      expect(second).toMatchObject({ stages: { fetch: 3 }, totalMs: 20 });
    });

    it('is JSON-serializable', () => {
      const clock = fakeClock();
      const tracer = new StageTracer(clock.now);
      tracer.add('fetch', 1.26);
      tracer.recordAttempt({ tier: 1, ms: 1.26, outcome: 'rejected', reason: 'x' });
      clock.advance(3);
      expect(JSON.parse(JSON.stringify(tracer.snapshot()))).toEqual({
        stages: { fetch: 1.3 },
        attempts: [{ tier: 1, ms: 1.3, outcome: 'rejected', reason: 'x' }],
        totalMs: 3,
      });
    });
  });
});
