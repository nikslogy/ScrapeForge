// Model client: runs one logical completion across the configured models
// with an explicit policy per error category, inside a shared deadline and
// spend budget. Every call made is returned as an attempt record (failures
// included), so callers can report exactly what happened and what it cost.
//
// Policy (see docs/engine/DESIGN.md, "Model selection"):
//   auth                 trip the provider for 5 min; continue with another provider
//   quota                trip provider or model (by scope) for 10 min; next model
//   rate_limit/overloaded one retry after Retry-After or 0.5–1.5 s jitter
//                        (within the deadline), then next model; a Retry-After
//                        beyond 30 s trips the model instead of waiting
//   timeout/network      one immediate retry, then next model
//   unsupported_request  one retry of the same model with a weaker JSON mode
//   input_too_large      only models with a larger context are tried next (a
//                        per-minute token allowance, scope 'model', rules out
//                        only that model)
//   output_truncated / content_filter / budget_exhausted   thrown at once
//   anything else        next model
//
// Cost cap: before every attempt the worst case (estimated input plus the
// output it may write, at registry rates) must fit the remaining spend. The
// output limit is lowered to fit; a model that cannot fit even a minimal
// answer is skipped, and when no model fits the run fails with
// budget_exhausted before calling. Models without registry rates cannot be
// checked in advance (their reported cost is still charged afterwards).

import {
  LlmError,
  type JsonMode,
  type LlmAttemptRecord,
  type LlmErrorCategory,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type ModelCapabilities,
} from '../types.js';
import type { Budget } from './budget.js';
import { defaultBreaker, type CircuitBreaker } from './breaker.js';
import { errorDetails, LlmCallError, MAX_RETRY_AFTER_MS, toLlmError } from './errors.js';
import { estimateCostUsd } from './registry.js';
import { effectiveMaxOutput, estimateTokens, MESSAGE_OVERHEAD_TOKENS } from './tokens.js';

export type LlmPurpose = LlmAttemptRecord['purpose'];

/** Attempt record plus the JSON mode used and why a retry happened. */
export interface ClientAttemptRecord extends LlmAttemptRecord {
  jsonMode: JsonMode;
  /** What changed relative to the request or the previous attempt (retries, cost-cap output limit). */
  note?: string;
}

export interface ModelClientOptions {
  /** Priority order: first is primary, the rest are fallbacks. */
  models: ModelCapabilities[];
  providers: Partial<Record<ModelCapabilities['provider'], LlmProvider>>;
  breaker?: CircuitBreaker;
  /** Backoff wait; should resolve early when `signal` (the caller's) aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Cap on one provider call (the budget deadline still applies). Default 60 s. */
  perCallTimeoutMs?: number;
  /** Source of backoff jitter, [0, 1). */
  random?: () => number;
  /** Configuration warnings to expose (e.g. from resolveModels). */
  warnings?: string[];
}

export interface CompleteOptions {
  purpose: LlmPurpose;
  budget: Budget;
  /** Approximate input tokens (system + user); models whose context cannot hold it are skipped. */
  estimatedInputTokens?: number;
}

export interface CompleteResult {
  response: LlmResponse;
  /** The model that answered, with the JSON mode actually used. */
  model: ModelCapabilities;
  attempts: ClientAttemptRecord[];
}

export const AUTH_TRIP_MS = 5 * 60_000;
export const QUOTA_TRIP_MS = 10 * 60_000;
export const DEFAULT_PER_CALL_TIMEOUT_MS = 60_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_JITTER_MS = 1_000;
// A retry that would start with less time than this left is not worth making.
const MIN_ATTEMPT_MS = 250;
// Under a cost cap, an answer smaller than this (or than the ask, if smaller)
// is not worth paying for.
const MIN_AFFORDABLE_OUTPUT_TOKENS = 256;
// Input token estimates are approximate; price them with headroom.
const INPUT_COST_MARGIN = 1.1;

const DOWNGRADE: Readonly<Record<JsonMode, JsonMode | null>> = {
  json_schema: 'json_object',
  json_object: 'none',
  none: null,
};

const CATEGORIES: ReadonlySet<string> = new Set<LlmErrorCategory>([
  'auth', 'quota', 'rate_limit', 'overloaded', 'unsupported_request', 'input_too_large', 'output_truncated',
  'empty_output', 'parse_error', 'content_filter', 'network', 'timeout', 'budget_exhausted', 'unknown',
]);

