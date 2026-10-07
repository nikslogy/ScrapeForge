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
}

/** The block, its enclosing record and heading path; undefined for unknown ids. */
export function blockContext(doc: SourceDocument, id: string): BlockContext | undefined {
  const block = getBlock(doc, id);
  if (!block) return undefined;
  const record = block.parentId !== undefined ? getBlock(doc, block.parentId) : undefined;
  return record && record.kind === 'record'
    ? { block, record, headingPath: block.headingPath }
    : { block, headingPath: block.headingPath };
}
