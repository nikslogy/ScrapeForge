// Process management for the harness: the BullMQ worker child and the
// fixture-website child (both TypeScript entries run through tsx).

import { fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { estimateOffset, wallNow, type OffsetEstimate, type PingSample } from './clock.js';
import type { ChildMessage, ParentMessage, WorkerChildConfig } from './protocol.js';

const WORKER_ENTRY = fileURLToPath(new URL('./worker-child.ts', import.meta.url));
const FIXTURE_ENTRY = fileURLToPath(new URL('./fixture-server-child.ts', import.meta.url));

/**
 * Children are TypeScript entries. Under `npx tsx` the parent's execArgv
 * already carries tsx's loader; otherwise (vitest, plain node) it is added,
 * by absolute URL so the child's cwd does not matter.
 */
export function childExecArgv(parentExecArgv: readonly string[] = process.execArgv): string[] {
  if (parentExecArgv.some((arg) => /[\\/]tsx[\\/]|^tsx$/.test(arg))) return [...parentExecArgv];
  // createRequire rather than import.meta.resolve, which vitest's module runner lacks.
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  return [...parentExecArgv, '--import', loader];
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export class WorkerHandle {
  /** jobId → worker-clock time of the worker's 'completed' event. */
  readonly completedAt = new Map<string, number>();
  readonly failures: { jobId: string; message: string }[] = [];
  readonly errors: string[] = [];
  importMs: Record<string, number> = {};
  private pings = new Map<number, (sample: PingSample) => void>();
  private nextPing = 0;

  private constructor(private child: ChildProcess) {
    child.on('message', (msg: ChildMessage) => this.onMessage(msg));
  }

  static spawn(env: NodeJS.ProcessEnv): WorkerHandle {
    return new WorkerHandle(fork(WORKER_ENTRY, [], { env, execArgv: childExecArgv(), stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
  }

  private send(msg: ParentMessage): void {
    if (this.child.connected) this.child.send(msg);
  }

  private onMessage(msg: ChildMessage): void {
    switch (msg.type) {
      case 'completed':
        this.completedAt.set(msg.jobId, msg.t);
        break;
      case 'failed':
        this.failures.push({ jobId: msg.jobId, message: msg.message });
        break;
      case 'error':
        this.errors.push(msg.message);
        break;
      case 'pong':
        this.pings.get(msg.id)?.({ t0: msg.t0, t1: msg.t1, t2: wallNow() });
        this.pings.delete(msg.id);
        break;
      default:
        break;
    }
  }

  /** Sends the config and resolves when the BullMQ worker is connected. */
  start(config: WorkerChildConfig, timeoutMs = 120_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.child.off('message', onMsg);
        this.child.off('exit', onExit);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`worker child not ready after ${timeoutMs} ms`));
      }, timeoutMs);
      const onMsg = (msg: ChildMessage) => {
        if (msg.type === 'ready') {
          cleanup();
          this.importMs = msg.importMs;
          resolve();
        } else if (msg.type === 'error') {
          cleanup();
          reject(new Error(msg.message));
        }
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`worker child exited during start (code ${code})`));
      };
      this.child.on('message', onMsg);
      this.child.once('exit', onExit);
      this.send({ type: 'start', config });
    });
  }

  private ping(): Promise<PingSample> {
    const id = this.nextPing++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pings.delete(id);
        reject(new Error('clock ping timed out'));
      }, 5_000);
      this.pings.set(id, (sample) => {
        clearTimeout(timer);
        resolve(sample);
      });
      this.send({ type: 'ping', id, t0: wallNow() });
    });
  }

  async measureClockOffset(samples = 50): Promise<OffsetEstimate> {
    const out: PingSample[] = [];
    for (let i = 0; i < samples; i++) out.push(await this.ping());
    return estimateOffset(out);
  }

  async stop(): Promise<void> {
    this.send({ type: 'stop' });
    await waitForExit(this.child, 15_000);
  }
}

export interface FixtureHandle {
  baseUrl: string;
  stop: () => Promise<void>;
}

export function spawnFixtureServer(env: NodeJS.ProcessEnv): Promise<FixtureHandle> {
  const child = fork(FIXTURE_ENTRY, [], { env, execArgv: childExecArgv(), stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('fixture server did not start within 30 s'));
    }, 30_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture server exited during start (code ${code})`));
    });
    child.on('message', (msg: { type?: string; baseUrl?: string }) => {
      if (msg?.type !== 'ready' || typeof msg.baseUrl !== 'string') return;
      clearTimeout(timer);
      resolve({
        baseUrl: msg.baseUrl,
        stop: async () => {
          if (child.connected) child.send({ type: 'stop' });
          await waitForExit(child, 5_000);
        },
      });
    });
  });
}
