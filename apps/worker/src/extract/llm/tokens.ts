// Approximate token accounting for planning requests.
//
// No tokenizer is bundled: tokenizers differ per model family and the engine
// only needs a safe upper-ish estimate to decide how much page fits. The
// estimate is deliberately conservative for the text we send (rendered
// blocks: short lines, ids like "[b123]", attributes, URLs), which tokenizes
// worse than prose. It is approximate; planInputBudget adds a safety margin
// on top, and providers that report real usage are believed over it.

import type { ModelCapabilities } from '../types.js';

/** ASCII characters per token for HTML-ish / mixed text (prose is ~4). */
export const ASCII_CHARS_PER_TOKEN = 3.2;
/** Two-byte UTF-8 scripts (accented Latin, Cyrillic, Greek, Hebrew, Arabic). */
const TWO_BYTE_CHARS_PER_TOKEN = 2;
/** Chat framing per request (role markers, message separators). */
export const MESSAGE_OVERHEAD_TOKENS = 32;

/**
 * Approximate token count. CJK and other three-byte characters count one
 * token each, and an astral character (emoji) two, so non-Latin pages are
 * not underestimated by a chars/4 rule.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let twoByte = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) ascii++;
    else if (c < 0x800) twoByte++;
    // Surrogate halves land here too, so an astral character counts 2.
    else wide++;
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN + twoByte / TWO_BYTE_CHARS_PER_TOKEN + wide);
}

/** Output tokens actually requested: the caller's ask, capped by the model. */
export function effectiveMaxOutput(caps: Pick<ModelCapabilities, 'maxOutputTokens'>, requested: number): number {
  const ask = Number.isFinite(requested) ? Math.floor(requested) : caps.maxOutputTokens;
  return Math.max(1, Math.min(ask, caps.maxOutputTokens));
}

export interface InputBudgetOptions {
  systemText: string;
  /** Any other fixed text sent with the page (field list, response schema, URL line). */
  schemaText: string;
  /** Output tokens to keep free; capped by caps.maxOutputTokens. */
  reservedOutputTokens: number;
  /** Fraction of the context window kept unused to absorb estimate error (0–0.9). */
  safetyMargin?: number;
}

/**
 * Maximum tokens of page content that fit in one request to this model.
 * The output reservation is capped by the model's own output limit, so a
 * large ask does not shrink the input for a model that could never emit it.
 * Returns 0 when nothing fits.
 */
export function planInputBudget(caps: Pick<ModelCapabilities, 'contextTokens' | 'maxOutputTokens'>, opts: InputBudgetOptions): number {
  const margin = Math.min(0.9, Math.max(0, Number.isFinite(opts.safetyMargin) ? (opts.safetyMargin as number) : 0.1));
  const reserved = Math.max(0, Math.min(Number.isFinite(opts.reservedOutputTokens) ? opts.reservedOutputTokens : 0, caps.maxOutputTokens));
  // Subtracting the rounded-up margin avoids 1 - 0.9 = 0.0999… float error.
  const usable = caps.contextTokens - Math.ceil(caps.contextTokens * margin);
  const fixed = estimateTokens(opts.systemText) + estimateTokens(opts.schemaText) + MESSAGE_OVERHEAD_TOKENS;
  return Math.max(0, usable - Math.ceil(reserved) - fixed);
}
