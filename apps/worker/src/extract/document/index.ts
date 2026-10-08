import type { SourceBlock, SourceDocument } from '../types.js';

export { buildSourceDocument, documentBuildInfo } from './build.js';
export type { DocumentBuildStats } from './build.js';
export { renderBlocks } from './render.js';
export type { RenderOptions, RenderResult } from './render.js';
export { DOCUMENT_LIMITS } from './limits.js';

// id → index maps are built lazily per document and held weakly, so the
// SourceDocument object itself is never mutated.
const indexCache = new WeakMap<SourceDocument, Map<string, number>>();

function blockIndex(doc: SourceDocument, id: string): number {
  // Fast path: ids are "b<i>" in order.
  if (id.length > 1 && id.charCodeAt(0) === 98) {
    const i = Number(id.slice(1));
    if (Number.isInteger(i) && i >= 0 && doc.blocks[i]?.id === id) return i;
  }
  const cached = indexCache.get(doc);
  const hit = cached?.get(id);
  if (hit !== undefined && doc.blocks[hit]?.id === id) return hit;
  // Miss or stale map (blocks replaced since it was built): rebuild once.
  if (cached && hit === undefined && cached.size === doc.blocks.length) return -1;
  const map = new Map<string, number>();
  doc.blocks.forEach((b, i) => map.set(b.id, i));
  indexCache.set(doc, map);
  return map.get(id) ?? -1;
}

export function getBlock(doc: SourceDocument, id: string): SourceBlock | undefined {
  const i = blockIndex(doc, id);
  return i >= 0 ? doc.blocks[i] : undefined;
}

export interface BlockContext {
  block: SourceBlock;
  /** Nearest enclosing record block (strict ancestor), when any. */
  record?: SourceBlock;
  headingPath: string[];
  /**
   * Evidence attributes of the record the block belongs to (its enclosing
   * record, or the block itself when it is a record) and of every block
   * inside that record, in document order. A value printed only in an
   * attribute (class="star-rating Three", an href) can then be verified
   * when the model cites another block of the same product card. Bounded by
   * RECORD_ATTR_LIMITS; the same array object is returned for every block of
   * one record (callers may cache work on it).
   */
  recordAttrs?: ReadonlyArray<Readonly<Record<string, string>>>;
}

export const RECORD_ATTR_LIMITS = {
  /** Blocks of one record inspected. */
  maxBlocks: 512,
  /** Attribute maps collected per record. */
  maxAttrMaps: 64,
  /** Total attribute value chars collected per record. */
  maxChars: 8_192,
} as const;

const recordAttrCache = new WeakMap<SourceDocument, Map<string, ReadonlyArray<Readonly<Record<string, string>>>>>();

/** The block, its enclosing record and heading path; undefined for unknown ids. */
export function blockContext(doc: SourceDocument, id: string): BlockContext | undefined {
  const block = getBlock(doc, id);
  if (!block) return undefined;
  const parent = block.parentId !== undefined ? getBlock(doc, block.parentId) : undefined;
  const record = parent && parent.kind === 'record' ? parent : undefined;
  const ctx: BlockContext = record ? { block, record, headingPath: block.headingPath } : { block, headingPath: block.headingPath };
  const root = record ?? (block.kind === 'record' ? block : undefined);
  if (root) {
    const attrs = recordAttrs(doc, root);
    if (attrs.length > 0) ctx.recordAttrs = attrs;
  }
  return ctx;
}

/** Attribute maps of a record block and its descendants (which directly follow it). */
function recordAttrs(doc: SourceDocument, root: SourceBlock): ReadonlyArray<Readonly<Record<string, string>>> {
  let perDoc = recordAttrCache.get(doc);
  if (!perDoc) {
    perDoc = new Map();
    recordAttrCache.set(doc, perDoc);
  }
  const cached = perDoc.get(root.id);
  if (cached) return cached;
  const out: Array<Readonly<Record<string, string>>> = [];
  let chars = 0;
  const add = (attrs: Record<string, string> | undefined): boolean => {
    if (!attrs) return true;
    let size = 0;
    for (const v of Object.values(attrs)) if (typeof v === 'string') size += v.length;
    if (size === 0) return true;
    if (out.length >= RECORD_ATTR_LIMITS.maxAttrMaps || chars + size > RECORD_ATTR_LIMITS.maxChars) return false;
    chars += size;
    out.push(attrs);
    return true;
  };
  const start = blockIndex(doc, root.id);
  if (start >= 0 && add(root.attrs)) {
    const inside = new Set([root.id]);
    const end = Math.min(doc.blocks.length, start + 1 + RECORD_ATTR_LIMITS.maxBlocks);
    for (let i = start + 1; i < end; i++) {
      const b = doc.blocks[i];
      if (b.parentId === undefined || !inside.has(b.parentId)) break;
      if (b.kind === 'record') inside.add(b.id);
      if (!add(b.attrs)) break;
    }
  }
  const frozen = Object.freeze(out);
  perDoc.set(root.id, frozen);
  return frozen;
}
