// Customer schema → NormalizedSchema.
//
// Accepts shorthand ({"price": "number — numeric price"}), bare
// {"properties": {...}}, and full JSON Schema (object, array of objects, or an
// object wrapping exactly one array of objects). The output is self-contained:
// local $refs are inlined, so FieldSpec.schema and recordSchema can be used on
// their own (prompts, structured-data mapping) and Ajv never sees a $ref,
// $id or $schema it could choke on. "nullable" is rewritten into plain JSON
// Schema so validation and FieldSpec.nullable always agree.
//
// Customer schemas are untrusted input that ends up compiled into code by Ajv
// and run against attacker-controlled pages, so they are bounded: size, depth,
// property count, total subschemas after $ref inlining, and regex safety.

import { createHash } from 'node:crypto';
import type { FieldSpec, FieldType, JsonSchema, NormalizedSchema, RequestedShape } from '../types.js';
import { compileError } from '../validate/ajv.js';
import { isSafeRegex, MAX_PATTERN_LENGTH } from './safe-regex.js';
import { aliasForType, parseShorthandString } from './shorthand.js';

export { isSafeRegex } from './safe-regex.js';

export type SchemaErrorCode =
  | 'invalid_schema'
  | 'schema_too_large'
  | 'schema_too_deep'
  | 'unsupported_ref'
  | 'unsafe_pattern'
  | 'empty_schema';

export class SchemaError extends Error {
  constructor(
    readonly code: SchemaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SchemaError';
  }
}

export const SCHEMA_LIMITS = {
  /** UTF-8 bytes of the serialized input. */
  maxBytes: 64 * 1024,
  /** Nested subschema levels (properties/items/anyOf/... each add one). */
  maxDepth: 10,
  /** Properties across all nesting levels, counted after $ref inlining. */
  maxProperties: 300,
  maxPatternLength: MAX_PATTERN_LENGTH,
  /**
   * Raw JSON nesting. A schema level is about two JSON levels deep, plus
   * room for enum/const/default data. Bounds every recursive walk below.
   */
  maxJsonDepth: 40,
  /** Subschemas after $ref inlining; stops "billion laughs" definitions. */
  maxSubschemas: 5_000,
} as const;

const FIELD_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

// Keywords that describe a schema without constraining values. They stay on
// the outside when a schema is wrapped to accept null.
const ANNOTATION_KEYWORDS = new Set([
  'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', '$comment',
]);

const COMBINATORS = ['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else'] as const;

// Root keys that make {"type": "string", ...} read as a (scalar) JSON Schema
// rather than shorthand with a field called "type".
const SCALAR_SCHEMA_KEYWORDS = new Set([
  'type', 'title', 'description', 'format', 'enum', 'const', 'pattern', 'minLength', 'maxLength',
  'minimum', 'maximum', 'default', 'examples', 'nullable', '$comment',
]);

/**
 * Normalizes a customer schema. Throws SchemaError with a stable `code` and a
 * message that names the offending location (JSON pointer) when there is one.
 */
export function normalizeSchema(input: unknown): NormalizedSchema {
  if (!isPlainObject(input)) throw new SchemaError('invalid_schema', 'schema must be a JSON object');
  checkJsonValue(input);
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, 'utf8') > SCHEMA_LIMITS.maxBytes) throw tooLarge();
  const hash = schemaHash(input);
  // Work on a private copy: the output never aliases caller-owned objects.
  const original = JSON.parse(serialized) as Record<string, unknown>;
  if (Object.keys(original).length === 0) throw new SchemaError('empty_schema', 'schema has no fields');

  const fromShorthand = !looksLikeJsonSchemaRoot(original);
  const compiler = new SchemaCompiler(original);
  const compiled = compiler.compile(fromShorthand ? expandShorthandObject(original, '') : original, '', 0);
  if (!isPlainObject(compiled)) {
    throw new SchemaError('invalid_schema', 'top-level schema must describe an object or an array of objects');
  }

  const { shape, wrapperKey, recordSchema, jsonSchema } = resolveShape(compiled, fromShorthand);
  const fields = buildFields(recordSchema);
  if (fields.length === 0) throw new SchemaError('empty_schema', 'schema has no fields');

  const normalized: NormalizedSchema = { jsonSchema, shape, recordSchema, fields, hash, fromShorthand };
  if (wrapperKey !== undefined) normalized.wrapperKey = wrapperKey;
  // Reject what Ajv cannot compile ("required": "x", "minimum": "5", ...) now,
  // before any extraction work is spent. Also warms the validator cache.
  const problem = compileError(normalized);
  if (problem !== null) throw new SchemaError('invalid_schema', `schema is not valid JSON Schema: ${problem}`);
  return normalized;
}

