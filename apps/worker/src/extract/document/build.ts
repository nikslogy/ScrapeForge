import { createHash } from 'node:crypto';
import type { RecordGroup, SourceDocument } from '../types.js';
import { emitBlocks } from './blocks.js';
import { findChildElement, parseHtml } from './dom.js';
import { buildLayout } from './layout.js';
import { detectRecordGroups } from './records.js';
import { groupSelector } from './selector.js';
import { extractStructured, resolveBaseUrl } from './structured.js';
import { templateSignature } from './template.js';

/**
 * SourceDocument['stats'] plus build diagnostics. The extra fields are not in
 * the shared contract (types.ts); read them through documentBuildInfo().
 */
export interface DocumentBuildStats {
  rawBytes: number;
  blockCount: number;
  textChars: number;
  buildMs: number;
  /** Some content was not turned into blocks (block cap, table row cap). */
  truncated: boolean;
  /** Machine-readable notes: "blocks_truncated: ...", "json_parse_failed: ...". */
  warnings: string[];
}

/**
 * Raw HTML → structure-preserving SourceDocument.
 *
 * Order of work: parse (cheerio/parse5, never mutated) → structured data
 * (JSON-LD, embedded JSON, microdata, OpenGraph, meta; parsed, never
 * executed) → visible layout tree (hidden content excluded) → record groups
 * → blocks in document order → template signature. Never throws on odd
 * input; an unusable page yields an empty document.
 */
export function buildSourceDocument(html: string, url: string): SourceDocument {
  const t0 = performance.now();
  const raw = typeof html === 'string' ? html : '';
  const pageUrl = typeof url === 'string' ? url : '';
  const snapshotHash = createHash('sha256').update(raw).digest('hex');

  const root = parseHtml(raw);
  const htmlEl = findChildElement(root, 'html');
  const head = htmlEl ? findChildElement(htmlEl, 'head') : undefined;
  const body = htmlEl ? findChildElement(htmlEl, 'body') : undefined;
  const base = resolveBaseUrl(pageUrl, head);

  const structured = extractStructured(root, base);
  const warnings = [...structured.warnings];

  // Frameset documents have no <body>: walk <html> (head is skipped).
  const visibleRoot = body ?? htmlEl;
  let blocks: SourceDocument['blocks'] = [];
  let text = '';
  let recordGroups: RecordGroup[] = [];
  let firstH1: string | undefined;
  let truncated = false;
  let skeleton: Iterable<string> = [];

  if (visibleRoot) {
    const layout = buildLayout(visibleRoot, body ? 'html > body' : 'html');
    skeleton = layout.skeleton;
    const detected = detectRecordGroups(layout.all);
    const emitted = emitBlocks(layout, base);
    blocks = emitted.blocks;
    text = emitted.text;
    firstH1 = emitted.firstH1;
    truncated = emitted.truncated || emitted.warnings.some((w) => w.startsWith('table_rows_truncated'));
    warnings.push(...emitted.warnings);
    // Selectors are built from the records actually emitted, so they stay
    // exact even when emission stopped at the block cap.
    recordGroups = emitted.groups.map((g) => {
      const { selector, exact } = groupSelector(g.members);
      if (!exact) warnings.push(`record_group_selector_inexact: ${g.id} selector also matches non-record siblings`);
      return { id: g.id, selector, recordIds: g.recordIds, signature: detected[g.groupIndex].signature };
    });
  }

  const title = structured.title ?? structured.ogTitle ?? firstH1;
  const stats: DocumentBuildStats = {
    rawBytes: Buffer.byteLength(raw, 'utf8'),
    blockCount: blocks.length,
    textChars: text.length,
    buildMs: 0,
    truncated,
    warnings,
  };
  const doc: SourceDocument = {
    url: pageUrl,
    snapshotHash,
    ...(title ? { title } : {}),
    text,
    blocks,
    structured: structured.items,
    recordGroups,
    templateSignature: templateSignature(pageUrl, skeleton),
    stats,
  };
  stats.buildMs = Math.round((performance.now() - t0) * 100) / 100;
  return doc;
}

/** Build diagnostics stored alongside the contract stats (see DocumentBuildStats). */
export function documentBuildInfo(doc: SourceDocument): { truncated: boolean; warnings: string[] } {
  const stats = doc.stats as Partial<DocumentBuildStats>;
  return { truncated: stats.truncated === true, warnings: Array.isArray(stats.warnings) ? stats.warnings : [] };
}
