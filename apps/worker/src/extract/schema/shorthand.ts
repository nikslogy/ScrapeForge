// Shorthand field definitions: {"price": "number — numeric price"}.
//
// A shorthand value is "<type> <separator> <description>", where the separator
// is an em dash, an en dash, a spaced hyphen or a colon. Types are the JSON
// types plus a few common aliases (url, date, email, int, ...), optionally
// suffixed with "[]" for arrays. Anything that does not start with a known
// type word is treated as a description of a string field, so free-text
// shorthand ({"title": "the book title"}) keeps working.

import type { JsonSchema } from '../types.js';

/** Type words accepted in shorthand and as aliases inside JSON Schema "type". */
// A Map, not an object literal: "constructor" must not resolve to a type.
const TYPE_WORDS = new Map<string, JsonSchema>([
  ['string', { type: 'string' }],
  ['str', { type: 'string' }],
  ['text', { type: 'string' }],
  ['number', { type: 'number' }],
  ['float', { type: 'number' }],
  ['double', { type: 'number' }],
  ['decimal', { type: 'number' }],
  ['numeric', { type: 'number' }],
  ['integer', { type: 'integer' }],
  ['int', { type: 'integer' }],
  ['long', { type: 'integer' }],
  ['boolean', { type: 'boolean' }],
  ['bool', { type: 'boolean' }],
  ['url', { type: 'string', format: 'uri' }],
  ['uri', { type: 'string', format: 'uri' }],
  ['link', { type: 'string', format: 'uri' }],
  ['href', { type: 'string', format: 'uri' }],
  ['date', { type: 'string', format: 'date' }],
  ['datetime', { type: 'string', format: 'date-time' }],
  ['date-time', { type: 'string', format: 'date-time' }],
  ['timestamp', { type: 'string', format: 'date-time' }],
  ['time', { type: 'string', format: 'time' }],
  ['email', { type: 'string', format: 'email' }],
  ['array', { type: 'array' }],
  ['list', { type: 'array' }],
  ['object', { type: 'object' }],
  ['any', {}],
]);

/**
 * When there is no separator, the first word alone decides the type only if
 * it is unambiguous: "text of the review" or "date of publication" read as
 * descriptions of strings, not as type declarations.
 */
const LEADING_WORD_TYPES = new Set([
  'string', 'number', 'integer', 'int', 'float', 'boolean', 'bool', 'url', 'uri', 'email', 'datetime', 'date-time', 'array', 'object',
]);

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);

// Earliest separator wins; descriptions often contain dashes or colons
// themselves ("number — rating 1–5"). No "\s*" around the alternatives: on a
// long run of spaces that would backtrack quadratically. Parts are trimmed.
const SEPARATOR = /—|–|\s-{1,2}\s|:/;

const TYPE_TOKEN = /^(?:array|list)\s*<\s*([a-z-]+)\s*>|^([a-z][a-z-]*)((?:\[\])*)\??/i;

export interface ShorthandField {
  schema: JsonSchema;
  description?: string;
}

/**
 * Expands one shorthand string into a JSON Schema (without nullability; the
 * caller decides that). Never throws: unknown types become strings.
 */
export function parseShorthandString(value: string): ShorthandField {
  const text = value.trim();
  const sep = SEPARATOR.exec(text);
  const head = sep ? text.slice(0, sep.index).trim() : text;
  const tail = sep ? text.slice(sep.index + sep[0].length).trim() : '';

  const parsed = parseTypeExpression(head);
  if (parsed && parsed.rest === '') {
    return withDescription(parsed.schema, tail || undefined);
  }

  // No usable "<type> <sep>" prefix: try a leading type word.
  const leading = parseTypeExpression(text);
  if (leading && leading.rest !== '') {
    const rest = leading.rest.trimStart();
    if (rest.startsWith('(')) {
      // "number (price in GBP)"
      let inner = rest.slice(1).trim();
      if (inner.endsWith(')')) inner = inner.slice(0, -1).trim();
      return withDescription(leading.schema, inner || undefined);
    }
    if (rest !== leading.rest && LEADING_WORD_TYPES.has(leading.word)) {
      // "number of reviews": the type is clear, the whole text is the description.
      return withDescription(leading.schema, text);
    }
  }
  return withDescription({ type: 'string' }, text || undefined);
}

interface TypeExpression {
  schema: JsonSchema;
  word: string;
  rest: string;
}

function parseTypeExpression(text: string): TypeExpression | null {
  const m = TYPE_TOKEN.exec(text.trim());
  if (!m) return null;
  const rest = text.trim().slice(m[0].length);
  if (m[1] !== undefined) {
    const item = typeWordSchema(m[1]);
    if (!item) return null;
    return { schema: { type: 'array', items: item }, word: 'array', rest };
  }
  const word = m[2].toLowerCase();
  // "string-ish" is not "string": the word must end at a word boundary.
  if (/^[a-z0-9_]/i.test(rest)) return null;
  let schema = typeWordSchema(word);
  if (!schema) return null;
  const depth = m[3].length / 2;
  for (let i = 0; i < depth; i++) schema = { type: 'array', items: schema };
  return { schema, word, rest };
}

/** Schema for a type word or alias, or null when the word is not a type. */
export function typeWordSchema(word: string): JsonSchema | null {
  const schema = TYPE_WORDS.get(word.toLowerCase());
  return schema ? { ...schema } : null;
}

/**
 * Maps a JSON Schema "type" value that is not a JSON type ("float", "url",
 * "datetime") to the equivalent schema fragment. Returns null for unknown words.
 */
export function aliasForType(word: string): { type?: string; format?: string } | null {
  const lower = word.toLowerCase();
  if (JSON_TYPES.has(lower)) return { type: lower };
  if (lower === 'any') return null;
  const schema = TYPE_WORDS.get(lower);
  if (!schema || typeof schema.type !== 'string') return null;
  return typeof schema.format === 'string' ? { type: schema.type, format: schema.format } : { type: schema.type };
}

function withDescription(schema: JsonSchema, description: string | undefined): ShorthandField {
  if (description === undefined) return { schema };
  return { schema: { ...schema, description }, description };
}