/** First 16 hex chars of sha256 over key-sorted JSON. */
export function schemaHash(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex').slice(0, 16);
}

/** JSON with object keys sorted at every level (undefined members dropped). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// ─────────────────────────────────────────────────────────────
// Input sanity (before anything recursive touches the value)
// ─────────────────────────────────────────────────────────────

/**
 * Iterative walk: JSON-compatible values only, bounded nesting, no
 * "__proto__" keys (they would turn into prototype assignments when the
 * schema is rebuilt with plain object literals). Also bails out early on
 * inputs whose strings alone exceed the size limit, before stringifying.
 */
function checkJsonValue(input: unknown): void {
  const stack: Array<[unknown, number]> = [[input, 0]];
  let minBytes = 0;
  while (stack.length > 0) {
    const [value, depth] = stack.pop()!;
    if (depth > SCHEMA_LIMITS.maxJsonDepth) {
      throw new SchemaError('schema_too_deep', `schema nesting exceeds ${SCHEMA_LIMITS.maxJsonDepth} JSON levels`);
    }
    if (typeof value === 'string') {
      minBytes += value.length + 2;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new SchemaError('invalid_schema', 'schema contains a non-finite number');
      minBytes += 1;
    } else if (typeof value === 'boolean' || value === null) {
      minBytes += 4;
    } else if (Array.isArray(value)) {
      minBytes += 2 + value.length;
      if (minBytes > SCHEMA_LIMITS.maxBytes) throw tooLarge();
      for (let i = 0; i < value.length; i++) {
        if (value[i] === undefined) throw new SchemaError('invalid_schema', 'schema arrays cannot contain undefined');
        stack.push([value[i], depth + 1]);
      }
    } else if (isPlainObject(value)) {
      minBytes += 2;
      for (const key of Object.keys(value)) {
        if (key === '__proto__') throw new SchemaError('invalid_schema', 'schema contains the reserved key "__proto__"');
        if (value[key] === undefined) continue;
        minBytes += key.length + 3;
        if (minBytes > SCHEMA_LIMITS.maxBytes) throw tooLarge();
        stack.push([value[key], depth + 1]);
      }
    } else {
      throw new SchemaError('invalid_schema', `schema contains a non-JSON value (${describeType(value)})`);
    }
    if (minBytes > SCHEMA_LIMITS.maxBytes) throw tooLarge();
  }
}

function tooLarge(): SchemaError {
  return new SchemaError('schema_too_large', `schema exceeds ${SCHEMA_LIMITS.maxBytes} bytes`);
}

function describeType(value: unknown): string {
  if (typeof value !== 'object') return typeof value;
  return (value as object).constructor?.name ?? 'object';
}

// ─────────────────────────────────────────────────────────────
// Form detection and shorthand expansion
// ─────────────────────────────────────────────────────────────

function looksLikeJsonSchemaRoot(obj: Record<string, unknown>): boolean {
  if (isPlainObject(obj.properties)) return true;
  if (typeof obj.$schema === 'string' || typeof obj.$ref === 'string') return true;
  const types = rawTypeList(obj.type);
  if (types.some((t) => t === 'object' || t === 'array')) return true;
  // {"type": "string"} is a (scalar, hence rejected) JSON Schema, while
  // {"name": "string", "type": "string"} is shorthand with a "type" field.
  return (
    types.length > 0 &&
    types.every((t) => aliasForType(t) !== null) &&
    Object.keys(obj).every((k) => SCALAR_SCHEMA_KEYWORDS.has(k))
  );
}

