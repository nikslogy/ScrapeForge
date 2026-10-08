// Extraction pool limits: FIFO admission with a bounded queue, per-task
// timeouts and caller aborts (thread replaced, pool keeps serving), thread
// recycling after N tasks (also under concurrency), the input size cap and
// warm-up. Runs a real 2-thread pool from TypeScript sources with small
// limits; pipeline.test.ts covers the default configuration.
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.stubEnv('EXTRACTION_POOL_SIZE', '2');
vi.stubEnv('EXTRACTION_MAX_QUEUE', '3');
vi.stubEnv('EXTRACTION_TASK_TIMEOUT_MS', '8000');
vi.stubEnv('EXTRACTION_THREAD_MAX_TASKS', '6');
vi.stubEnv('EXTRACTION_MAX_INPUT_BYTES', '65536');
vi.stubEnv('EXTRACTION_MAX_INPUT_ELEMENTS', '3000');
const pipeline = await import('../../src/extraction/pipeline.js');
const {
  ExtractionError,
  FifoAdmission,
  extractContent,
  getExtractionPoolStats,
  readExtractionPoolConfig,
  shutdownExtractionPool,
  truncateHtmlInput,
  warmExtractionPool,
} = pipeline;

afterAll(() => shutdownExtractionPool());

const LOREM = 'Tide pools are rocky depressions along the shore that hold seawater when the tide recedes. ';
const article = (marker: string, filler = 3) =>
  `<!doctype html><html><head><title>Article ${marker}</title></head><body><article><h1>Article ${marker}</h1>` +
  `${`<p>${LOREM.repeat(2)}</p>`.repeat(filler)}<p>Marker ${marker}.</p></article></body></html>`;
// parse5 is quadratic in nesting depth: several seconds of parsing in a thread.
const SLOW_PAGE = `<html><body>${'<div>'.repeat(40_000)}<p>deep</p>${'</div>'.repeat(40_000)}</body></html>`;

describe('configuration', () => {
  it('reads limits from the environment with the documented defaults', () => {
    expect(readExtractionPoolConfig({ EXTRACTION_POOL_SIZE: '3' })).toEqual({
      threads: 3,
      threadMaxOldMb: 512,
      threadMaxTasks: 500,
      threadRecycleHeapMb: 384,
      taskTimeoutMs: 20_000,
      maxInputBytes: 10 * 1024 * 1024,
      maxInputElements: 100_000,
      maxQueue: 64,
      queueTimeoutMs: 20_000,
    });
    expect(readExtractionPoolConfig({
      EXTRACTION_POOL_SIZE: '2',
      EXTRACTION_THREAD_MAX_OLD_MB: '256',
      EXTRACTION_THREAD_MAX_TASKS: '10',
      EXTRACTION_TASK_TIMEOUT_MS: '1500',
      EXTRACTION_MAX_INPUT_BYTES: '2048',
      EXTRACTION_MAX_QUEUE: '0',
      EXTRACTION_QUEUE_TIMEOUT_MS: '750',
    })).toMatchObject({
      threadMaxOldMb: 256, threadRecycleHeapMb: 192, threadMaxTasks: 10, taskTimeoutMs: 1500, maxInputBytes: 2048, maxQueue: 0, queueTimeoutMs: 750,
    });
  });

  it('ignores malformed or out-of-range values (with a warning)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = readExtractionPoolConfig({
      EXTRACTION_POOL_SIZE: '2',
      EXTRACTION_THREAD_MAX_OLD_MB: '12', // below the 64 MB floor
      EXTRACTION_THREAD_MAX_TASKS: '1.5',
      EXTRACTION_TASK_TIMEOUT_MS: 'soon',
      EXTRACTION_THREAD_RECYCLE_HEAP_MB: '9999', // above the old-space limit
      EXTRACTION_MAX_QUEUE: '-1',
      EXTRACTION_QUEUE_TIMEOUT_MS: '0',
    });
    expect(cfg).toMatchObject({
      threadMaxOldMb: 512, threadMaxTasks: 500, taskTimeoutMs: 20_000, threadRecycleHeapMb: 384, maxQueue: 64, queueTimeoutMs: 20_000,
    });
    expect(warn).toHaveBeenCalledTimes(6);
    warn.mockRestore();
  });
});

