import {
  type DomElement,
  type DomNode,
  type DomText,
  SKIP_TAGS,
  collapseWhitespace,
  isBlockish,
  isElement,
  isHiddenElement,
} from './dom.js';
import { parseSpan } from './layout.js';
import { DOCUMENT_LIMITS } from './limits.js';

// Data tables are atomic blocks read straight from the raw DOM: pass 1 builds
// no NodeInfo for their rows and cells. Visibility rules are the same as
// everywhere else (SKIP_TAGS + isHiddenElement), so hidden rows/cells never
// reach the table text.

function isVisible(el: DomElement): boolean {
  return !SKIP_TAGS.has(el.name) && !isHiddenElement(el);
}

/** Visible text of a subtree, with a space at every block boundary. Iterative. */
export function visibleText(root: DomElement): string {
  const kids = root.children;
  // Fast path: most cells hold a single text node.
  if (kids.length === 1 && kids[0].type === 'text') return collapseWhitespace((kids[0] as DomText).data);
  const pieces: string[] = [];
  // Close markers (the element itself, pushed before its children) emit the
  // separator after a block element's content.
  const stack: Array<DomNode | { close: string }> = [];
  for (let i = root.children.length - 1; i >= 0; i--) stack.push(root.children[i]);
  while (stack.length > 0) {
    const item = stack.pop() as DomNode | { close: string };
    if ('close' in item) {
      pieces.push(' ');
      continue;
    }
    if (item.type === 'text') {
      pieces.push((item as DomText).data);
      continue;
    }
    if (!isElement(item) || !isVisible(item)) continue;
    if (isBlockish(item.name)) {
      pieces.push(' ');
      stack.push({ close: item.name });
    }
    for (let i = item.children.length - 1; i >= 0; i--) stack.push(item.children[i]);
  }
  return collapseWhitespace(pieces.join(''));
}

export interface TableData {
  caption?: string;
  headers: string[];
  rows: string[][];
  /** Body rows dropped beyond maxTableRows. */
  droppedRows: number;
}

interface Pending {
  text: string;
  left: number;
}

function visibleChildren(el: DomElement, names: ReadonlySet<string>): DomElement[] {
  const out: DomElement[] = [];
  for (const c of el.children) if (isElement(c) && names.has(c.name) && isVisible(c)) out.push(c);
  return out;
}

const CELL_TAGS = new Set(['td', 'th']);
const ROW_TAGS = new Set(['tr']);
const SECTION_TAGS = new Set(['caption', 'thead', 'tbody', 'tfoot', 'tr']);

/**
 * Expand rows into a grid. Header rows repeat a spanned cell's text across
 * every column/row it covers (so each column gets a name); body rows put the
 * text in the first covered slot and '' in the rest (no duplicated values).
 */
function expandRows(rows: DomElement[], header: boolean, maxRows: number): { grid: string[][]; dropped: number } {
  const maxCols = DOCUMENT_LIMITS.maxTableCols;
  const pending: Array<Pending | undefined> = [];
  const grid: string[][] = [];
  let dropped = 0;
  for (const row of rows) {
    if (grid.length >= maxRows) {
      dropped++;
      continue;
    }
    const out: string[] = [];
    let col = 0;
    const fillPending = (): void => {
      for (let p = pending[col]; p && p.left > 0 && col < maxCols; p = pending[col]) {
        out.push(header ? p.text : '');
        p.left--;
        col++;
      }
    };
    for (const cell of visibleChildren(row, CELL_TAGS)) {
      fillPending();
      if (col >= maxCols) break;
      const text = visibleText(cell);
      const colspan = parseSpan(cell.attribs.colspan, DOCUMENT_LIMITS.maxColspan);
      const rowspan = parseSpan(cell.attribs.rowspan, DOCUMENT_LIMITS.maxRowspan);
      for (let k = 0; k < colspan && col < maxCols; k++, col++) {
        out.push(k === 0 || header ? text : '');
        pending[col] = rowspan > 1 ? { text, left: rowspan - 1 } : undefined;
      }
    }
    // Rowspans from earlier rows that extend past this row's last cell.
    for (; col < pending.length && col < maxCols; col++) {
      const p = pending[col];
      if (p && p.left > 0) {
        out.push(header ? p.text : '');
        p.left--;
      } else {
        out.push('');
      }
    }
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    if (out.length > 0) grid.push(out);
  }
  return { grid, dropped };
}

/** Rows/headers/caption of a data table (visible content only). */
export function buildTable(table: DomElement): TableData {
  let caption: string | undefined;
  const headRows: DomElement[] = [];
  const bodyRows: DomElement[] = [];
  for (const c of visibleChildren(table, SECTION_TAGS)) {
    const name = c.name;
    if (name === 'caption') caption ??= visibleText(c) || undefined;
    else if (name === 'tr') bodyRows.push(c);
    else for (const r of visibleChildren(c, ROW_TAGS)) (name === 'thead' ? headRows : bodyRows).push(r);
  }

  let headers: string[] = [];
  if (headRows.length > 0) {
    const { grid } = expandRows(headRows, true, headRows.length);
    headers = grid[grid.length - 1] ?? [];
  } else if (bodyRows.length >= 2) {
    const first = visibleChildren(bodyRows[0], CELL_TAGS);
    if (first.length > 0 && first.every((c) => c.name === 'th')) {
      headers = expandRows([bodyRows[0]], true, 1).grid[0] ?? [];
      bodyRows.shift();
    }
  }

  const { grid, dropped } = expandRows(bodyRows, false, DOCUMENT_LIMITS.maxTableRows);
  return caption ? { caption, headers, rows: grid, droppedRows: dropped } : { headers, rows: grid, droppedRows: dropped };
}

/** The table's contribution to SourceDocument.text: caption, header, rows. */
export function tableText(t: TableData): string {
  const lines: string[] = [];
  if (t.caption) lines.push(t.caption);
  if (t.headers.some((h) => h !== '')) lines.push(t.headers.join(' | '));
  for (const row of t.rows) lines.push(row.join(' | '));
  return lines.join('\n');
}
