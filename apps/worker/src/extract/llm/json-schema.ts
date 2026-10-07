// Checks a response schema against the structured-output "strict" rules
// (OpenAI and providers that copy it): every object closes with
// additionalProperties:false and requires all of its properties, every
// subschema is typed, and only the supported keyword subset appears.
// Providers send strict:true only when this holds; otherwise the request
// would be rejected outright.

import type { JsonSchema } from '../types.js';

const MAX_OBJECT_DEPTH = 10;
const MAX_PROPERTIES = 5_000;

// Keywords strict mode does not accept (conservative list).
const UNSUPPORTED = new Set([
  'allOf', 'oneOf', 'not', 'if', 'then', 'else', 'patternProperties', 'propertyNames', 'unevaluatedProperties',
  'unevaluatedItems', 'dependentRequired', 'dependentSchemas', 'contains', 'minContains', 'maxContains',
  'minProperties', 'maxProperties', 'uniqueItems', 'prefixItems',
]);

interface WalkState {
  properties: number;
}

export function isStrictCompatible(schema: JsonSchema): boolean {
  // The root must be a plain object schema (no anyOf at the root).
  if (!isObject(schema) || schema.type !== 'object' || 'anyOf' in schema) return false;
  const defs = isObject(schema.$defs) ? schema.$defs : {};
  return walk(schema, 0, { properties: 0 }, defs, new Set());
}

function walk(
  s: unknown,
  depth: number,
  state: WalkState,
  defs: Record<string, unknown>,
  refsInProgress: Set<string>,
): boolean {
  if (!isObject(s)) return false;
  for (const k of Object.keys(s)) if (UNSUPPORTED.has(k)) return false;

  if (typeof s.$ref === 'string') {
    const m = /^#\/\$defs\/([^/]+)$/.exec(s.$ref);
    if (!m || !Object.hasOwn(defs, m[1])) return false;
    // Recursive references are allowed; checking each definition once suffices.
    if (refsInProgress.has(m[1])) return true;
    refsInProgress.add(m[1]);
    const ok = walk(defs[m[1]], depth, state, defs, refsInProgress);
    refsInProgress.delete(m[1]);
    return ok;
  }
  if (Array.isArray(s.anyOf)) {
    return s.anyOf.length > 0 && s.anyOf.every((b) => walk(b, depth, state, defs, refsInProgress));
  }
  if (Array.isArray(s.enum) || 'const' in s) return true;

  const types = typeList(s.type);
  if (types === null || types.length === 0) return false;

  if (types.includes('object')) {
    if (depth >= MAX_OBJECT_DEPTH) return false;
    if (s.additionalProperties !== false) return false;
    const props = isObject(s.properties) ? s.properties : {};
    const keys = Object.keys(props);
    const required = Array.isArray(s.required) ? s.required : [];
    if (required.length !== keys.length || !keys.every((k) => required.includes(k))) return false;
    state.properties += keys.length;
    if (state.properties > MAX_PROPERTIES) return false;
    for (const k of keys) if (!walk(props[k], depth + 1, state, defs, refsInProgress)) return false;
  }
  if (types.includes('array')) {
    if (!('items' in s) || !walk(s.items, depth + 1, state, defs, refsInProgress)) return false;
  }
  return true;
}

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

function typeList(t: unknown): string[] | null {
  const list = typeof t === 'string' ? [t] : Array.isArray(t) ? t : null;
  if (!list || !list.every((x): x is string => typeof x === 'string' && TYPES.has(x))) return null;
  return list;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
