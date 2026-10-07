import {
  type DomElement,
  type DomNode,
  type DomText,
  SKIP_TAGS,
  countVisibleChars,
  isBlockish,
  isElement,
  isHeadingTag,
  isHiddenElement,
} from './dom.js';
import { HINT_NONE, HINT_STRONG, analyzeClass, analyzeId } from './hints.js';
import { DOCUMENT_LIMITS } from './limits.js';

// Pass 1: a lightweight annotated tree of the VISIBLE elements under <body>.
// Hidden and non-rendered subtrees get no NodeInfo at all, so later passes
// can never leak their text. Built iteratively: pages nest 10k+ levels deep.

export const F_IN_LINK = 1;
export const F_IN_HEADING = 2;
/** Inside nav/menus or a page-level header/footer: never record groups. */
export const F_IN_NAV = 4;
/** The element's own class/id names navigation chrome (see records.ts). */
export const F_NAV_CLASS = 32;
export const F_IN_SECTIONING = 8;
export const F_IN_DATA_TABLE = 16;

/** time[datetime], data/meter[value] or a strong hint class/id. */
export const EVIDENCE_HINT = 1;
/** itemprop (without itemscope). */
export const EVIDENCE_ITEMPROP = 2;

export interface NodeInfo {
  el: DomElement;
  parent: NodeInfo | null;
  /** 1-based index among ALL element siblings (what :nth-child counts). */
  nth: number;
  /** Depth below the root (<body> = 0). */
  depth: number;
  /** Pre-order index among visible elements. */
  order: number;
  /** Visible element children, in document order (shared empty array for leaves). */
  children: NodeInfo[];
  /** Visible non-whitespace chars in the subtree. */
  textLen: number;
  /** Visible non-whitespace chars in direct text children. */
  ownTextLen: number;
  linkTextLen: number;
  /** a[href] descendants (excluding self). */
  linkCount: number;
  /** img descendants (excluding self). */
  imgCount: number;
  /** Has a descendant that breaks text flow (block element, img, form control). */
  hasBlockDesc: boolean;
  flags: number;
  /** <table> judged to hold data (rows/columns), not page layout. */
  dataTable: boolean;
  /** HINT_* level of the element's class/id vocabulary. */
  hint: number;
  /** First stable class token (see firstStableClass). */
  stableClass: string;
  /** `tag.stableClass`, memoized by records.ts. */
  key: string | undefined;
  /** EVIDENCE_* level of the element itself. */
  evidence: number;
  /** Highest EVIDENCE_* level among descendants. */
  descEvidence: number;
  /** Record group index (see records.ts) or -1. */
  group: number;
  hasRecordDesc: boolean;
  /** Memoized unique selector (see selector.ts). */
  sel: string | undefined;
}

export interface Layout {
  root: NodeInfo;
  /** Visible elements in pre-order, root first. */
  all: NodeInfo[];
  /** tag.class tokens of visible elements down to depth 4 (template skeleton). */
  skeleton: Set<string>;
}

const SKELETON_DEPTH = 4;

// Most elements are leaves; they share this (frozen) array until a first
// child arrives, when buildLayout swaps in a real one.
const NO_CHILDREN: NodeInfo[] = Object.freeze([]) as unknown as NodeInfo[];

function makeInfo(el: DomElement, parent: NodeInfo | null, nth: number, depth: number, order: number): NodeInfo {
  return {
    el,
    parent,
    nth,
    depth,
    order,
    children: NO_CHILDREN,
    textLen: 0,
    ownTextLen: 0,
    linkTextLen: 0,
    linkCount: 0,
    imgCount: 0,
    hasBlockDesc: false,
    flags: 0,
    dataTable: false,
    hint: HINT_NONE,
    stableClass: '',
    key: undefined,
    evidence: 0,
    descEvidence: 0,
    group: -1,
    hasRecordDesc: false,
    sel: undefined,
  };
}

const NAV_ROLES = new Set(['navigation', 'menu', 'menubar', 'banner', 'contentinfo']);
const SECTIONING = new Set(['article', 'section', 'aside', 'main']);