type Outcome =
  | { ok: true; response: LlmResponse; record: ClientAttemptRecord }
  | { ok: false; error: LlmError; record: ClientAttemptRecord };

interface Skip {
  reason: string;
  category: LlmErrorCategory;
}

/** Per-call state of one complete() run. */
interface RunState {
  attempts: ClientAttemptRecord[];
  skipped: string[];
  /** Providers that failed auth / account quota during this run. */
  deadProviders: Set<string>;
  /** After input_too_large: only models with a larger context are tried. */
  minContext: number;
  /** Set when the cost cap ruled out a model after the last attempt (cleared by an attempt). */
  budgetStop?: string;
  /** Largest input the cost cap would allow on a model it ruled out. */
  affordableInput?: number;
  /** Lazily computed input estimate when the caller gave none. */
  promptTokens?: number;
  schemaTokens?: number;
}

type Affordable = { ok: true; maxOutputTokens: number } | { ok: false; reason: string; inputFit: number };

export class ModelClient {
  readonly models: readonly ModelCapabilities[];
  readonly warnings: readonly string[];
  readonly #providers: Partial<Record<ModelCapabilities['provider'], LlmProvider>>;
  readonly #breaker: CircuitBreaker;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #perCallTimeoutMs: number;

  constructor(opts: ModelClientOptions) {
    this.models = [...opts.models];
    this.warnings = [...(opts.warnings ?? [])];
    this.#providers = { ...opts.providers };
    this.#breaker = opts.breaker ?? defaultBreaker;
    this.#sleep = opts.sleep ?? abortableSleep;
    this.#now = opts.now ?? Date.now;
    this.#random = opts.random ?? Math.random;
    const t = opts.perCallTimeoutMs;
    this.#perCallTimeoutMs = t !== undefined && Number.isFinite(t) && t > 0 ? t : DEFAULT_PER_CALL_TIMEOUT_MS;
  }

