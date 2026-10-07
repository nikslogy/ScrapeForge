// JSON Pointer (RFC 6901) parsing and resolution for recipe `structured` reads.

import { RECIPE_LIMITS } from './limits.js';

/** Reference tokens of a pointer, or null when it is not a valid JSON pointer. */
export function parsePointer(pointer: string): string[] | null {
  if (pointer === '') return [];
  if (pointer[0] !== '/') return null;
  const tokens = pointer.slice(1).split('/');
  if (tokens.length > RECIPE_LIMITS.maxPointerSegments) return null;
  const out: string[] = [];
  for (const token of tokens) {
    // "~" must be followed by 0 or 1.
    if (/~(?![01])/.test(token)) return null;
    out.push(token.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  return out;
}

export function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

const ARRAY_INDEX = /^(?:0|[1-9]\d{0,8})$/;

/**
 * Value at the pointer, or undefined when any step is missing. Only own
 * properties are followed, so "/__proto__" or "/constructor" never reach a
 * prototype.
 */
export function resolvePointer(data: unknown, tokens: readonly string[]): unknown {
  let cur: unknown = data;
  for (const token of tokens) {
    if (Array.isArray(cur)) {
      if (!ARRAY_INDEX.test(token)) return undefined;
      const i = Number(token);
      if (i >= cur.length) return undefined;
      cur = cur[i];
    } else if (cur !== null && typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, token)) return undefined;
      cur = (cur as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return cur;
}
