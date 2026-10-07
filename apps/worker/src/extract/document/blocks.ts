import type { BlockKind, SourceBlock } from '../types.js';
import {
  type DomText,
  HEADING_LEVEL,
  INLINE_TAGS,
  collapseWhitespace,
  collectAttrs,
  isElement,
  resolveUrl,
} from './dom.js';
import { HINT_NONE, HINT_STRONG } from './hints.js';
import { EVIDENCE_ITEMPROP, type Layout, type NodeInfo } from './layout.js';
import { DOCUMENT_LIMITS } from './limits.js';
import { selectorOf } from './selector.js';
import { buildTable, tableText, visibleText } from './table.js';

// Pass 2: walk the visible tree once and cut it into blocks.
//
// Text ownership is a partition: every visible text node is appended to the
// "run" of exactly one owner element, and a run becomes a block when it is
// flushed. Owners are:
//   - atomic owners (headings, fields, buttons, selects): take all text below;
//   - split owners (p, li, blockquote, ...): take text, but nested headings,
//     fields, images, controls, list items, tables and records cut the run
//     into pieces;
//   - containers (div, section, td of layout tables, ...): own their leftover
//     text as 'text' blocks; nested block-level elements start new owners.
// Elements deeper than maxBlockDepth never become owners; their text folds
// into the nearest shallower one. A block's text therefore never repeats
// another block's text, and document.text is simply every non-empty block
// text joined with "\n" (record blocks only span their children's range).

const MODE_CONTAINER = 0;
const MODE_SPLIT = 1;
const MODE_ATOMIC = 2;

const EXIT_NONE = 0;
const EXIT_SEPARATOR = 1;
const EXIT_OWNER = 2;
const EXIT_ATOMIC = 3;
const EXIT_HEADING = 4;
const EXIT_RECORD = 5;

// Anything but whitespace. Zero-width/soft-hyphen-only text counts as text
// here and collapses to '' later, which flush() tolerates.
const NON_WHITESPACE = /\S/;

const PARAGRAPH_TAGS = new Set(['p', 'blockquote', 'pre', 'figcaption', 'address', 'dt', 'dd']);
/** Controls whose whole text is one unit (a select's options, a button label). */
const ATOMIC_TEXT_TAGS = new Set(['select', 'button']);

interface Owner {
  info: NodeInfo;
  kind: BlockKind;
  mode: number;
  /** Attributes attached to the owner's first emitted block. */
  attrs: Record<string, string> | undefined;
  emitted: boolean;
  /** Emit an empty-text block when no text was found (attrs are evidence). */
  keepEmpty: boolean;
}

interface OpenRecord {
  block: SourceBlock;
  firstStart: number;
  lastEnd: number;
  savedHeadings: HeadingEntry[];
  savedPath: string[];
}

interface HeadingEntry {
  level: number;
  text: string;
}

export interface EmittedGroup {
  id: string;
  /** Index into the detected groups. */
  groupIndex: number;
  recordIds: string[];
  members: NodeInfo[];
}

export interface EmitResult {
  blocks: SourceBlock[];
  text: string;
  groups: EmittedGroup[];
  firstH1?: string;
  truncated: boolean;
  warnings: string[];
}

const EMPTY_PATH: string[] = Object.freeze([]) as unknown as string[];