/** Context flags, hint level and stable class, from one memoized class lookup. */
function classify(info: NodeInfo, parentFlags: number): void {
  let f = parentFlags;
  const el = info.el;
  const name = el.name;
  const a = el.attribs;
  const cls = analyzeClass(a.class);
  let hint = cls.hint;
  let nav = cls.nav;
  if (a.id !== undefined) {
    const id = analyzeId(a.id);
    if (id.hint > hint) hint = id.hint;
    nav ||= id.nav;
  }
  if (name === 'a' && a.href !== undefined) f |= F_IN_LINK;
  if (isHeadingTag(name)) f |= F_IN_HEADING;
  const role = a.role;
  // F_NAV_CLASS describes this element only; it is never inherited.
  f &= ~F_NAV_CLASS;
  if (name === 'nav' || (role !== undefined && NAV_ROLES.has(role.trim().toLowerCase()))) {
    f |= F_IN_NAV;
  } else if ((name === 'header' || name === 'footer' || name === 'aside') && !(parentFlags & F_IN_SECTIONING)) {
    // Page-level header/footer/sidebar only; <article><header> is content.
    f |= F_IN_NAV;
  } else if (nav) {
    // Class names are weaker evidence ("has-sidebar" on a page wrapper):
    // records.ts applies them only to elements with a small text share.
    f |= F_NAV_CLASS;
  }
  if (SECTIONING.has(name)) f |= F_IN_SECTIONING;
  info.flags = f;
  info.hint = hint;
  info.stableClass = cls.stable;
}

function evidenceOf(info: NodeInfo): number {
  const a = info.el.attribs;
  if (a.itemprop !== undefined && a.itemscope === undefined) return EVIDENCE_ITEMPROP;
  const name = info.el.name;
  if ((name === 'time' && a.datetime !== undefined) || ((name === 'data' || name === 'meter') && a.value !== undefined)) {
    return EVIDENCE_HINT;
  }
  return info.hint === HINT_STRONG ? EVIDENCE_HINT : 0;
}

function skeletonToken(info: NodeInfo): string {
  return info.stableClass ? `${info.el.name}.${info.stableClass}` : info.el.name;
}

export function buildLayout(rootEl: DomElement, rootSelector: string): Layout {
  const root = makeInfo(rootEl, null, 1, 0, 0);
  classify(root, 0);
  root.sel = rootSelector;
  const all: NodeInfo[] = [root];
  const skeleton = new Set<string>([skeletonToken(root)]);

  const infos: NodeInfo[] = [root];
  const nextChild: number[] = [0];
  const elementCount: number[] = [0];

  while (infos.length > 0) {
    const top = infos.length - 1;
    const info = infos[top];
    const kids = info.el.children;
    let i = nextChild[top];
    let descended = false;
    while (i < kids.length) {
      const child = kids[i++];
      if (child.type === 'text') {
        const n = countVisibleChars((child as DomText).data);
        if (n > 0) {
          info.textLen += n;
          info.ownTextLen += n;
          if (info.flags & F_IN_LINK) info.linkTextLen += n;
        }
        continue;
      }
      if (!isElement(child)) continue;
      // nth-child counts every element sibling, hidden or not.
      const nth = ++elementCount[top];
      if (SKIP_TAGS.has(child.name) || isHiddenElement(child)) continue;
      const ci = makeInfo(child, info, nth, info.depth + 1, all.length);
      classify(ci, info.flags);
      ci.evidence = evidenceOf(ci);
      if (ci.depth <= SKELETON_DEPTH) skeleton.add(skeletonToken(ci));
      if (info.children === NO_CHILDREN) info.children = [ci];
      else info.children.push(ci);
      all.push(ci);
      if (child.name === 'table' && isDataTable(child)) {
        // Data tables are atomic blocks read straight from the DOM (see
        // table.ts); their cells get no NodeInfo, which keeps big tables
        // cheap. Only the stats ancestors need are accumulated.
        ci.dataTable = true;
        ci.flags |= F_IN_DATA_TABLE;
        accumulateTableStats(ci);
        rollUp(ci);
        continue;
      }
      nextChild[top] = i;
      infos.push(ci);
      nextChild.push(0);
      elementCount.push(0);
      descended = true;
      break;
    }
    if (descended) continue;

    infos.pop();
    nextChild.pop();
    elementCount.pop();
    rollUp(info);
  }
  return { root, all, skeleton };
}

/** Post-order: add a finished element's subtree stats to its parent. */
function rollUp(info: NodeInfo): void {
  const p = info.parent;
  if (!p) return;
  const name = info.el.name;
  p.textLen += info.textLen;
  p.linkTextLen += info.linkTextLen;
  p.linkCount += info.linkCount + (name === 'a' && info.el.attribs.href !== undefined ? 1 : 0);
  p.imgCount += info.imgCount + (name === 'img' ? 1 : 0);
  if (info.hasBlockDesc || isBlockish(name)) p.hasBlockDesc = true;
  const ev = info.evidence > info.descEvidence ? info.evidence : info.descEvidence;
  if (ev > p.descEvidence) p.descEvidence = ev;
}