/** A nested shorthand value that is itself a JSON Schema (not nested shorthand). */
function looksLikeJsonSchema(obj: Record<string, unknown>): boolean {
  const types = rawTypeList(obj.type);
  if (obj.type !== undefined) return types.length > 0 && types.every((t) => aliasForType(t) !== null);
  if (isPlainObject(obj.properties)) return true;
  if (typeof obj.$ref === 'string' || Array.isArray(obj.enum) || 'const' in obj) return true;
  if (Array.isArray(obj.anyOf) || Array.isArray(obj.oneOf) || Array.isArray(obj.allOf)) return true;
  return isPlainObject(obj.items) || Array.isArray(obj.items);
}

function expandShorthandObject(obj: Record<string, unknown>, path: string): JsonSchema {
  const properties: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(obj)) {
    properties[name] = expandShorthandValue(value, `${path}/${escapePointer(name)}`);
  }
  return { type: 'object', properties };
}

/** Shorthand fields are optional and nullable; "nullable" is resolved by the compiler. */
function expandShorthandValue(value: unknown, path: string): unknown {
  if (typeof value === 'string') return { ...parseShorthandString(value).schema, nullable: true };
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new SchemaError('invalid_schema', `shorthand array at ${path} must hold exactly one item type`);
    }
    return { type: 'array', items: expandShorthandItem(value[0], `${path}/0`), nullable: true };
  }
  if (isPlainObject(value)) {
    if (looksLikeJsonSchema(value)) return { ...value, nullable: true };
    return { ...expandShorthandObject(value, path), nullable: true };
  }
  throw new SchemaError('invalid_schema', `shorthand field at ${path} must be a type string, an object or a one-item array`);
}

function expandShorthandItem(item: unknown, path: string): unknown {
  if (typeof item === 'string') return parseShorthandString(item).schema;
  if (isPlainObject(item)) return looksLikeJsonSchema(item) ? item : expandShorthandObject(item, path);
  throw new SchemaError('invalid_schema', `shorthand array item at ${path} must be a type string or an object`);
}

// ─────────────────────────────────────────────────────────────
// Compiler: limits, $ref inlining, nullable and type-alias rewriting
// ─────────────────────────────────────────────────────────────

type Subschema = JsonSchema | boolean;

class SchemaCompiler {
  private subschemas = 0;
  private properties = 0;
  private readonly refStack: string[] = [];

  constructor(private readonly root: Record<string, unknown>) {}

  compile(node: unknown, path: string, depth: number): Subschema {
    if (depth > SCHEMA_LIMITS.maxDepth) {
      throw new SchemaError('schema_too_deep', `schema nesting exceeds ${SCHEMA_LIMITS.maxDepth} levels at ${pointer(path)}`);
    }
    if (typeof node === 'boolean') return node;
    // A bare type string where a schema belongs ({"properties": {"a": "string"}})
    // is accepted as shorthand for that type, without forcing nullability.
    if (typeof node === 'string') return this.compile(parseShorthandString(node).schema, path, depth);
    if (!isPlainObject(node)) {
      throw new SchemaError('invalid_schema', `schema at ${pointer(path)} must be an object`);
    }
    if (++this.subschemas > SCHEMA_LIMITS.maxSubschemas) {
      throw new SchemaError('schema_too_large', `schema expands to more than ${SCHEMA_LIMITS.maxSubschemas} subschemas`);
    }
    for (const key of ['$dynamicRef', '$recursiveRef']) {
      if (key in node) throw new SchemaError('unsupported_ref', `${key} is not supported (at ${pointer(path)})`);
    }
    if ('$ref' in node) return this.inlineRef(node, path, depth);

    const out: JsonSchema = {};
    for (const [key, value] of Object.entries(node)) this.keyword(out, node, key, value, path, depth);
    return node.nullable === true ? makeNullable(out) : out;
  }