describe('truncateHtmlInput', () => {
  it('leaves input within the limit untouched', () => {
    expect(truncateHtmlInput('abc', 3)).toEqual({ html: 'abc', truncated: false });
    expect(truncateHtmlInput('é'.repeat(10), 20)).toEqual({ html: 'é'.repeat(10), truncated: false });
  });

  it('cuts at the byte limit without splitting a character', () => {
    expect(truncateHtmlInput('abcdef', 4)).toEqual({ html: 'abcd', truncated: true });
    // é is 2 bytes, € 3, 😀 4 (a surrogate pair).
    expect(truncateHtmlInput('é'.repeat(10), 5).html).toBe('éé');
    expect(truncateHtmlInput('€€€', 7).html).toBe('€€');
    expect(truncateHtmlInput('a😀b', 4).html).toBe('a');
    expect(truncateHtmlInput('a😀b', 5).html).toBe('a😀');
    for (const s of ['x😀'.repeat(50), 'é€😀a'.repeat(40), '\ud800lone'.repeat(30)]) {
      for (let max = 1; max < 60; max++) {
        const { html, truncated } = truncateHtmlInput(s, max);
        expect(Buffer.byteLength(html)).toBeLessThanOrEqual(max);
        expect(s.startsWith(html)).toBe(true);
        expect(truncated).toBe(Buffer.byteLength(s) > max);
        expect(html.endsWith('\ud83d')).toBe(false);
      }
    }
  });
});