function capHeading(text: string): string {
  const max = DOCUMENT_LIMITS.maxHeadingPathChars;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function hasNonClassEvidence(attrs: Record<string, string> | undefined): boolean {
  if (!attrs) return false;
  for (const k in attrs) if (k !== 'class') return true;
  return false;
}

class BlockEmitter {
  readonly blocks: SourceBlock[] = [];
  readonly groups: EmittedGroup[] = [];
  readonly warnings: string[] = [];
  firstH1: string | undefined;
  truncated = false;

  private readonly parts: string[] = [];
  private offset = 0;
  private readonly run: string[] = [];
  /** The run holds at least one non-whitespace character. */
  private runHasText = false;
  private readonly owners: Owner[] = [];
  private atomicDepth = 0;
  private readonly records: OpenRecord[] = [];
  private headings: HeadingEntry[] = [];
  private path: string[] = EMPTY_PATH;
  private readonly groupIds = new Map<number, EmittedGroup>();
  private droppedTableRows = 0;

  constructor(private readonly base: URL | undefined) {}

  emitAll(layout: Layout): string {
    const root = layout.root;
    this.pushOwner(root, 'text', MODE_CONTAINER, undefined, false);
    // Parallel arrays instead of frame objects: one walk touches every
    // visible element, so per-element allocations show up as GC time.
    const infos: NodeInfo[] = [root];
    const raw: number[] = [0];
    const vis: number[] = [0];
    const exits: number[] = [EXIT_OWNER];
    while (infos.length > 0 && !this.truncated) {
      const top = infos.length - 1;
      const info = infos[top];
      const kids = info.el.children;
      const r = raw[top];
      if (r < kids.length) {
        raw[top] = r + 1;
        const child = kids[r];
        if (child.type === 'text') {
          this.pushText((child as DomText).data);
        } else if (isElement(child)) {
          const v = vis[top];
          const ci = info.children[v];
          // Elements without NodeInfo are hidden or non-rendered: skipped.
          if (ci !== undefined && ci.el === child) {
            vis[top] = v + 1;
            const exit = this.enter(ci);
            if (exit >= 0) {
              infos.push(ci);
              raw.push(0);
              vis.push(0);
              exits.push(exit);
            }
          }
        }
        continue;
      }
      infos.pop();
      raw.pop();
      vis.pop();
      this.exit(info, exits.pop() as number);
    }
    if (this.truncated) {
      // Close what is still open so record ranges stay valid.
      while (this.records.length > 0) this.closeRecord();
      this.warnings.push(`blocks_truncated: stopped at ${DOCUMENT_LIMITS.maxBlocks} blocks`);
    }
    if (this.droppedTableRows > 0) {
      this.warnings.push(`table_rows_truncated: dropped ${this.droppedTableRows} row(s) beyond ${DOCUMENT_LIMITS.maxTableRows} per table`);
    }
    const text = this.parts.join('');
    for (const b of this.blocks) if (b.kind === 'record') b.text = text.slice(b.start, b.end);
    return text;
  }

  private pushText(data: string): void {
    this.run.push(data);
    if (!this.runHasText && NON_WHITESPACE.test(data)) this.runHasText = true;
  }

  private get owner(): Owner {
    return this.owners[this.owners.length - 1];
  }

  /** Returns the frame exit action, or -1 when the subtree is not descended. */
  private enter(info: NodeInfo): number {
    const name = info.el.name;
    const blockish = !INLINE_TAGS.has(name);
    if (this.atomicDepth > 0 || info.depth > DOCUMENT_LIMITS.maxBlockDepth) {
      if (name === 'img') return -1;
      if (info.dataTable) {
        // Data tables have no NodeInfo children; fold their text in directly.
        this.run.push(' ');
        this.pushText(visibleText(info.el));
        this.run.push(' ');
        return -1;
      }
      if (blockish) this.run.push(' ');
      return blockish ? EXIT_SEPARATOR : EXIT_NONE;
    }

    if (info.group >= 0) return this.openRecord(info) ? EXIT_RECORD : -1;
    if (name === 'table' && info.dataTable) {
      this.emitTable(info);
      return -1;
    }
    if (HEADING_LEVEL[name] !== undefined) {
      this.flush();
      this.pushOwner(info, 'heading', MODE_ATOMIC, this.headingAttrs(info), false);
      this.atomicDepth++;
      return EXIT_HEADING;
    }
    if (name === 'img') {
      this.emitImage(info);
      return -1;
    }
    if (name === 'br' || name === 'wbr') {
      this.run.push(' ');
      return -1;
    }
    const inRecord = this.records.length > 0;
    const hint = this.fieldHint(info, inRecord);
    if (hint >= 0) {
      this.flush();
      const attrs = collectAttrs(info.el, this.base);
      this.pushOwner(info, 'field', MODE_ATOMIC, attrs, hint === HINT_STRONG || hasNonClassEvidence(attrs));
      this.atomicDepth++;
      return EXIT_ATOMIC;
    }
    if (name === 'a' && inRecord && info.el.attribs.href !== undefined) {
      // A link wrapping other blocks (card image, heading...): keep its
      // href as an empty-text field, then walk its content normally.
      this.flush();
      const attrs = collectAttrs(info.el, this.base);
      if (hasNonClassEvidence(attrs)) this.emit('field', '', info, attrs);
      return EXIT_NONE;
    }
    if (ATOMIC_TEXT_TAGS.has(name)) {
      this.flush();
      this.pushOwner(info, 'text', MODE_ATOMIC, undefined, false);
      this.atomicDepth++;
      return EXIT_ATOMIC;
    }
    if (name === 'li' && !inRecord) {
      this.flush();
      this.pushOwner(info, 'list-item', MODE_SPLIT, undefined, false);
      return EXIT_OWNER;
    }
    const split = this.owner.mode === MODE_SPLIT;
    if (PARAGRAPH_TAGS.has(name) && !split) {
      this.flush();
      this.pushOwner(info, 'paragraph', MODE_SPLIT, undefined, false);
      return EXIT_OWNER;
    }
    if (!blockish) return EXIT_NONE;
    if (split) {
      this.run.push(' ');
      return EXIT_SEPARATOR;
    }
    this.flush();
    this.pushOwner(info, 'text', MODE_CONTAINER, undefined, false);
    return EXIT_OWNER;
  }

  private exit(info: NodeInfo, action: number): void {
    switch (action) {
      case EXIT_SEPARATOR:
        this.run.push(' ');
        return;
      case EXIT_OWNER:
        this.flush();
        this.owners.pop();
        return;
      case EXIT_ATOMIC: {
        this.flush();
        const o = this.owner;
        if (!o.emitted && o.keepEmpty) this.emit(o.kind, '', o.info, o.attrs);
        this.atomicDepth--;
        this.owners.pop();
        return;
      }
      case EXIT_HEADING: {
        const text = this.flush();
        this.atomicDepth--;
        this.owners.pop();
        if (text) this.pushHeading(HEADING_LEVEL[info.el.name] ?? 6, text);
        return;
      }
      case EXIT_RECORD:
        this.flush();
        this.owners.pop();
        this.closeRecord();
        return;
      default:
    }
  }

  /**
   * HINT_* level when the element is a field, -1 otherwise. Fields are small
   * leaves (≤ 200 visible chars, no block-level/img descendants, no records
   * inside) carrying evidence: itemprop, time/data/meter values, a hint
   * class/id, or (inside records) a link with text. The most specific
   * evidence wins: a wrapper with a hint class (p.byline) yields to the
   * fields inside it (span.author, time[datetime]); an itemprop yields only
   * to nested itemprops.
   */
  private fieldHint(info: NodeInfo, inRecord: boolean): number {
    if (info.hasRecordDesc || info.hasBlockDesc || info.textLen > DOCUMENT_LIMITS.maxFieldChars) return -1;
    if (info.evidence === EVIDENCE_ITEMPROP) return info.descEvidence === EVIDENCE_ITEMPROP ? -1 : HINT_STRONG;
    if (info.descEvidence > 0) return -1;
    if (info.evidence > 0) return HINT_STRONG;
    if (info.hint !== HINT_NONE) return info.hint;
    const a = info.el.attribs;
    if (info.el.name === 'a' && inRecord && a.href !== undefined && info.textLen >= 2) return HINT_NONE;
    return -1;
  }

  private headingAttrs(info: NodeInfo): Record<string, string> | undefined {
    const own = collectAttrs(info.el, this.base);
    // A heading that is essentially one link (card titles) carries the
    // link's href/title: often the only full title and the record's URL.
    if (info.linkCount !== 1 || info.linkTextLen * 2 < info.textLen || own?.href) return own;
    const link = findLink(info);
    if (!link) return own;
    const out: Record<string, string> = { ...own };
    const href = resolveUrl(link.el.attribs.href ?? '', this.base, 'href');
    if (href) out.href = href;
    const title = collapseWhitespace(link.el.attribs.title ?? '');
    if (title && !out.title) out.title = title.slice(0, DOCUMENT_LIMITS.maxAttrChars);
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private emitImage(info: NodeInfo): void {
    const attrs = collectAttrs(info.el, this.base);
    const alt = attrs?.alt ?? '';
    if (!alt && !(this.records.length > 0 && attrs?.src)) return;
    this.flush();
    this.emit('field', alt, info, attrs);
  }

  private emitTable(info: NodeInfo): void {
    this.flush();
    const data = buildTable(info.el);
    this.droppedTableRows += data.droppedRows;
    const text = tableText(data);
    if (!text) return;
    const table: NonNullable<SourceBlock['table']> = data.caption
      ? { caption: data.caption, headers: data.headers, rows: data.rows }
      : { headers: data.headers, rows: data.rows };
    this.emit('table', text, info, undefined, table);
  }

  private pushOwner(info: NodeInfo, kind: BlockKind, mode: number, attrs: Record<string, string> | undefined, keepEmpty: boolean): void {
    this.owners.push({ info, kind, mode, attrs, emitted: false, keepEmpty });
  }

  /** Emit the current run as a block of the current owner; returns its text. */
  private flush(): string {
    const run = this.run;
    if (run.length === 0) return '';
    // Whitespace-only runs (indentation between block children) are the
    // common case; skip the join and regex work for them.
    if (!this.runHasText) {
      run.length = 0;
      return '';
    }
    const text = collapseWhitespace(run.length === 1 ? run[0] : run.join(''));
    run.length = 0;
    this.runHasText = false;
    if (!text) return '';
    const o = this.owner;
    this.emit(o.kind, text, o.info, o.emitted ? undefined : o.attrs);
    o.emitted = true;
    return text;
  }

  private emit(
    kind: BlockKind,
    text: string,
    info: NodeInfo,
    attrs?: Record<string, string>,
    table?: SourceBlock['table'],
    recordGroupId?: string,
  ): SourceBlock | undefined {
    if (this.blocks.length >= DOCUMENT_LIMITS.maxBlocks) {
      this.truncated = true;
      return undefined;
    }
    let start = this.offset;
    if (text) {
      if (this.offset > 0) {
        this.parts.push('\n');
        this.offset++;
      }
      start = this.offset;
      this.parts.push(text);
      this.offset += text.length;
    }
    const block: SourceBlock = {
      id: `b${this.blocks.length}`,
      kind,
      text,
      headingPath: this.path,
      selector: selectorOf(info),
      start,
      end: this.offset,
    };
    const rec = this.records.length > 0 ? this.records[this.records.length - 1] : undefined;
    if (rec) {
      block.parentId = rec.block.id;
      if (text) {
        if (rec.firstStart < 0) rec.firstStart = start;
        rec.lastEnd = this.offset;
      }
    }
    const groupId = recordGroupId ?? rec?.block.recordGroupId;
    if (groupId) block.recordGroupId = groupId;
    if (table) block.table = table;
    if (attrs) block.attrs = attrs;
    if (kind === 'heading' && this.firstH1 === undefined && info.el.name === 'h1') this.firstH1 = text;
    this.blocks.push(block);
    return block;
  }

  private openRecord(info: NodeInfo): boolean {
    this.flush();
    let group = this.groupIds.get(info.group);
    const gid = group?.id ?? `g${this.groups.length}`;
    const block = this.emit('record', '', info, collectAttrs(info.el, this.base), undefined, gid);
    if (!block) return false;
    if (!group) {
      group = { id: gid, groupIndex: info.group, recordIds: [], members: [] };
      this.groupIds.set(info.group, group);
      this.groups.push(group);
    }
    group.recordIds.push(block.id);
    group.members.push(info);
    this.records.push({ block, firstStart: -1, lastEnd: -1, savedHeadings: this.headings, savedPath: this.path });
    this.pushOwner(info, 'text', MODE_CONTAINER, undefined, false);
    return true;
  }

  private closeRecord(): void {
    const rec = this.records.pop();
    if (!rec) return;
    if (rec.firstStart >= 0) {
      rec.block.start = rec.firstStart;
      rec.block.end = rec.lastEnd;
    } else {
      rec.block.start = rec.block.end = this.offset;
    }
    const parent = this.records.length > 0 ? this.records[this.records.length - 1] : undefined;
    if (parent && rec.firstStart >= 0) {
      if (parent.firstStart < 0) parent.firstStart = rec.firstStart;
      parent.lastEnd = rec.lastEnd;
    }
    // Headings inside a record (card titles) scope only that record.
    this.headings = rec.savedHeadings;
    this.path = rec.savedPath;
  }

  private pushHeading(level: number, text: string): void {
    const next = this.headings.filter((h) => h.level < level);
    next.push({ level, text: capHeading(text) });
    this.headings = next;
    this.path = Object.freeze(next.map((h) => h.text)) as unknown as string[];
  }
}

function findLink(info: NodeInfo): NodeInfo | undefined {
  const stack: NodeInfo[] = [...info.children];
  let budget = 500;
  while (stack.length > 0 && budget-- > 0) {
    const n = stack.pop() as NodeInfo;
    if (n.el.name === 'a' && n.el.attribs.href !== undefined) return n;
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return undefined;
}

export function emitBlocks(layout: Layout, base: URL | undefined): EmitResult {
  const emitter = new BlockEmitter(base);
  const text = emitter.emitAll(layout);
  return {
    blocks: emitter.blocks,
    text,
    groups: emitter.groups,
    firstH1: emitter.firstH1,
    truncated: emitter.truncated,
    warnings: emitter.warnings,
  };
}