  private keyword(out: JsonSchema, node: Record<string, unknown>, key: string, value: unknown, path: string, depth: number): void {
    const at = `${path}/${escapePointer(key)}`;
    switch (key) {
      // Identity and definition keywords: refs are inlined, so they are dead
      // weight, and $id/$schema make Ajv throw (duplicate ids, unknown drafts).
      // $async would make Ajv return a Promise, which reads as "valid".
      case '$async':
      case '$schema':
      case '$id':
      case '$anchor':
      case '$dynamicAnchor':
      case '$recursiveAnchor':
      case '$vocabulary':
      case '$defs':
      case 'definitions':
      case 'nullable':
        return;
      case 'type':
        this.type(out, node, value, at);
        return;
      case 'pattern':
        if (typeof value !== 'string') throw new SchemaError('invalid_schema', `"pattern" at ${pointer(at)} must be a string`);
        checkPattern(value, at);
        out.pattern = value;
        return;
      case 'properties':
        out.properties = this.schemaMap(value, at, depth, true);
        return;
      case 'patternProperties':
        if (isPlainObject(value)) for (const p of Object.keys(value)) checkPattern(p, at);
        out.patternProperties = this.schemaMap(value, at, depth, false);
        return;
      case 'dependentSchemas':
        out.dependentSchemas = this.schemaMap(value, at, depth, false);
        return;
      case 'dependencies':
        if (!isPlainObject(value)) throw new SchemaError('invalid_schema', `"dependencies" at ${pointer(at)} must be an object`);
        out.dependencies = mapValues(value, (dep, name) =>
          Array.isArray(dep) ? dep : this.compile(dep, `${at}/${escapePointer(name)}`, depth + 1),
        );
        return;
      case 'items':
        out.items = Array.isArray(value)
          ? value.map((item, i) => this.compile(item, `${at}/${i}`, depth + 1))
          : this.compile(value, at, depth + 1);
        return;
      case 'allOf':
      case 'anyOf':
      case 'oneOf':
      case 'prefixItems':
        if (!Array.isArray(value) || value.length === 0) {
          throw new SchemaError('invalid_schema', `"${key}" at ${pointer(at)} must be a non-empty array`);
        }
        out[key] = value.map((item, i) => this.compile(item, `${at}/${i}`, depth + 1));
        return;
      case 'additionalProperties':
      case 'additionalItems':
      case 'unevaluatedProperties':
      case 'unevaluatedItems':
      case 'propertyNames':
      case 'contains':
      case 'contentSchema':
      case 'not':
      case 'if':
      case 'then':
      case 'else':
        out[key] = this.compile(value, at, depth + 1);
        return;
      default:
        // Annotations, data keywords (enum/const/default/examples), format,
        // numeric/string limits and vendor extensions (x-derived) pass through.
        out[key] = value;
    }
  }

  private schemaMap(value: unknown, at: string, depth: number, countProperties: boolean): Record<string, Subschema> {
    if (!isPlainObject(value)) throw new SchemaError('invalid_schema', `${pointer(at)} must be an object`);
    return mapValues(value, (sub, name) => {
      if (countProperties && ++this.properties > SCHEMA_LIMITS.maxProperties) {
        throw new SchemaError('schema_too_large', `schema has more than ${SCHEMA_LIMITS.maxProperties} properties`);
      }
      return this.compile(sub, `${at}/${escapePointer(name)}`, depth + 1);
    });
  }