  async complete(req: LlmRequest, opts: CompleteOptions): Promise<CompleteResult> {
    const state: RunState = { attempts: [], skipped: [], deadProviders: new Set(), minContext: 0 };
    let last: LlmError | undefined;
    let lastSkip: Skip | undefined;

    for (const caps of this.models) {
      const skip = this.#skipReason(caps, req, opts, state);
      if (skip) {
        state.skipped.push(`${caps.key} (${skip.reason})`);
        lastSkip = skip;
        continue;
      }
      const provider = this.#providers[caps.provider] as LlmProvider;
      let mode = caps.jsonMode;
      let note: string | undefined;
      let retried = false;
      let downgraded = false;

      for (;;) {
        // The caller gave up (job cancelled), possibly during a backoff.
        if (req.signal?.aborted) throw this.#aborted(caps, state, last);
        this.#checkBudget(opts.budget, caps, state);
        const effective = mode === caps.jsonMode ? caps : { ...caps, jsonMode: mode };
        const affordable = this.#affordable(effective, req, opts, state);
        if (!affordable.ok) {
          state.skipped.push(`${caps.key} (${affordable.reason})`);
          state.budgetStop = affordable.reason;
          state.affordableInput = Math.max(state.affordableInput ?? 0, affordable.inputFit);
          break;
        }
        const requested = effectiveMaxOutput(effective, req.maxOutputTokens);
        let attemptReq = req;
        let attemptNote = note;
        if (affordable.maxOutputTokens < requested) {
          attemptReq = { ...req, maxOutputTokens: affordable.maxOutputTokens };
          const lowered = `maxOutputTokens lowered from ${requested} to ${affordable.maxOutputTokens} by the cost cap`;
          attemptNote = note ? `${note}; ${lowered}` : lowered;
        }
        state.budgetStop = undefined;
        const outcome = await this.#attempt(provider, effective, attemptReq, opts, attemptNote);
        state.attempts.push(outcome.record);
        opts.budget.charge(outcome.record.costUsd);
        if (outcome.ok) return { response: outcome.response, model: effective, attempts: state.attempts };

        const err = outcome.error;
        last = err;
        // The caller gave up (job cancelled); do not start more calls.
        if (req.signal?.aborted) throw this.#aborted(caps, state, err);
        const details = errorDetails(err);
        let retry = false;

        switch (err.category) {
          case 'auth':
            this.#breaker.trip(caps.provider, AUTH_TRIP_MS, 'auth');
            state.deadProviders.add(caps.provider);
            break;
          case 'quota': {
            const scope = details.scope ?? (err.status === 402 ? 'provider' : 'model');
            this.#breaker.trip(scope === 'provider' ? caps.provider : caps.key, QUOTA_TRIP_MS, 'quota');
            if (scope === 'provider') state.deadProviders.add(caps.provider);
            break;
          }
          case 'rate_limit':
          case 'overloaded': {
            const requested = details.requestedRetryAfterMs ?? details.retryAfterMs;
            if (requested !== undefined && requested > MAX_RETRY_AFTER_MS) {
              // The provider asked for a long pause: waiting inside this
              // request is pointless, and other requests should skip it too.
              this.#breaker.trip(caps.key, Math.min(requested, QUOTA_TRIP_MS), err.category);
              break;
            }
            if (retried) break;
            const wait = details.retryAfterMs ?? BACKOFF_MIN_MS + Math.floor(this.#random() * BACKOFF_JITTER_MS);
            if (wait + MIN_ATTEMPT_MS > opts.budget.remainingMs()) break;
            await this.#sleep(wait, req.signal);
            note = `retry after ${err.category} (waited ${wait} ms)`;
            retried = retry = true;
            break;
          }
          case 'timeout':
          case 'network':
            if (retried) break;
            note = `retry after ${err.category}`;
            retried = retry = true;
            break;
          case 'unsupported_request': {
            const weaker = DOWNGRADE[mode];
            if (downgraded || weaker === null) break;
            note = `json mode downgraded from ${mode} to ${weaker} after unsupported_request`;
            mode = weaker;
            downgraded = retry = true;
            break;
          }
          case 'input_too_large':
            // A per-minute token allowance says nothing about other models' windows.
            if (details.scope !== 'model') state.minContext = Math.max(state.minContext, caps.contextTokens);
            break;
          case 'output_truncated':
          case 'content_filter':
          case 'budget_exhausted':
            throw this.#fail(err, state);
          default:
            // empty_output, parse_error, unknown: another model may do better.
            break;
        }
        if (!retry) break;
      }
    }

    if (state.budgetStop) {
      // The cap, not a provider, ended the run: nothing left could be afforded.
      const n = state.attempts.length;
      const after = last ? ` after ${n} attempt${n === 1 ? '' : 's'}; last error: ${last.message}` : '';
      const where = last ?? this.models[0];
      throw new LlmCallError(
        `model budget exhausted: no model fits the cost cap (skipped ${state.skipped.join(', ')})${after}`,
        'budget_exhausted',
        where?.provider ?? 'none',
        where?.model ?? 'none',
        undefined,
        { attempts: state.attempts, affordableInputTokens: state.affordableInput ?? 0 },
      );
    }
    if (last) throw this.#fail(last, state, 'all models failed');
    const first = this.models[0];
    throw new LlmCallError(
      this.models.length === 0 ? 'no models configured' : `no model available: ${state.skipped.join(', ')}`,
      lastSkip?.category ?? 'unknown',
      first?.provider ?? 'none',
      first?.model ?? 'none',
      undefined,
      { attempts: state.attempts },
    );
  }

  #skipReason(caps: ModelCapabilities, req: LlmRequest, opts: CompleteOptions, state: RunState): Skip | null {
    if (!this.#providers[caps.provider]) return { reason: 'no provider adapter', category: 'unknown' };
    if (state.deadProviders.has(caps.provider)) return { reason: 'provider failed earlier in this request', category: 'auth' };
    const open = this.#breaker.get(caps.provider) ?? this.#breaker.get(caps.key);
    if (open) {
      return { reason: `circuit open: ${open.reason}`, category: CATEGORIES.has(open.reason) ? (open.reason as LlmErrorCategory) : 'unknown' };
    }
    if (state.minContext > 0 && caps.contextTokens <= state.minContext) {
      return { reason: 'context window not larger than one that rejected the input', category: 'input_too_large' };
    }
    const est = opts.estimatedInputTokens;
    if (est !== undefined && Number.isFinite(est) && est > 0) {
      if (est + effectiveMaxOutput(caps, req.maxOutputTokens) > caps.contextTokens) {
        return { reason: 'input does not fit the context window', category: 'input_too_large' };
      }
    }
    return null;
  }

  /**
   * Output tokens this attempt may ask for so that its worst-case cost
   * (input estimate with margin, plus every output token at registry rates)
   * stays within the remaining spend.
   */
  #affordable(caps: ModelCapabilities, req: LlmRequest, opts: CompleteOptions, state: RunState): Affordable {
    const requested = effectiveMaxOutput(caps, req.maxOutputTokens);
    const remaining = opts.budget.remainingUsd();
    const inRate = caps.inputCostPerMTok ?? 0;
    const outRate = caps.outputCostPerMTok ?? 0;
    if (!Number.isFinite(remaining) || (inRate <= 0 && outRate <= 0)) return { ok: true, maxOutputTokens: requested };
    const inputCost = (this.#inputEstimate(caps, req, opts, state) * INPUT_COST_MARGIN * inRate) / 1_000_000;
    const minimal = Math.min(requested, MIN_AFFORDABLE_OUTPUT_TOKENS);
    const left = remaining - inputCost;
    const fits = outRate <= 0 ? requested : Math.floor((left * 1_000_000) / outRate);
    if (left <= 0 || fits < minimal) {
      const minimalCost = inputCost + (minimal * outRate) / 1_000_000;
      // Input that would fit next to the full requested output (one token of float headroom).
      const roomForInput = remaining - (requested * outRate) / 1_000_000;
      const inputFit = inRate > 0 ? Math.max(0, Math.floor((roomForInput * 1_000_000) / (inRate * INPUT_COST_MARGIN)) - 1) : 0;
      return { ok: false, reason: `cost cap: a minimal call costs ~$${minimalCost.toFixed(6)}, $${remaining.toFixed(6)} left`, inputFit };
    }
    return { ok: true, maxOutputTokens: Math.min(requested, fits) };
  }

  /** The caller's input estimate, else one computed from the request (plus the schema in json_schema mode). */
  #inputEstimate(caps: ModelCapabilities, req: LlmRequest, opts: CompleteOptions, state: RunState): number {
    const given = opts.estimatedInputTokens;
    if (given !== undefined && Number.isFinite(given) && given > 0) return given;
    state.promptTokens ??= estimateTokens(req.system) + estimateTokens(req.user) + MESSAGE_OVERHEAD_TOKENS;
    if (caps.jsonMode !== 'json_schema' || !req.responseSchema) return state.promptTokens;
    if (state.schemaTokens === undefined) {
      let json = '';
      try {
        json = JSON.stringify(req.responseSchema) ?? '';
      } catch {
        // A schema that cannot be serialized cannot be sent either.
      }
      state.schemaTokens = estimateTokens(json);
    }
    return state.promptTokens + state.schemaTokens;
  }