describe('FifoAdmission', () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  };

  it('admits in arrival order, handing a freed slot to the oldest waiter', async () => {
    const gate = new FifoAdmission(2, 10);
    const started: number[] = [];
    const releases = Array.from({ length: 6 }, deferred);
    const runs = releases.map((d, i) => gate.run(async () => { started.push(i); await d.promise; return i; }));
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(gate.waiting).toBe(4);
    releases[1]!.resolve();
    await runs[1];
    // A newcomer arriving while others wait goes to the back, even with a free slot in sight.
    const late = gate.run(async () => { started.push(99); return 99; });
    releases[0]!.resolve();
    for (const i of [2, 3, 4, 5]) releases[i]!.resolve();
    await Promise.all([...runs, late]);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 99]);
    expect(gate.inFlight).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it('rejects when the queue is full, without disturbing admitted work', async () => {
    const gate = new FifoAdmission(1, 2);
    const hold = deferred();
    const first = gate.run(() => hold.promise);
    const queued = [gate.run(async () => 1), gate.run(async () => 2)];
    await expect(gate.run(async () => 3)).rejects.toMatchObject({ name: 'ExtractionError', code: 'EXTRACTION_QUEUE_FULL' });
    hold.resolve();
    await first;
    await expect(Promise.all(queued)).resolves.toEqual([1, 2]);
  });

  it('a waiter aborted while queued leaves the queue and never runs', async () => {
    const gate = new FifoAdmission(1, 5);
    const hold = deferred();
    const first = gate.run(() => hold.promise);
    const controller = new AbortController();
    let ran = false;
    const aborted = gate.run(async () => { ran = true; }, controller.signal);
    const after = gate.run(async () => 'after');
    expect(gate.waiting).toBe(2);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(gate.waiting).toBe(1);
    hold.resolve();
    await first;
    await expect(after).resolves.toBe('after');
    expect(ran).toBe(false);
    expect(gate.inFlight).toBe(0);
  });

  it('rejects an already-aborted signal and everything after close()', async () => {
    const gate = new FifoAdmission(1, 5);
    await expect(gate.run(async () => 1, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    const hold = deferred();
    const running = gate.run(() => hold.promise);
    const waiting = gate.run(async () => 2);
    gate.close(new Error('closed'));
    await expect(waiting).rejects.toThrow('closed');
    await expect(gate.run(async () => 3)).rejects.toThrow('closed');
    hold.resolve();
    await running;
  });

  it('times out a waiter that gets no slot in time, without disturbing the others', async () => {
    const gate = new FifoAdmission(1, 5);
    const hold = deferred();
    const first = gate.run(() => hold.promise);
    let ran = false;
    const t0 = performance.now();
    const timedOut = gate.run(async () => { ran = true; }, undefined, 50);
    const patient = gate.run(async () => 'patient');
    await expect(timedOut).rejects.toMatchObject({ name: 'ExtractionError', code: 'EXTRACTION_QUEUE_TIMEOUT' });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(45);
    expect(gate.waiting).toBe(1);
    hold.resolve();
    await first;
    await expect(patient).resolves.toBe('patient');
    expect(ran).toBe(false);
    expect(gate.inFlight).toBe(0);
  });

  it('a waiter admitted before its deadline is not timed out later', async () => {
    const gate = new FifoAdmission(1, 5);
    const hold = deferred();
    const first = gate.run(() => hold.promise);
    const admitted = gate.run(() => new Promise((r) => setTimeout(() => r('done'), 80)), undefined, 40);
    hold.resolve();
    await first;
    await expect(admitted).resolves.toBe('done'); // runs past its 40 ms queue limit
  });

  it('does not accumulate abandoned waiters behind a long task', async () => {
    const gate = new FifoAdmission(1, 10);
    const hold = deferred();
    const first = gate.run(() => hold.promise);
    for (let i = 0; i < 2_000; i++) {
      const controller = new AbortController();
      const run = gate.run(async () => 1, controller.signal).catch(() => 'aborted');
      controller.abort();
      await run;
    }
    expect(gate.waiting).toBe(0);
    expect(gate.heldEntries).toBeLessThanOrEqual(33);
    const last = gate.run(async () => 'last');
    hold.resolve();
    await first;
    await expect(last).resolves.toBe('last');
  });

  it('a throwing task releases its slot', async () => {
    const gate = new FifoAdmission(1, 5);
    await expect(gate.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(gate.run(async () => 'next')).resolves.toBe('next');
    expect(gate.inFlight).toBe(0);
  });
});

describe('extraction pool with limits', () => {
  it('warms every thread so the first extraction does not wait for module loading', async () => {
    await warmExtractionPool();
    expect(getExtractionPoolStats().threadIds).toHaveLength(2);
    const t0 = performance.now();
    const r = await extractContent(article('first'), 'https://example.com/first', ['markdown']);
    expect(performance.now() - t0).toBeLessThan(400); // cold: module loading alone takes ~0.5-1 s
    expect(r.markdown).toContain('Marker first.');
  });

  it('replaces threads after their task budget, also under concurrency, without failing a task', async () => {
    const before = getExtractionPoolStats();
    // Count-based replacements happen one at a time (the next waits until the
    // previous replacement has loaded), so keep the pool busy until four have
    // gone through. Batches of 5 = 2 running + 3 queued, the queue bound.
    const deadline = Date.now() + 15_000;
    let n = 0;
    while (getExtractionPoolStats().recycledThreads - before.recycledThreads < 4 && Date.now() < deadline) {
      const batch = Array.from({ length: 5 }, () => n++);
      const results = await Promise.all(
        batch.map((i) => extractContent(article(String(i)), `https://example.com/${i}`, ['markdown', 'text'])),
      );
      results.forEach((r, j) => expect(r.markdown).toContain(`Marker ${batch[j]}.`));
    }
    const after = getExtractionPoolStats();
    expect(after.recycledThreads - before.recycledThreads).toBeGreaterThanOrEqual(4);
    expect(after.threadIds).toHaveLength(2);
    expect(after.threadIds.filter((id) => !before.threadIds.includes(id)).length).toBeGreaterThanOrEqual(2);
  });

  it('times out a runaway extraction, replaces its thread and keeps serving', async () => {
    const before = getExtractionPoolStats();
    const t0 = performance.now();
    await expect(extractContent(SLOW_PAGE, 'https://example.com/slow', ['markdown'], { timeoutMs: 400 }))
      .rejects.toMatchObject({ name: 'ExtractionError', code: 'EXTRACTION_TIMEOUT', message: expect.stringContaining('timed out after 400 ms') });
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(getExtractionPoolStats().timedOut).toBe(before.timedOut + 1);
    const r = await extractContent(article('after-timeout'), 'https://example.com/', ['markdown']);
    expect(r.markdown).toContain('Marker after-timeout.');
  });

  it("stops a running extraction when the caller's signal aborts", async () => {
    const controller = new AbortController();
    const running = extractContent(SLOW_PAGE, 'https://example.com/slow', ['markdown'], { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('job cancelled')), 200);
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    const r = await extractContent(article('after-abort'), 'https://example.com/', ['markdown']);
    expect(r.markdown).toContain('Marker after-abort.');
  });

  it('bounds the queue: rejects at once when 2 run and 3 wait, aborted waiters free their place', async () => {
    const controller = new AbortController();
    const { signal } = controller;
    const slow = Array.from({ length: 5 }, () =>
      extractContent(SLOW_PAGE, 'https://example.com/slow', ['markdown'], { signal }).catch((e: unknown) => e));
    await new Promise((r) => setTimeout(r, 20));
    expect(getExtractionPoolStats()).toMatchObject({ inFlight: 2, queued: 3 });
    const t0 = performance.now();
    await expect(extractContent(article('rejected'), 'https://example.com/', ['markdown']))
      .rejects.toMatchObject({ code: 'EXTRACTION_QUEUE_FULL' });
    expect(performance.now() - t0).toBeLessThan(250); // no waiting: the task timeout is 8 s, the queue timeout 20 s
    controller.abort();
    for (const err of await Promise.all(slow)) expect(err).toMatchObject({ name: 'AbortError' });
    expect(getExtractionPoolStats()).toMatchObject({ inFlight: 0, queued: 0 });
    const r = await extractContent(article('after-queue'), 'https://example.com/', ['markdown']);
    expect(r.markdown).toContain('Marker after-queue.');
  });

  it('rejects a queued extraction that waits longer than the queue timeout', async () => {
    const controller = new AbortController();
    const slow = Array.from({ length: 2 }, () =>
      extractContent(SLOW_PAGE, 'https://example.com/slow', ['markdown'], { signal: controller.signal }).catch((e: unknown) => e));
    const before = getExtractionPoolStats();
    const t0 = performance.now();
    await expect(extractContent(article('waits'), 'https://example.com/', ['markdown'], { queueTimeoutMs: 150 }))
      .rejects.toMatchObject({ name: 'ExtractionError', code: 'EXTRACTION_QUEUE_TIMEOUT' });
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(getExtractionPoolStats().queueTimedOut).toBe(before.queueTimedOut + 1);
    controller.abort();
    for (const err of await Promise.all(slow)) expect(err).toMatchObject({ name: 'AbortError' });
    const r = await extractContent(article('after-queue-timeout'), 'https://example.com/', ['markdown']);
    expect(r.markdown).toContain('Marker after-queue-timeout.');
  });

  it('truncates input over the byte cap and flags the result', async () => {
    const big = article('head', 1).replace('</article>', `${`<p>${LOREM}</p>`.repeat(800)}<p>TAIL-MARKER</p></article>`);
    expect(Buffer.byteLength(big)).toBeGreaterThan(65_536);
    const r = await extractContent(big, 'https://example.com/big', ['markdown', 'text']);
    expect(r.truncated).toBe(true);
    expect(r.markdown).toContain('Marker head.');
    expect(r.markdown).not.toContain('TAIL-MARKER');
    const small = await extractContent(article('small'), 'https://example.com/', ['markdown']);
    expect(small).not.toHaveProperty('truncated');
  });

  it('cuts input over the element budget in the thread and flags the result', async () => {
    // 4,000 tiny elements in well under the byte cap.
    const many = article('elements', 1).replace('</article>', `${'<span>x</span> '.repeat(4_000)}<p>TAIL-MARKER</p></article>`);
    expect(Buffer.byteLength(many)).toBeLessThan(65_536);
    const r = await extractContent(many, 'https://example.com/many', ['markdown', 'html']);
    expect(r.truncated).toBe(true);
    expect(r.markdown).toContain('Marker elements.');
    expect(r.html).not.toContain('TAIL-MARKER');
  });

  it('rejects bad arguments with clear errors', async () => {
    await expect(extractContent(undefined as unknown as string, 'https://example.com/', ['markdown'])).rejects.toThrow(TypeError);
    await expect(extractContent('<p>x</p>', 'https://example.com/', 'markdown' as never)).rejects.toThrow(TypeError);
    await expect(extractContent('<p>x</p>', 'https://example.com/', ['markdown'], { timeoutMs: 0 })).rejects.toThrow(RangeError);
    await expect(extractContent('<p>x</p>', 'https://example.com/', ['markdown'], { queueTimeoutMs: Number.NaN })).rejects.toThrow(RangeError);
    await expect(extractContent('<p>x</p>', 'https://example.com/', ['markdown'], { timeoutMs: Infinity })).rejects.toThrow(RangeError);
    // Beyond setTimeout's range: clamped, not turned into a 1 ms timeout.
    const r = await extractContent(article('long-timeouts'), 'https://example.com/', ['markdown'], { timeoutMs: 1e12, queueTimeoutMs: 1e12 });
    expect(r.markdown).toContain('Marker long-timeouts.');
  });

  it('is an ExtractionError subclass of Error with a code', () => {
    const err = new ExtractionError('EXTRACTION_TIMEOUT', 'x');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('[extraction-pool] x');
  });
});