  /** Maps type aliases ("float", "url", "datetime") to JSON types (+ format). */
  private type(out: JsonSchema, node: Record<string, unknown>, value: unknown, at: string): void {
    const list = Array.isArray(value) ? value : [value];
    const types: string[] = [];
    let format: string | undefined;
    for (const t of list) {
      const alias = typeof t === 'string' ? aliasForType(t) : null;
      if (!alias?.type) {
        throw new SchemaError('invalid_schema', `unknown type ${clip(JSON.stringify(t))} at ${pointer(at)}`);
      }
      if (!types.includes(alias.type)) types.push(alias.type);
      format ??= alias.format;
    }
    if (types.length === 0) return;
    out.type = Array.isArray(value) ? types : types[0];
    if (format !== undefined && node.format === undefined) out.format = format;
  }

  /**
   * Inlines a local $ref. Sibling keywords override the target's (the merge
   * json-schema-ref-parser applies to "extended" refs), so a description or
   * nullable next to a $ref is kept.
   */
  private inlineRef(node: Record<string, unknown>, path: string, depth: number): Subschema {
    const ref = node.$ref;
    if (typeof ref !== 'string' || !ref.startsWith('#/')) {
      throw new SchemaError(
        'unsupported_ref',
        `only local "#/..." $ref pointers are supported (got ${clip(JSON.stringify(ref) ?? 'undefined')} at ${pointer(path)})`,
      );
    }
    if (this.refStack.includes(ref)) {
      throw new SchemaError('unsupported_ref', `recursive $ref ${clip(JSON.stringify(ref))} is not supported`);
    }
    const target = resolvePointer(this.root, ref);
    if (target === undefined) {
      throw new SchemaError('invalid_schema', `$ref ${clip(JSON.stringify(ref))} does not resolve`);
    }
    const siblings: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) if (k !== '$ref') siblings[k] = v;
    let merged: unknown;
    if (typeof target === 'boolean') {
      merged = Object.keys(siblings).length === 0 ? target : { ...(target ? {} : { not: {} }), ...siblings };
    } else if (isPlainObject(target)) {
      merged = { ...target, ...siblings };
    } else {
      throw new SchemaError('invalid_schema', `$ref ${clip(JSON.stringify(ref))} does not point to a schema`);
    }
    this.refStack.push(ref);
    try {
      return this.compile(merged, path, depth);
    } finally {
      this.refStack.pop();
    }
  }
}

function checkPattern(pattern: string, at: string): void {
  if (pattern.length > SCHEMA_LIMITS.maxPatternLength) {
    throw new SchemaError('unsafe_pattern', `pattern at ${pointer(at)} is longer than ${SCHEMA_LIMITS.maxPatternLength} chars`);
  }
  try {
    new RegExp(pattern, 'u');
  } catch {
    throw new SchemaError('invalid_schema', `pattern at ${pointer(at)} is not a valid regular expression`);
  }
  if (!isSafeRegex(pattern)) {
    throw new SchemaError('unsafe_pattern', `pattern at ${pointer(at)} may backtrack catastrophically: ${clip(pattern)}`);
  }
}

function resolvePointer(root: unknown, ref: string): unknown {
  let current: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    } catch {
      return undefined;
    }
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d{0,8})$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isPlainObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

// ─────────────────────────────────────────────────────────────
// Nullability
// ─────────────────────────────────────────────────────────────

/**
 * Returns a schema that also accepts null, keeping every other constraint.
 * Simple typed schemas get "null" added to type (and enum); anything with
 * combinators is wrapped in anyOf so its semantics stay intact.
 */
export function makeNullable(schema: JsonSchema): JsonSchema {
  if (acceptsNull(schema)) return schema;
  const simple = COMBINATORS.every((k) => schema[k] === undefined);
  const types = typeList(schema);
  if (simple && (types.length > 0 || Array.isArray(schema.enum) || 'const' in schema)) {
    const out: JsonSchema = { ...schema };
    if (types.length > 0) out.type = [...types, 'null'];
    if ('const' in out) {
      out.enum = [out.const, null];
      delete out.const;
    } else if (Array.isArray(out.enum) && !out.enum.includes(null)) {
      out.enum = [...out.enum, null];
    }
    return out;
  }
  const onlyAnyOf = Object.keys(schema).every((k) => k === 'anyOf' || isAnnotation(k));
  if (onlyAnyOf && Array.isArray(schema.anyOf)) return { ...schema, anyOf: [...schema.anyOf, { type: 'null' }] };
  const outer: JsonSchema = {};
  const inner: JsonSchema = {};
  for (const [k, v] of Object.entries(schema)) (isAnnotation(k) ? outer : inner)[k] = v;
  return { ...outer, anyOf: [inner, { type: 'null' }] };
}

