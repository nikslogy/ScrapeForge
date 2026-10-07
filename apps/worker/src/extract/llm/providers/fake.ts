// Scripted provider for tests (engine, recipe and client tests). Never makes
// network calls; records every call it receives.

import type {
  LlmErrorCategory,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ModelCapabilities,
} from '../../types.js';
import { LlmCallError, type LlmErrorDetails } from '../errors.js';

export type FakeHandler = (
  caps: ModelCapabilities,
  req: LlmRequest,
  callIndex: number,
) => LlmResponse | Promise<LlmResponse>;

export interface FakeCall {
  caps: ModelCapabilities;
  req: LlmRequest;
  callIndex: number;
}

export class FakeProvider implements LlmProvider {
  readonly name: ModelCapabilities['provider'];
  readonly calls: FakeCall[] = [];
  readonly #handler: FakeHandler;

  /** `name` lets one fake stand in for a real provider in client tests. */
  constructor(handler: FakeHandler, name: ModelCapabilities['provider'] = 'fake') {
    this.#handler = handler;
    this.name = name;
  }

  async complete(caps: ModelCapabilities, req: LlmRequest): Promise<LlmResponse> {
    const callIndex = this.calls.length;
    this.calls.push({ caps, req, callIndex });
    return this.#handler(caps, req, callIndex);
  }
}

export type FakeStep = LlmResponse | Error | FakeHandler;

/**
 * Handler that plays `steps` in order (one per call): responses are returned,
 * errors thrown, functions called. Running past the end throws, so a test
 * notices unexpected extra calls.
 */
export function scripted(...steps: FakeStep[]): FakeHandler {
  return (caps, req, callIndex) => {
    const step = steps[callIndex];
    // 'unknown' (not a plain Error, which reads as a retryable network failure).
    if (step === undefined) {
      throw new LlmCallError(`FakeProvider: unexpected call #${callIndex} to ${caps.key}`, 'unknown', caps.provider, caps.model);
    }
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(caps, req, callIndex);
    return step;
  };
}

/** Response with sensible defaults; `text` may be a string or a value to JSON-encode. */
export function fakeResponse(text: unknown = '{"records":[]}', overrides: Partial<LlmResponse> = {}): LlmResponse {
  return {
    text: typeof text === 'string' ? text : JSON.stringify(text),
    finishReason: 'stop',
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0,
    latencyMs: 1,
    ...overrides,
  };
}

export interface FakeErrorOptions extends LlmErrorDetails {
  status?: number;
  message?: string;
  provider?: string;
  model?: string;
}

/** Classified provider error as a real provider would throw it. */
export function fakeError(category: LlmErrorCategory, opts: FakeErrorOptions = {}): LlmCallError {
  const { status, message, provider = 'fake', model = 'fake-model', ...details } = opts;
  return new LlmCallError(message ?? `fake ${category}`, category, provider, model, status, details);
}

/** Capabilities for a fake model; `key` follows provider and model unless given. */
export function fakeCaps(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  const provider = overrides.provider ?? 'fake';
  const model = overrides.model ?? 'fake-model';
  return {
    key: `${provider}:${model}`,
    provider,
    model,
    contextTokens: 128_000,
    maxOutputTokens: 8_192,
    jsonMode: 'json_object',
    strictSchema: false,
    ...overrides,
  };
}

/** Resolves after `ms`, or rejects with an AbortError when `signal` fires first. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
