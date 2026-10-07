// Strict validation of declarative extraction recipes.
//
// A recipe is data, never code: CSS selectors, attribute names, JSON pointers
// and an allowlist of transforms. Anything outside that grammar (unknown keys,
// function-like strings, unsafe regexes, expensive selectors) is rejected
// with a readable error, so a model-written or stored recipe either passes
// completely or is not used at all. Accepted recipes are returned as a deep
// frozen copy holding only known keys, which the interpreter can trust
// without validating again.

import type { ExtractionRecipe, RecipeField, RecipeTransform } from '../types.js';
import { RECIPE_LIMITS } from './limits.js';
import { parsePointer } from './pointer.js';
import { checkRegex } from './safe-regex.js';
import { checkSelector } from './selector.js';

export type RecipeValidation = { ok: true; recipe: ExtractionRecipe } | { ok: false; errors: string[] };

export const SIMPLE_TRANSFORMS: ReadonlySet<string> = new Set([
  'trim',
  'collapse-whitespace',
  'lowercase',
  'uppercase',
  'strip-currency',
  'parse-number',
  'parse-integer',
  'parse-boolean',
  'absolute-url',
]);

/** Transforms that turn text into a typed value; nothing may follow them. */
const TERMINAL_TRANSFORMS = new Set(['parse-number', 'parse-integer', 'parse-boolean']);

const ATTR_NAME = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const RECIPE_KEYS = new Set(['version', 'shape', 'recordSelector', 'scopeSelector', 'fields']);
const FIELD_KEYS = new Set(['selector', 'attr', 'structured', 'all', 'transforms']);
const STRUCTURED_KEYS = new Set(['type', 'pointer']);
const MAX_ERRORS = 50;

/**
 * Names that would collide with Object.prototype members when used as an
 * output key ("__proto__" would even replace the record's prototype).
 */
const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  '__proto__',
  'prototype',
]);

/** True for names a recipe field (and so an output key) may not have. */
export function isReservedFieldName(name: string): boolean {
  return RESERVED_FIELD_NAMES.has(name);
}

const trusted = new WeakSet<object>();

/** True for recipe objects returned by a successful validateRecipe (deep frozen). */
export function isValidatedRecipe(recipe: unknown): boolean {
  return typeof recipe === 'object' && recipe !== null && trusted.has(recipe);
}

export function validateRecipe(input: unknown, fieldNames?: string[]): RecipeValidation {
  const errors = new ErrorList();
  let recipe: ExtractionRecipe | undefined;
  try {
    recipe = readRecipe(input, fieldNames, errors);
  } catch (err) {
    // Exotic inputs (throwing getters, proxies) are invalid, not fatal.
    errors.add('recipe', `could not be read: ${(err as Error).message}`);
  }
  if (errors.items.length > 0 || !recipe) return { ok: false, errors: errors.items };
  deepFreeze(recipe);
  trusted.add(recipe);
  return { ok: true, recipe };
}

class ErrorList {
  items: string[] = [];
  /** Regex transforms seen so far (capped per recipe). */
  regexes = 0;

  add(path: string, message: string): void {
    if (this.items.length < MAX_ERRORS) this.items.push(`${path}: ${message}`);
    else if (this.items.length === MAX_ERRORS) this.items.push('…more errors omitted');
  }
}

function readRecipe(input: unknown, fieldNames: string[] | undefined, errors: ErrorList): ExtractionRecipe | undefined {
  if (!isPlainObject(input)) {
    errors.add('recipe', 'must be a JSON object');
    return undefined;
  }
  unknownKeys(input, RECIPE_KEYS, 'recipe', errors);
  if (input.version !== 1) errors.add('version', 'must be 1');
  const shape = input.shape;
  if (shape !== 'object' && shape !== 'array') errors.add('shape', 'must be "object" or "array"');

  const out: ExtractionRecipe = { version: 1, shape: shape === 'array' ? 'array' : 'object', fields: {} };
  if (shape === 'array') {
    if (input.recordSelector === undefined) {
      errors.add('recordSelector', 'is required for shape "array"');
    } else {
      const sel = readSelector(input.recordSelector, false, 'recordSelector', errors);
      if (sel !== undefined) out.recordSelector = sel;
    }
  } else if (input.recordSelector !== undefined) {
    errors.add('recordSelector', 'is only allowed for shape "array"');
  }
  if (input.scopeSelector !== undefined) {
    if (shape !== 'object') {
      errors.add('scopeSelector', 'is only allowed for shape "object"');
    } else {
      const sel = readSelector(input.scopeSelector, false, 'scopeSelector', errors);
      if (sel !== undefined) out.scopeSelector = sel;
    }
  }
  const fields = readFields(input.fields, fieldNames, errors);
  if (fields) out.fields = fields;
  return out;
}