/** Structural check: true only when null certainly validates. */
export function acceptsNull(schema: Subschema, depth = 0): boolean {
  if (typeof schema === 'boolean') return schema;
  if (depth > SCHEMA_LIMITS.maxDepth) return false;
  const types = typeList(schema);
  if (types.length > 0 && !types.includes('null')) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(null)) return false;
  if ('const' in schema && schema.const !== null) return false;
  if (schema.not !== undefined || schema.if !== undefined) return false;
  if (Array.isArray(schema.allOf) && !schema.allOf.every((b) => acceptsNull(b as Subschema, depth + 1))) return false;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && !branches.some((b) => acceptsNull(b as Subschema, depth + 1))) return false;
  }
  return true;
}

function isAnnotation(key: string): boolean {
  return ANNOTATION_KEYWORDS.has(key) || key.startsWith('x-');
}

// ─────────────────────────────────────────────────────────────
// Shape and fields
// ─────────────────────────────────────────────────────────────

interface ShapeResolution {
  shape: RequestedShape;
  wrapperKey?: string;
  recordSchema: JsonSchema;
  jsonSchema: JsonSchema;
}

function resolveShape(root: JsonSchema, fromShorthand: boolean): ShapeResolution {
  const rootTypes = typeList(root);
  if (fromShorthand || isObjectSchema(root)) {
    const properties = isPlainObject(root.properties) ? root.properties : {};
    const names = Object.keys(properties);
    if (names.length === 1) {
      const items = arrayItems(properties[names[0]]);
      if (items && isObjectSchema(items)) {
        return { shape: 'array', wrapperKey: names[0], recordSchema: withObjectType(items), jsonSchema: root };
      }
    }
    if (rootTypes.includes('object') && !fromShorthand) {
      return { shape: 'object', recordSchema: root, jsonSchema: root };
    }
    const recordSchema = withObjectType(root);
    return { shape: 'auto', recordSchema, jsonSchema: { anyOf: [recordSchema, { type: 'array', items: recordSchema }] } };
  }
  if (rootTypes.includes('array')) {
    const items = arrayItems(root);
    if (!items || !isObjectSchema(items)) {
      throw new SchemaError('invalid_schema', 'a top-level array schema must have object "items"');
    }
    return { shape: 'array', recordSchema: withObjectType(items), jsonSchema: root };
  }
  throw new SchemaError('invalid_schema', 'top-level schema must describe an object or an array of objects');
}

function withObjectType(schema: JsonSchema): JsonSchema {
  return typeList(schema).length === 0 ? { type: 'object', ...schema } : schema;
}

function isObjectSchema(schema: unknown): schema is JsonSchema {
  if (!isPlainObject(schema)) return false;
  const types = typeList(schema);
  return types.includes('object') || (types.length === 0 && isPlainObject(schema.properties));
}

function arrayItems(schema: unknown): JsonSchema | null {
  if (!isPlainObject(schema) || !isPlainObject(schema.items)) return null;
  const types = typeList(schema);
  return types.includes('array') || types.length === 0 ? schema.items : null;
}

function buildFields(record: JsonSchema): FieldSpec[] {
  const properties = new Map<string, Subschema>();
  const required = new Set<string>();
  collectProperties(record, properties, required, 0);
  return [...properties].map(([name, schema]) => buildField(name, schema, required.has(name)));
}

