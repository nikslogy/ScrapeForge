// Splits one queue round trip into phases. Parent timestamps are on the
// measuring process's clock; processor and 'completed' timestamps come from
// the worker child and are shifted by the measured clock offset.

import type { ProcessorTimes } from './protocol.js';

export interface RawQueueSample {
  jobId: string;
  /** Before Queue.add(). */
  addStart: number;
  /** Queue.add() resolved. */
  addEnd: number;
  /** job.waitUntilFinished() resolved. */
  resolved: number;
  /** Processor start/end on the worker clock. */
  proc: ProcessorTimes;
}

export const PHASES = [
  'enqueue',
  'pickup',
  'process',
  'finalize',
  'notify',
  'afterProcess',
  'overhead',
  'total',
] as const;

export type Phase = (typeof PHASES)[number];
export type QueuePhases = Record<Phase, number>;

/**
 * - enqueue: Queue.add() round trip (addPrioritizedJob/addStandardJob script).
 * - pickup: add resolved → processor invoked (worker wake-up + moveToActive).
 * - process: processor body.
 * - finalize: processor returned → worker 'completed' event (moveToFinished,
 *   which stores the return value and XADDs the completed event).
 * - notify: 'completed' event → waitUntilFinished resolved (QueueEvents
 *   XREAD wake-up, JSON.parse of the return value, listener dispatch).
 * - afterProcess: finalize + notify, measured directly (does not depend on
 *   the 'completed' message arriving).
 * - overhead: total − process: everything the queue adds.
 * - total: Queue.add() called → waitUntilFinished resolved.
 *
 * `completedAt` is optional (IPC message lost): finalize/notify become NaN
 * and are dropped by summarize().
 */
export function queuePhases(raw: RawQueueSample, offsetMs: number, completedAt?: number): QueuePhases {
  const procStart = raw.proc.start - offsetMs;
  const procEnd = raw.proc.end - offsetMs;
  const completed = completedAt === undefined ? Number.NaN : completedAt - offsetMs;
  const total = raw.resolved - raw.addStart;
  const process = procEnd - procStart;
  return {
    enqueue: raw.addEnd - raw.addStart,
    pickup: procStart - raw.addEnd,
    process,
    finalize: completed - procEnd,
    notify: raw.resolved - completed,
    afterProcess: raw.resolved - procEnd,
    overhead: total - process,
    total,
  };
}

/** Reads the processor timestamps a worker child embedded in a job's return value. */
export function readProcessorTimes(returnValue: unknown, field: string): ProcessorTimes {
  const times = (returnValue as Record<string, unknown> | null | undefined)?.[field] as
    | Partial<ProcessorTimes>
    | undefined;
  if (!times || typeof times.start !== 'number' || typeof times.end !== 'number') {
    throw new Error(`job return value has no processor timestamps in "${field}"`);
  }
  return times as ProcessorTimes;
}