function readFields(
  input: unknown,
  fieldNames: string[] | undefined,
  errors: ErrorList,
): Record<string, RecipeField> | undefined {
  if (!isPlainObject(input)) {
    errors.add('fields', 'must be an object of field name → field');
    return undefined;
  }
  const names = Object.keys(input);
  if (names.length === 0) errors.add('fields', 'must define at least one field');
  if (names.length > RECIPE_LIMITS.maxFields) {
    errors.add('fields', `more than ${RECIPE_LIMITS.maxFields} fields`);
    return undefined;
  }
  const allowed = fieldNames ? new Set(fieldNames) : undefined;
  const entries: Array<[string, RecipeField]> = [];
  for (const name of names) {
    const path = `fields[${quote(name)}]`;
    if (!checkFieldName(name, path, errors)) continue;
    if (allowed && !allowed.has(name)) {
      errors.add(path, 'is not a field of the schema');
      continue;
    }
    const field = readField(input[name], path, errors);
    if (field) entries.push([name, field]);
  }
  // fromEntries defines own properties, so even unusual names cannot reach a setter.
  return Object.fromEntries(entries);
}

function checkFieldName(name: string, path: string, errors: ErrorList): boolean {
  if (name.length === 0 || name.length > RECIPE_LIMITS.maxFieldNameChars) {
    errors.add(path, `field names must be 1-${RECIPE_LIMITS.maxFieldNameChars} chars`);
    return false;
  }
  if (CONTROL_CHARS.test(name)) {
    errors.add(path, 'field name contains control characters');
    return false;
  }
  if (RESERVED_FIELD_NAMES.has(name)) {
    errors.add(path, 'is a reserved name');
    return false;
  }
  return true;
}

function readField(input: unknown, path: string, errors: ErrorList): RecipeField | undefined {
  if (!isPlainObject(input)) {
    errors.add(path, 'must be an object');
    return undefined;
  }
  unknownKeys(input, FIELD_KEYS, path, errors);
  const out: RecipeField = {};
  if (input.selector !== undefined) {
    const sel = readSelector(input.selector, true, `${path}.selector`, errors);
    if (sel !== undefined) out.selector = sel;
  }
  if (input.attr !== undefined) {
    const attr = input.attr;
    if (typeof attr !== 'string' || attr.length > RECIPE_LIMITS.maxAttrNameChars || !ATTR_NAME.test(attr)) {
      errors.add(`${path}.attr`, 'must be an attribute name');
    } else {
      out.attr = attr;
    }
  }
  if (input.structured !== undefined) {
    const structured = readStructured(input.structured, `${path}.structured`, errors);
    if (structured) out.structured = structured;
  }
  if (input.all !== undefined) {
    if (typeof input.all !== 'boolean') errors.add(`${path}.all`, 'must be a boolean');
    else out.all = input.all;
  }
  if (input.transforms !== undefined) {
    const transforms = readTransforms(input.transforms, `${path}.transforms`, errors);
    if (transforms) out.transforms = transforms;
  }
  return out;
}

function readSelector(input: unknown, relative: boolean, path: string, errors: ErrorList): string | undefined {
  const problem = checkSelector(input, { relative });
  if (problem) {
    errors.add(path, problem);
    return undefined;
  }
  return (input as string).trim();
}

function readStructured(input: unknown, path: string, errors: ErrorList): RecipeField['structured'] | undefined {
  if (!isPlainObject(input)) {
    errors.add(path, 'must be an object with a "pointer"');
    return undefined;
  }
  unknownKeys(input, STRUCTURED_KEYS, path, errors);
  const { pointer, type } = input;
  let ok = true;
  if (typeof pointer !== 'string' || pointer.length > RECIPE_LIMITS.maxPointerChars || parsePointer(pointer) === null) {
    errors.add(`${path}.pointer`, `must be a JSON pointer of at most ${RECIPE_LIMITS.maxPointerChars} chars`);
    ok = false;
  }
  if (type !== undefined) {
    if (typeof type !== 'string' || type.length === 0 || type.length > RECIPE_LIMITS.maxStructuredTypeChars || CONTROL_CHARS.test(type)) {
      errors.add(`${path}.type`, `must be a type name of 1-${RECIPE_LIMITS.maxStructuredTypeChars} chars`);
      ok = false;
    }
  }
  if (!ok) return undefined;
  return type === undefined ? { pointer: pointer as string } : { type: type as string, pointer: pointer as string };
}