  #checkBudget(budget: Budget, caps: ModelCapabilities, state: RunState): void {
    if (budget.canSpend()) return;
    const reason =
      budget.remainingMs() <= 0
        ? 'deadline reached'
        : `cost cap reached (spent $${budget.spentUsd.toFixed(6)} of $${String(budget.maxCostUsd)})`;
    throw new LlmCallError(`model budget exhausted: ${reason}`, 'budget_exhausted', caps.provider, caps.model, undefined, {
      attempts: state.attempts,
    });
  }

  async #attempt(
    provider: LlmProvider,
    caps: ModelCapabilities,
    req: LlmRequest,
    opts: CompleteOptions,
    note: string | undefined,
  ): Promise<Outcome> {
    const budgetSignal = opts.budget.signal(this.#perCallTimeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, budgetSignal]) : budgetSignal;
    const base: ClientAttemptRecord = {
      provider: caps.provider,
      model: caps.model,
      purpose: opts.purpose,
      ok: false,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 0,
      jsonMode: caps.jsonMode,
    };
    if (opts.estimatedInputTokens !== undefined) base.estimatedInputTokens = opts.estimatedInputTokens;
    if (note) base.note = note;
    const started = this.#now();

    try {
      const raw = await raceAbort(provider.complete(caps, { ...req, signal }), signal, caps);
      const response = sanitizeResponse(raw, caps);
      const record: ClientAttemptRecord = {
        ...base,
        ok: true,
        finishReason: response.finishReason,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUsd: response.costUsd,
        latencyMs: Math.max(0, this.#now() - started),
      };
      if (response.resolvedModel) record.resolvedModel = response.resolvedModel;
      if (response.resolvedProvider) record.resolvedProvider = response.resolvedProvider;

      // Partial output is never returned as if it were complete.
      if (response.finishReason === 'length' || response.finishReason === 'content_filter') {
        const category = response.finishReason === 'length' ? 'output_truncated' : 'content_filter';
        record.ok = false;
        record.errorCategory = category;
        const message =
          category === 'output_truncated'
            ? `${caps.key}: output truncated at ${response.outputTokens} tokens (finish_reason=length)`
            : `${caps.key}: output blocked by the provider's content filter`;
        const error = new LlmCallError(message, category, caps.provider, caps.model, undefined, {
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          costUsd: response.costUsd,
          finishReason: response.finishReason,
          resolvedModel: response.resolvedModel,
          resolvedProvider: response.resolvedProvider,
          ...(category === 'output_truncated' ? { partialText: response.text } : {}),
        });
        return { ok: false, error, record };
      }
      return { ok: true, response, record };
    } catch (thrown) {
      const error = toLlmError(thrown, caps, signal);
      const d = errorDetails(error);
      const inputTokens = tokenCount(d.inputTokens);
      const outputTokens = tokenCount(d.outputTokens);
      const record: ClientAttemptRecord = {
        ...base,
        errorCategory: error.category,
        inputTokens,
        outputTokens,
        costUsd: validCost(d.costUsd) ?? estimateCostUsd(caps, inputTokens, outputTokens),
        latencyMs: Math.max(0, this.#now() - started),
      };
      if (d.finishReason) record.finishReason = d.finishReason;
      if (d.resolvedModel) record.resolvedModel = d.resolvedModel;
      if (d.resolvedProvider) record.resolvedProvider = d.resolvedProvider;
      return { ok: false, error, record };
    }
  }

  #aborted(caps: ModelCapabilities, state: RunState, last: LlmError | undefined): LlmCallError {
    if (last) return this.#fail(last, state, 'aborted by the caller');
    return new LlmCallError('aborted by the caller (0 attempts)', 'timeout', caps.provider, caps.model, undefined, {
      attempts: [...state.attempts],
    });
  }

  /** Copies `err` with every attempt attached; `summary` prefixes a run summary. */
  #fail(err: LlmError, state: RunState, summary?: string): LlmCallError {
    const d = errorDetails(err);
    let message = err.message;
    if (summary) {
      const n = state.attempts.length;
      const skipped = state.skipped.length > 0 ? `; skipped ${state.skipped.join(', ')}` : '';
      message = `${summary} (${n} attempt${n === 1 ? '' : 's'}${skipped}); last error: ${err.message}`;
    }
    // partialText is non-enumerable, so the spread does not copy it.
    return new LlmCallError(message, err.category, err.provider, err.model, err.status, {
      ...d,
      partialText: d.partialText,
      attempts: [...state.attempts],
    });
  }
}