/** Text/link/image stats of a data table's visible content, without NodeInfos. */
function accumulateTableStats(table: NodeInfo): void {
  const tableInLink = (table.flags & F_IN_LINK) !== 0;
  const nodes: DomNode[] = [];
  const inLink: boolean[] = [];
  for (let i = table.el.children.length - 1; i >= 0; i--) {
    nodes.push(table.el.children[i]);
    inLink.push(tableInLink);
  }
  table.hasBlockDesc = true;
  while (nodes.length > 0) {
    const node = nodes.pop() as DomNode;
    const linked = inLink.pop() as boolean;
    if (node.type === 'text') {
      const n = countVisibleChars((node as DomText).data);
      table.textLen += n;
      if (linked) table.linkTextLen += n;
      continue;
    }
    if (!isElement(node) || SKIP_TAGS.has(node.name) || isHiddenElement(node)) continue;
    let childLinked = linked;
    if (node.name === 'a' && node.attribs.href !== undefined) {
      table.linkCount++;
      childLinked = true;
    } else if (node.name === 'img') {
      table.imgCount++;
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      nodes.push(node.children[i]);
      inLink.push(childLinked);
    }
  }
}

// Cell content that signals a layout table (page structure in a grid).
const LAYOUT_SIGNALS = new Set([
  'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'dl', 'form', 'article',
  'section', 'nav', 'header', 'footer', 'aside', 'main', 'blockquote', 'iframe', 'fieldset',
]);

// Visible chars in one cell beyond which the "cell" is really a page column.
const LAYOUT_CELL_TEXT = 2_000;

export function parseSpan(value: string | undefined, max: number): number {
  if (value === undefined) return 1;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n > max ? max : n;
}

/**
 * Data table: has a caption/thead/th, or at least 2 rows × 2 columns, and no
 * cell holds page structure (nested tables, headings, lists, forms, long
 * text). role=presentation/none is always layout. Layout tables are walked
 * like ordinary containers.
 */
export function isDataTable(table: DomElement): boolean {
  const role = (table.attribs.role ?? '').trim().toLowerCase();
  if (role === 'presentation' || role === 'none') return false;
  let rows = 0;
  let maxCols = 0;
  let header = false;
  // Scan budget per table. When exhausted the verdict uses what was seen so
  // far: large tables are overwhelmingly data tables.
  const budget = { n: 50_000 };
  for (const section of table.children) {
    if (!isElement(section)) continue;
    const name = section.name;
    let rowNodes: DomNode[];
    if (name === 'caption') {
      header = true;
      continue;
    } else if (name === 'tr') {
      rowNodes = [section];
    } else if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
      if (name === 'thead') header = true;
      rowNodes = section.children;
    } else {
      continue;
    }
    for (const tr of rowNodes) {
      if (!isElement(tr) || tr.name !== 'tr') continue;
      rows++;
      let cols = 0;
      for (const cell of tr.children) {
        if (!isElement(cell) || (cell.name !== 'td' && cell.name !== 'th')) continue;
        if (cell.name === 'th') header = true;
        cols += parseSpan(cell.attribs.colspan, DOCUMENT_LIMITS.maxColspan);
        if (budget.n > 0 && cellLooksLikeLayout(cell, budget)) return false;
      }
      if (cols > maxCols) maxCols = cols;
    }
  }
  if (rows === 0) return false;
  if (header) return true;
  return rows >= 2 && maxCols >= 2;
}

function cellLooksLikeLayout(cell: DomElement, budget: { n: number }): boolean {
  let text = 0;
  let stack: DomNode[] | undefined;
  // Most cells hold only text: scan children directly and allocate a stack
  // only once an element child shows up.
  for (const child of cell.children) {
    if (child.type === 'text') {
      text += countVisibleChars((child as DomText).data);
      if (text > LAYOUT_CELL_TEXT) return true;
    } else if (isElement(child)) {
      (stack ??= []).push(child);
    }
  }
  while (stack !== undefined && stack.length > 0) {
    if (--budget.n <= 0) return false;
    const node = stack.pop() as DomNode;
    if (node.type === 'text') {
      text += countVisibleChars((node as DomText).data);
      if (text > LAYOUT_CELL_TEXT) return true;
      continue;
    }
    if (!isElement(node) || SKIP_TAGS.has(node.name)) continue;
    if (LAYOUT_SIGNALS.has(node.name)) return true;
    for (const c of node.children) stack.push(c);
  }
  return false;
}