/** Properties of the record, including ones declared in allOf branches. */
function collectProperties(schema: unknown, properties: Map<string, Subschema>, required: Set<string>, depth: number): void {
  if (!isPlainObject(schema) || depth > 3) return;
  if (isPlainObject(schema.properties)) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      if (!properties.has(name)) properties.set(name, sub as Subschema);
    }
  }
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) if (typeof name === 'string') required.add(name);
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) collectProperties(branch, properties, required, depth + 1);
  }
}

function buildField(name: string, sub: Subschema, required: boolean): FieldSpec {
  const schema: JsonSchema = sub === true ? {} : sub === false ? { not: {} } : sub;
  const field: FieldSpec = {
    name,
    type: inferType(schema, 0),
    required,
    nullable: acceptsNull(schema),
    derived: schema['x-derived'] === true,
    schema,
  };
  if (field.type === 'array') field.itemType = inferItemType(schema);
  const description =
    typeof schema.description === 'string' ? schema.description : typeof schema.title === 'string' ? schema.title : undefined;
  if (description !== undefined) field.description = description;
  return field;
}

function inferType(schema: JsonSchema, depth: number): FieldType {
  const types = typeList(schema).filter((t) => t !== 'null');
  if (types.length > 0) return FIELD_TYPES.has(types[0]) ? (types[0] as FieldType) : 'unknown';
  if (Array.isArray(schema.enum)) return inferFromValues(schema.enum);
  if ('const' in schema) return inferFromValues([schema.const]);
  if (isPlainObject(schema.properties)) return 'object';
  if (schema.items !== undefined || Array.isArray(schema.prefixItems)) return 'array';
  if (typeof schema.format === 'string') return 'string';
  if (depth >= SCHEMA_LIMITS.maxDepth) return 'unknown';
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    const found = new Set<FieldType>();
    for (const branch of branches) {
      if (isPlainObject(branch) && !isNullOnly(branch)) found.add(inferType(branch, depth + 1));
    }
    if (found.size === 1) return [...found][0];
    if (found.size > 1) return 'unknown';
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      if (!isPlainObject(branch)) continue;
      const t = inferType(branch, depth + 1);
      if (t !== 'unknown') return t;
    }
  }
  return 'unknown';
}

function inferItemType(schema: JsonSchema): FieldType {
  const arraySchema = findArraySchema(schema, 0);
  if (!arraySchema) return 'unknown';
  return isPlainObject(arraySchema.items) ? inferType(arraySchema.items, 0) : 'unknown';
}

function findArraySchema(schema: JsonSchema, depth: number): JsonSchema | null {
  if (typeList(schema).includes('array') || schema.items !== undefined) return schema;
  if (depth >= 3) return null;
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (!isPlainObject(branch)) continue;
      const found = findArraySchema(branch, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function inferFromValues(values: unknown[]): FieldType {
  const present = values.filter((v) => v !== null);
  if (present.length === 0) return 'unknown';
  if (present.every((v) => typeof v === 'string')) return 'string';
  if (present.every((v) => typeof v === 'number')) {
    return present.every((v) => Number.isInteger(v)) ? 'integer' : 'number';
  }
  if (present.every((v) => typeof v === 'boolean')) return 'boolean';
  if (present.every((v) => Array.isArray(v))) return 'array';
  if (present.every((v) => isPlainObject(v))) return 'object';
  return 'unknown';
}

function isNullOnly(schema: JsonSchema): boolean {
  const types = typeList(schema);
  if (types.length === 1 && types[0] === 'null') return true;
  if ('const' in schema && schema.const === null) return true;
  return Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((v) => v === null);
}

// ─────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function typeList(schema: JsonSchema): string[] {
  return rawTypeList(schema.type);
}

function rawTypeList(type: unknown): string[] {
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === 'string');
  return [];
}

function mapValues<T>(obj: Record<string, unknown>, fn: (value: unknown, key: string) => T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(obj)) out[key] = fn(value, key);
  return out;
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function pointer(path: string): string {
  return clip(path === '' ? '/' : path, 120);
}

function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
