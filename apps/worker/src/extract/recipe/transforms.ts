// Recipe transforms, compiled once per run and applied in trusted code.
//
// Number and boolean parsing delegate to validate/normalize so a recipe value
// and an LLM value for the same page text normalize identically (recipe
// outputs are compared against grounded LLM results before promotion).

import type { FieldSpec, RecipeTransform } from '../types.js';
import { normalizeValue } from '../validate/normalize.js';
import { isCurrencyWord, stripCurrencySymbols } from '../validate/numbers.js';
import { collapseWhitespace, resolveUrl } from './dom.js';
import { RECIPE_LIMITS } from './limits.js';

export type RecipeValue = string | number | boolean | null;

export interface TransformContext {
  /** Page URL as given by the caller. */
  baseUrl: string;
  /** Effective base for relative links (<base href> or page URL); null when invalid. */
  base: URL | null;
  /** Regex work allowed for the run; unbounded when absent. */
  regexBudget?: RegexBudget;
}

/**
 * Regex work of one run, charged before every regex application: the run's
 * deadline and the total input chars (RECIPE_LIMITS.maxRegexInputCharsPerRun).
 * Once `stopped` is set, every later regex application yields null and the
 * caller reports the stop.
 */
export interface RegexBudget {
  chars: number;
  deadlineMs?: number;
  stopped: 'deadline' | 'budget' | null;
}

export function newRegexBudget(deadlineMs: number | undefined): RegexBudget {
  return deadlineMs === undefined ? { chars: 0, stopped: null } : { chars: 0, deadlineMs, stopped: null };
}

function spendRegex(budget: RegexBudget, chars: number): boolean {
  if (budget.stopped) return false;
  if (budget.deadlineMs !== undefined && Date.now() > budget.deadlineMs) {
    budget.stopped = 'deadline';
  } else if (budget.chars + chars > RECIPE_LIMITS.maxRegexInputCharsPerRun) {
    budget.stopped = 'budget';
  } else {
    budget.chars += chars;
    return true;
  }
  return false;
}

export interface CompiledTransform {
  /** Step name reported in evidence. */
  step: string;
  apply(value: RecipeValue, ctx: TransformContext): RecipeValue;
}

function scalarSpec(type: 'number' | 'integer' | 'boolean'): FieldSpec {
  return { name: 'value', type, required: false, nullable: true, derived: false, schema: { type } };
}

const NUMBER_SPEC = scalarSpec('number');
const INTEGER_SPEC = scalarSpec('integer');
const BOOLEAN_SPEC = scalarSpec('boolean');

function text(value: RecipeValue): string | null {
  return value === null ? null : typeof value === 'string' ? value : String(value);
}

function stringStep(step: string, fn: (s: string, ctx: TransformContext) => RecipeValue): CompiledTransform {
  return {
    step,
    apply(value, ctx) {
      const s = text(value);
      return s === null ? null : fn(s, ctx);
    },
  };
}

function normalizeStep(step: string, spec: FieldSpec): CompiledTransform {
  return {
    step,
    apply(value, ctx) {
      if (value === null) return null;
      const result = normalizeValue(value, spec, { baseUrl: ctx.baseUrl });
      if (!result.ok) return null;
      const v = result.value;
      return typeof v === 'number' || typeof v === 'boolean' ? v : null;
    },
  };
}

function stripCurrency(s: string): string {
  const withoutSymbols = stripCurrencySymbols(s);
  return collapseWhitespace(withoutSymbols.replace(/\p{L}+/gu, (word) => (isCurrencyWord(word) ? ' ' : word)));
}

const SIMPLE: Record<string, CompiledTransform> = {
  trim: stringStep('trim', (s) => s.trim()),
  'collapse-whitespace': stringStep('collapse-whitespace', collapseWhitespace),
  lowercase: stringStep('lowercase', (s) => s.toLowerCase()),
  uppercase: stringStep('uppercase', (s) => s.toUpperCase()),
  'strip-currency': stringStep('strip-currency', stripCurrency),
  'absolute-url': stringStep('absolute-url', (s, ctx) => resolveUrl(s, ctx.base)),
  'parse-number': normalizeStep('parse-number', NUMBER_SPEC),
  'parse-integer': normalizeStep('parse-integer', INTEGER_SPEC),
  'parse-boolean': normalizeStep('parse-boolean', BOOLEAN_SPEC),
};

function regexStep(pattern: string, group: number | undefined): CompiledTransform {
  const re = new RegExp(pattern, 'u');
  // Default: the first capture group when there is one, else the whole match.
  const captures = (new RegExp(`${pattern}|`, 'u').exec('') as RegExpExecArray).length - 1;
  const index = group ?? (captures > 0 ? 1 : 0);
  return stringStep('regex', (s, ctx) => {
    const input = s.length > RECIPE_LIMITS.maxRegexInputChars ? s.slice(0, RECIPE_LIMITS.maxRegexInputChars) : s;
    if (ctx.regexBudget && !spendRegex(ctx.regexBudget, input.length)) return null;
    const m = re.exec(input);
    const hit = m?.[index];
    return hit === undefined ? null : hit;
  });
}

function mapStep(map: Record<string, string | number | boolean | null>): CompiledTransform {
  const table = new Map<string, RecipeValue>();
  for (const [key, value] of Object.entries(map)) table.set(key.trim().toLowerCase(), value);
  return stringStep('map', (s) => {
    const key = s.trim().toLowerCase();
    return table.has(key) ? (table.get(key) as RecipeValue) : null;
  });
}

/** Compiles validated transforms. Throws only on inputs validateRecipe rejects. */
export function compileTransforms(transforms: readonly RecipeTransform[] | undefined): CompiledTransform[] {
  if (!transforms) return [];
  return transforms.map((t) => {
    if (typeof t === 'string') {
      const simple = SIMPLE[t];
      if (!simple) throw new Error(`unknown transform ${t}`);
      return simple;
    }
    if ('regex' in t) return regexStep(t.regex, t.group);
    return mapStep(t.map);
  });
}

/** Applies transforms in order; `steps` receives each step name (suffixed ":no-value" when it produced null). */
export function applyTransforms(
  value: RecipeValue,
  transforms: readonly CompiledTransform[],
  ctx: TransformContext,
  steps: string[],
): RecipeValue {
  let v = value;
  for (const t of transforms) {
    if (v === null) break;
    const next = t.apply(v, ctx);
    steps.push(next === null ? `${t.step}:no-value` : t.step);
    v = next;
  }
  return v;
}