/** Waits `ms`, resolving early (and clearing the timer) when `signal` aborts. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Rejects with a timeout as soon as `signal` fires, even if the provider ignores it. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, caps: ModelCapabilities): Promise<T> {
  const timeout = () =>
    new LlmCallError(`${caps.key}: request timed out or was aborted`, 'timeout', caps.provider, caps.model);
  if (signal.aborted) {
    // The provider may still settle later; keep that from surfacing as unhandled.
    promise.catch(() => undefined);
    return Promise.reject(timeout());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timeout());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

const FINISH_REASONS: ReadonlySet<string> = new Set(['stop', 'length', 'content_filter', 'other']);

/** Guards against malformed responses from custom/fake providers. */
function sanitizeResponse(raw: unknown, caps: ModelCapabilities): LlmResponse {
  if (typeof raw !== 'object' || raw === null || typeof (raw as LlmResponse).text !== 'string') {
    throw new LlmCallError(`${caps.key}: provider returned a malformed response`, 'unknown', caps.provider, caps.model);
  }
  const r = raw as LlmResponse;
  const inputTokens = tokenCount(r.inputTokens);
  const outputTokens = tokenCount(r.outputTokens);
  const out: LlmResponse = {
    text: r.text,
    finishReason: FINISH_REASONS.has(r.finishReason) ? r.finishReason : 'other',
    inputTokens,
    outputTokens,
    // Provider-reported cost when present, else registry rates, else 0.
    costUsd: validCost(r.costUsd) ?? estimateCostUsd(caps, inputTokens, outputTokens),
    latencyMs: tokenCount(r.latencyMs),
  };
  if (typeof r.resolvedModel === 'string' && r.resolvedModel) out.resolvedModel = r.resolvedModel;
  if (typeof r.resolvedProvider === 'string' && r.resolvedProvider) out.resolvedProvider = r.resolvedProvider;
  return out;
}

function tokenCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function validCost(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}
