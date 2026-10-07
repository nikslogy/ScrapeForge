// Hand-built SourceDocument / NormalizedSchema fixtures for the structured
// mapper tests (the document and schema builders are tested separately).

import type {
  FieldSpec,
  FieldType,
  NormalizedSchema,
  RequestedShape,
  SourceBlock,
  SourceDocument,
  StructuredDataItem,
  StructuredSource,
} from '../../src/extract/types.js';

export interface ItemInput {
  source: StructuredSource;
  data: unknown;
  type?: string;
}

function tail(v: unknown): string | undefined {
  const first = Array.isArray(v) ? v.find((x) => typeof x === 'string') : v;
  if (typeof first !== 'string') return undefined;
  const cut = Math.max(first.lastIndexOf('/'), first.lastIndexOf('#'), first.lastIndexOf(':'));
  return cut >= 0 ? first.slice(cut + 1) : first;
}

export function ld(data: unknown): ItemInput {
  const type = data && typeof data === 'object' && !Array.isArray(data) ? tail((data as Record<string, unknown>)['@type']) : undefined;
  return type ? { source: 'json-ld', data, type } : { source: 'json-ld', data };
}

export function microdata(data: Record<string, unknown>): ItemInput {
  const type = typeof data['@type'] === 'string' ? (data['@type'] as string) : undefined;
  return type ? { source: 'microdata', data, type } : { source: 'microdata', data };
}

export function embedded(data: unknown): ItemInput {
  return { source: 'embedded-json', data };
}

export function og(data: Record<string, string>): ItemInput {
  return data['og:type'] ? { source: 'opengraph', data, type: data['og:type'] } : { source: 'opengraph', data };
}

export function meta(data: Record<string, string>): ItemInput {
  return { source: 'meta', data };
}

export interface DocInput {
  /** Visible page text; split on blank lines into blocks. */
  text?: string;
  items: ItemInput[];
  url?: string;
  title?: string;
  /** Extra evidence attributes, one block each (href/src/datetime ...). */
  attrs?: Array<Record<string, string>>;
}

export function makeDoc(input: DocInput): SourceDocument {
  const paragraphs = (input.text ?? '').split(/\n{2,}/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const blocks: SourceBlock[] = [];
  let offset = 0;
  const texts: string[] = [];
  for (const p of paragraphs) {
    blocks.push({ id: `b${blocks.length}`, kind: 'paragraph', text: p, headingPath: [], selector: `p:nth-of-type(${blocks.length + 1})`, start: offset, end: offset + p.length });
    texts.push(p);
    offset += p.length + 1;
  }
  for (const attrs of input.attrs ?? []) {
    blocks.push({ id: `b${blocks.length}`, kind: 'field', text: '', headingPath: [], selector: `x${blocks.length}`, start: offset, end: offset, attrs });
  }
  const structured: StructuredDataItem[] = input.items.map((item, i) => {
    const out: StructuredDataItem = { id: `sd${i}`, source: item.source, data: item.data };
    if (item.type) out.type = item.type;
    return out;
  });
  const text = texts.join('\n');
  return {
    url: input.url ?? 'https://shop.example.com/p/1',
    snapshotHash: '0'.repeat(64),
    title: input.title,
    text,
    blocks,
    structured,
    recordGroups: [],
    templateSignature: 'test',
    stats: { rawBytes: text.length, blockCount: blocks.length, textChars: text.length, buildMs: 0 },
  };
}

export interface FieldInput {
  name: string;
  type?: FieldType;
  itemType?: FieldType;
  description?: string;
  required?: boolean;
}

export function makeSchema(fields: Array<FieldInput | string>, shape: RequestedShape = 'object'): NormalizedSchema {
  const specs: FieldSpec[] = fields.map((f) => {
    const input: FieldInput = typeof f === 'string' ? { name: f } : f;
    const type = input.type ?? 'string';
    const spec: FieldSpec = {
      name: input.name,
      type,
      required: input.required ?? false,
      nullable: true,
      derived: false,
      schema: { type },
    };
    if (input.itemType) spec.itemType = input.itemType;
    if (input.description) spec.description = input.description;
    return spec;
  });
  const properties = Object.fromEntries(specs.map((s) => [s.name, s.schema]));
  const recordSchema = { type: 'object', properties };
  return {
    jsonSchema: shape === 'array' ? { type: 'array', items: recordSchema } : recordSchema,
    shape,
    recordSchema,
    fields: specs,
    hash: 'test',
    fromShorthand: false,
  };
}

/** Field → raw map of one record, for compact assertions. */
export function raws(record: Record<string, { raw: unknown }> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record ?? {}).map(([k, v]) => [k, v.raw]));
}
