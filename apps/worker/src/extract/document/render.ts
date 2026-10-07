import type { SourceBlock, SourceDocument } from '../types.js';
import { isEvidenceClass } from './hints.js';

export interface RenderOptions {
  /** Render only these blocks (plus the frames of records that contain them). */
  blockIds?: readonly string[];
  /** Upper bound on the returned text length. Blocks/records are never split. */
  maxChars?: number;
}

export interface RenderResult {
  text: string;
  /** Ids of every rendered block, record frames included, in document order. */
  includedIds: string[];
  /** Something selected was left out because of maxChars. */
  truncated: boolean;
}

// The prompt wraps page content in <page>…</page>, and this rendering uses
// <record>/<table> lines. Page text must not be able to forge any of them.
// Bounded quantifiers: no backtracking blow-up on long whitespace runs.
const STRUCTURAL_TAG = /<(?=\s{0,8}\/?\s{0,8}(?:page|record|table)\b)/gi;

function escapeText(s: string): string {
  return s.replace(STRUCTURAL_TAG, '&lt;');
}

function escapeCell(s: string): string {
  return escapeText(s).replace(/\|/g, '\\|');
}

function escapeQuoted(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

const MAX_RENDERED_ATTR = 300;

function renderAttrValue(key: string, value: string): string {
  const v = value.replace(/\s+/g, ' ').trim();
  const isUrl = key === 'href' || key === 'src';
  return escapeText(!isUrl && v.length > MAX_RENDERED_ATTR ? `${v.slice(0, MAX_RENDERED_ATTR)}…` : v);
}

function attrSuffix(pairs: Array<[string, string]>): string {
  if (pairs.length === 0) return '';
  return ` {${pairs.map(([k, v]) => `${k}=${renderAttrValue(k, v)}`).join(', ')}}`;
}

const FIELD_KEYS = ['href', 'src', 'alt', 'title', 'content', 'datetime', 'value', 'aria-label', 'itemprop'];
const ECHO_KEYS = new Set(['alt', 'title', 'aria-label']);

/** Attributes worth showing the model for a field (skips ones echoing the text). */
function fieldAttrs(b: SourceBlock): Array<[string, string]> {
  const a = b.attrs;
  if (!a) return [];
  const textLower = b.text.toLowerCase();
  const out: Array<[string, string]> = [];
  for (const k of FIELD_KEYS) {
    const v = a[k];
    if (v === undefined || v === '') continue;
    if (ECHO_KEYS.has(k) && v.toLowerCase() === textLower) continue;
    out.push([k, v]);
  }
  // Class and data-* matter when they are the only evidence (star-rating
  // Three, data-price) and are noise otherwise.
  if (a.class && (!b.text || isEvidenceClass(a.class))) out.push(['class', a.class]);
  if (!b.text) {
    for (const k of Object.keys(a)) if (k.startsWith('data-')) out.push([k, a[k]]);
  }
  return out;
}

function pickAttrs(b: SourceBlock, keys: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const a = b.attrs;
  if (!a) return out;
  for (const k of keys) {
    const v = a[k];
    if (v && !(ECHO_KEYS.has(k) && v.toLowerCase() === b.text.toLowerCase())) out.push([k, v]);
  }
  return out;
}

function recordAttrs(b: SourceBlock): Array<[string, string]> {
  const out = pickAttrs(b, ['href', 'title', 'aria-label', 'itemprop']);
  const a = b.attrs;
  if (a) for (const k of Object.keys(a)) if (k.startsWith('data-')) out.push([k, a[k]]);
  return out;
}

function headingLevel(selector: string): number {
  const m = /(?:^|\s)h([1-6]):nth-child\(\d+\)$/.exec(selector);
  return m ? Number(m[1]) : 2;
}

function blockLines(b: SourceBlock, out: string[]): boolean {
  switch (b.kind) {
    case 'heading':
      out.push(`[${b.id}] ${'#'.repeat(headingLevel(b.selector))} ${escapeText(b.text)}${attrSuffix(pickAttrs(b, ['href', 'title']))}`);
      return true;
    case 'field': {
      const attrs = fieldAttrs(b);
      if (!b.text && attrs.length === 0) return false;
      // attrSuffix starts with a space, so an empty-text field reads "[b5] {class=…}".
      out.push(`[${b.id}]${b.text ? ` ${escapeText(b.text)}` : ''}${attrSuffix(attrs)}`);
      return true;
    }
    case 'table': {
      const t = b.table;
      if (!t) {
        if (!b.text) return false;
        out.push(`[${b.id}] ${escapeText(b.text)}`);
        return true;
      }
      const caption = t.caption ? ` caption="${escapeQuoted(t.caption)}"` : '';
      const cols = t.headers.some((h) => h !== '') ? ` cols="${t.headers.map(escapeQuoted).join(' | ')}"` : '';
      out.push(`[${b.id}] <table${caption}${cols}>`);
      for (const row of t.rows) out.push(`| ${row.map(escapeCell).join(' | ')} |`);
      out.push('</table>');
      return true;
    }
    case 'record':
      return false;
    default:
      if (!b.text) return false;
      out.push(`[${b.id}] ${escapeText(b.text)}`);
      return true;
  }
}

/**
 * Index of the last descendant of each record block (-1 for non-records).
 * Relies on the builder's invariant that a record's descendants directly
 * follow it; blocks whose parentId does not match the open record stack are
 * treated as outside it.
 */
function recordRanges(blocks: SourceBlock[]): Int32Array {
  const last = new Int32Array(blocks.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    while (stack.length > 0 && blocks[stack[stack.length - 1]].id !== b.parentId) {
      last[stack.pop() as number] = i - 1;
    }
    if (b.kind === 'record') stack.push(i);
  }
  while (stack.length > 0) last[stack.pop() as number] = blocks.length - 1;
  return last;
}

const SELECTED = 1;
/** A record whose whole content is already included. */
const FULL = 2;

function selection(blocks: SourceBlock[], ids: readonly string[], last: Int32Array): Uint8Array {
  const index = new Map<string, number>();
  blocks.forEach((b, i) => index.set(b.id, i));
  const include = new Uint8Array(blocks.length);
  for (const id of ids) {
    const j = index.get(id);
    if (j === undefined || include[j] === FULL) continue;
    include[j] = SELECTED;
    // A selected record brings its whole content (marked FULL so repeated or
    // nested selections do not refill the same range).
    if (blocks[j].kind === 'record') include.fill(FULL, j, Math.max(j, last[j]) + 1);
    // Enclosing records are rendered as frames.
    let p = blocks[j].parentId;
    while (p !== undefined) {
      const k = index.get(p);
      if (k === undefined || include[k]) break;
      include[k] = SELECTED;
      p = blocks[k].parentId;
    }
  }
  return include;
}

/**
 * Compact, model-friendly rendering, one line per block:
 *   [b3] ## Heading text
 *   [b4] paragraph text
 *   [b5] £51.77 {class=price_color}
 *   [b20] <table cols="Name | Price">  | a | b |  </table>
 *   [b40] <record group=g0 n=3> … </record>   (n = 1-based position in group)
 * With maxChars, whole top-level units (a block, or a record with everything
 * inside it) are added until the next one would not fit; then rendering
 * stops and `truncated` is set.
 */
export function renderBlocks(doc: SourceDocument, opts: RenderOptions = {}): RenderResult {
  const blocks = doc.blocks;
  const maxChars = typeof opts.maxChars === 'number' && opts.maxChars >= 0 ? opts.maxChars : Number.POSITIVE_INFINITY;
  const last = recordRanges(blocks);
  const include = opts.blockIds ? selection(blocks, opts.blockIds, last) : undefined;

  const ordinal = new Map<string, { group: string; n: number }>();
  for (const g of doc.recordGroups) g.recordIds.forEach((id, i) => ordinal.set(id, { group: g.id, n: i + 1 }));

  const lines: string[] = [];
  const includedIds: string[] = [];
  let length = 0;
  let truncated = false;

  for (let i = 0; i < blocks.length;) {
    const end = blocks[i].kind === 'record' ? Math.max(i, last[i]) : i;
    const unitLines: string[] = [];
    const unitIds: string[] = [];
    const open: number[] = [];
    for (let j = i; j <= end; j++) {
      while (open.length > 0 && last[open[open.length - 1]] < j) {
        open.pop();
        unitLines.push('</record>');
      }
      if (include && !include[j]) continue;
      const b = blocks[j];
      if (b.kind === 'record') {
        const o = ordinal.get(b.id);
        const tag = o ? `<record group=${o.group} n=${o.n}>` : '<record>';
        unitLines.push(`[${b.id}] ${tag}${attrSuffix(recordAttrs(b))}`);
        unitIds.push(b.id);
        open.push(j);
      } else if (blockLines(b, unitLines)) {
        unitIds.push(b.id);
      }
    }
    while (open.length > 0) {
      open.pop();
      unitLines.push('</record>');
    }
    i = end + 1;
    if (unitLines.length === 0) continue;

    let unitLength = lines.length > 0 ? 1 : 0;
    for (const l of unitLines) unitLength += l.length;
    unitLength += unitLines.length - 1;
    if (length + unitLength > maxChars) {
      truncated = true;
      break;
    }
    for (const l of unitLines) lines.push(l);
    for (const id of unitIds) includedIds.push(id);
    length += unitLength;
  }
  return { text: lines.join('\n'), includedIds, truncated };
}