function readTransforms(input: unknown, path: string, errors: ErrorList): RecipeTransform[] | undefined {
  if (!Array.isArray(input)) {
    errors.add(path, 'must be an array');
    return undefined;
  }
  if (input.length > RECIPE_LIMITS.maxTransforms) {
    errors.add(path, `more than ${RECIPE_LIMITS.maxTransforms} transforms`);
    return undefined;
  }
  const out: RecipeTransform[] = [];
  let terminal: string | undefined;
  input.forEach((t: unknown, i: number) => {
    const at = `${path}[${i}]`;
    if (terminal) errors.add(at, `nothing may follow "${terminal}"`);
    const transform = readTransform(t, at, errors);
    if (transform === undefined) return;
    if (typeof transform === 'string' && TERMINAL_TRANSFORMS.has(transform)) terminal = transform;
    out.push(transform);
  });
  return out;
}

function readTransform(input: unknown, path: string, errors: ErrorList): RecipeTransform | undefined {
  if (typeof input === 'string') {
    if (SIMPLE_TRANSFORMS.has(input)) return input as RecipeTransform;
    errors.add(path, `unknown transform ${quote(input)}`);
    return undefined;
  }
  if (!isPlainObject(input)) {
    errors.add(path, 'must be a transform name, {"regex": ...} or {"map": ...}');
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'regex')) {
    unknownKeys(input, new Set(['regex', 'group']), path, errors);
    return readRegex(input, path, errors);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'map')) {
    unknownKeys(input, new Set(['map']), path, errors);
    return readMap(input.map, `${path}.map`, errors);
  }
  errors.add(path, 'must be a transform name, {"regex": ...} or {"map": ...}');
  return undefined;
}

function readRegex(input: Record<string, unknown>, path: string, errors: ErrorList): RecipeTransform | undefined {
  const pattern = input.regex;
  if (typeof pattern !== 'string') {
    errors.add(`${path}.regex`, 'must be a string');
    return undefined;
  }
  if (++errors.regexes > RECIPE_LIMITS.maxRegexesPerRecipe) {
    errors.add(`${path}.regex`, `more than ${RECIPE_LIMITS.maxRegexesPerRecipe} regex transforms in the recipe`);
    return undefined;
  }
  const check = checkRegex(pattern);
  if (!check.ok) {
    errors.add(`${path}.regex`, check.reason);
    return undefined;
  }
  const group = input.group;
  if (group === undefined) return { regex: pattern };
  if (typeof group !== 'number' || !Number.isInteger(group) || group < 0 || group > 9) {
    errors.add(`${path}.group`, 'must be an integer from 0 to 9');
    return undefined;
  }
  if (group > check.captureGroups) {
    errors.add(`${path}.group`, `pattern has only ${check.captureGroups} capture group(s)`);
    return undefined;
  }
  return { regex: pattern, group };
}

function readMap(input: unknown, path: string, errors: ErrorList): RecipeTransform | undefined {
  if (!isPlainObject(input)) {
    errors.add(path, 'must be an object of text → value');
    return undefined;
  }
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.length > RECIPE_LIMITS.maxMapEntries) {
    errors.add(path, `must have 1-${RECIPE_LIMITS.maxMapEntries} entries`);
    return undefined;
  }
  const entries: Array<[string, string | number | boolean | null]> = [];
  for (const key of keys) {
    const value = input[key];
    if (key.length > RECIPE_LIMITS.maxMapKeyChars) {
      errors.add(path, `keys must be at most ${RECIPE_LIMITS.maxMapKeyChars} chars`);
      return undefined;
    }
    const scalar =
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= RECIPE_LIMITS.maxMapValueChars);
    if (!scalar) {
      errors.add(`${path}[${quote(key)}]`, `must be a string (≤ ${RECIPE_LIMITS.maxMapValueChars} chars), finite number, boolean or null`);
      return undefined;
    }
    entries.push([key, value as string | number | boolean | null]);
  }
  return { map: Object.fromEntries(entries) };
}

function unknownKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>, path: string, errors: ErrorList): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors.add(path, `unknown key ${quote(key)}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function quote(s: string): string {
  return JSON.stringify(s.length > 60 ? `${s.slice(0, 60)}…` : s);
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
}
