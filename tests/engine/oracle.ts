// Gold-oracle fake model for engine tests.
//
// Answers the extraction protocol the way a careful model would, but from the
// fixture's hand-labelled gold: for every requested field it looks for the
// gold value in the PROMPT TEXT ("[bN] …" lines, record frames, table rows)
// and returns the value as displayed there, citing the block it read it from.
// It never looks at the HTML or the SourceDocument, so it sees exactly what a
// real model sees: values outside the rendered blocks (truncated input,
// hidden text, embedded JSON) cannot be found and come back as null.
//
// Value location (per gold value):
//   string   case/whitespace-insensitive substring of a block's text or one
//            of its attributes (word-bounded); returned as printed
//   number   a numeric token of the block text whose locale readings include
//            the gold number, returned with its currency symbol/code; then a
//            spelled-out number ("Four" in class="star-rating Four"); then
//            numeric tokens of non-URL attributes (aria-label="4.7 stars")
//   boolean  an availability/yes-no phrase from the block text ("In stock")
//   string[] each item located separately; cites the block holding most items
// Listing fixtures: each gold record is matched to the record frame or table
// row holding most of its values (one-to-one, greedy in gold order) and the
// records are returned in page order. Records whose frame is not in the
// prompt (truncated input) are not returned.

import type { FakeHandler } from '../../apps/worker/src/extract/llm/index.js';
import type { LlmRequest, LlmResponse } from '../../apps/worker/src/extract/types.js';
import { findNumericTokens, localeNumberCandidates } from '../../apps/worker/src/extract/validate/index.js';
import type { Fixture } from '../fixtures/extraction/load.js';

export interface PromptBlock {
  id: string;
  text: string;
  attrs: Record<string, string>;
  /** Index into ParsedPrompt.scopes of the innermost record frame, when any. */
  scope?: number;
  /** Position in the prompt (blocks and table rows share one counter). */
  order: number;
}

export interface PromptRow {
  /** Id of the table block the row belongs to. */
  tableId: string;
  cells: string[];
  order: number;
}

export interface PromptScope {
  kind: 'record' | 'row';
  /** Record block id, or the table block id for rows. */
  id: string;
  order: number;
  blocks: PromptBlock[];
  row?: PromptRow;
}

export interface ParsedPrompt {
  fields: string[];
  blocks: PromptBlock[];
  rows: PromptRow[];
  scopes: PromptScope[];
}

export interface Cell {
  v: unknown;
  b: string | null;
}

// ─────────────────────────────────────────────────────────────
// Prompt parsing
// ─────────────────────────────────────────────────────────────

const FIELD_LINE = /^- ("(?:[^"\\]|\\.)*") \(/;
const BLOCK_LINE = /^\[(b\d+)\](.*)$/;
const RECORD_OPEN = /^ <record\b[^>]*>(.*)$/;
const TABLE_OPEN = /^ <table\b/;
const ATTR_KEY = /^[a-z][a-z0-9_:-]*=/i;

/** Field names listed under "Fields:" in the system prompt, in order. */
export function promptFields(system: string): string[] {
  const out: string[] = [];
  let inFields = false;
  for (const line of system.split('\n')) {
    if (line === 'Fields:') {
      inFields = true;
      continue;
    }
    if (!inFields) continue;
    const m = FIELD_LINE.exec(line);
    if (m) out.push(JSON.parse(m[1]) as string);
  }
  return out;
}

/** Splits "text {k=v, k2=v2}" into text and attributes. */
export function splitAttrs(content: string): { text: string; attrs: Record<string, string> } {
  const attrs: Record<string, string> = {};
  if (!content.endsWith('}')) return { text: content, attrs };
  let open = content.startsWith('{') ? 0 : content.lastIndexOf(' {');
  while (open >= 0) {
    const start = content[open] === '{' ? open + 1 : open + 2;
    const inner = content.slice(start, -1);
    if (ATTR_KEY.test(inner)) {
      for (const part of inner.split(/, (?=[a-z][a-z0-9_:-]*=)/i)) {
        const eq = part.indexOf('=');
        if (eq > 0) attrs[part.slice(0, eq)] = part.slice(eq + 1);
      }
      return { text: content.slice(0, open).trim(), attrs };
    }
    if (open === 0) break;
    open = content.lastIndexOf(' {', open - 1);
  }
  return { text: content, attrs: {} };
}

/** Table cells of a "| a | b |" line (escaped pipes stay inside cells). */
function splitRow(line: string): string[] {
  const inner = line.slice(1, line.endsWith('|') ? -1 : undefined);
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

export function parsePrompt(req: Pick<LlmRequest, 'system' | 'user'>): ParsedPrompt {
  const fields = promptFields(req.system);
  const lines = req.user.split('\n');
  const start = lines.indexOf('<page>');
  const end = lines.lastIndexOf('</page>');
  const blocks: PromptBlock[] = [];
  const rows: PromptRow[] = [];
  const scopes: PromptScope[] = [];
  const open: number[] = [];
  let order = 0;
  let table: string | null = null;

  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    if (table !== null) {
      if (line === '</table>') {
        table = null;
      } else if (line.startsWith('|')) {
        const row: PromptRow = { tableId: table, cells: splitRow(line), order: order++ };
        rows.push(row);
        scopes.push({ kind: 'row', id: table, order: row.order, blocks: [], row });
      }
      continue;
    }
    if (line === '</record>') {
      open.pop();
      continue;
    }
    const m = BLOCK_LINE.exec(line);
    if (!m) continue;
    const [, id, rest] = m;
    const rec = RECORD_OPEN.exec(rest);
    if (rec) {
      const scope: PromptScope = { kind: 'record', id, order: order++, blocks: [] };
      scopes.push(scope);
      // Record attributes (data-*, href) belong to the record itself.
      const { attrs } = splitAttrs(rec[1].trim());
      const block: PromptBlock = { id, text: '', attrs, scope: scopes.length - 1, order: scope.order };
      blocks.push(block);
      for (const s of open) scopes[s].blocks.push(block);
      scope.blocks.push(block);
      open.push(scopes.length - 1);
      continue;
    }
    if (TABLE_OPEN.test(rest)) {
      table = id;
      continue;
    }
    const { text, attrs } = splitAttrs(rest.startsWith(' ') ? rest.slice(1) : rest);
    const block: PromptBlock = { id, text, attrs, order: order++ };
    if (open.length > 0) block.scope = open[open.length - 1];
    blocks.push(block);
    for (const s of open) scopes[s].blocks.push(block);
  }
  return { fields, blocks, rows, scopes };
}

// ─────────────────────────────────────────────────────────────
// Value location
// ─────────────────────────────────────────────────────────────

/** A searchable unit: a block (text + attributes) or a table row (cells), cited by block id. */
interface Unit {
  id: string;
  text: string;
  attrs: Record<string, string>;
  order: number;
}

function unitsOf(blocks: PromptBlock[], rows: PromptRow[]): Unit[] {
  const units: Unit[] = blocks.map((b) => ({ id: b.id, text: b.text, attrs: b.attrs, order: b.order }));
  for (const r of rows) units.push({ id: r.tableId, text: r.cells.join(' | '), attrs: {}, order: r.order });
  return units.sort((a, b) => a.order - b.order);
}

function norm(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const WORD = /[\p{L}\p{N}]/u;

/** Word-bounded, case/whitespace-insensitive find; returns the matched text as printed. */
export function findText(haystack: string, needle: string): string | null {
  const hay = haystack.normalize('NFKC').replace(/\s+/g, ' ');
  const lowerHay = hay.toLowerCase();
  const n = norm(needle);
  if (n === '') return null;
  // toLowerCase keeps the length for the scripts in this corpus; guard anyway.
  if (lowerHay.length !== hay.length) return lowerHay.includes(n) ? needle : null;
  for (let i = lowerHay.indexOf(n); i >= 0; i = lowerHay.indexOf(n, i + 1)) {
    const before = lowerHay[i - 1];
    const after = lowerHay[i + n.length];
    if (WORD.test(n[0]) && before !== undefined && WORD.test(before)) continue;
    if (WORD.test(n[n.length - 1]) && after !== undefined && WORD.test(after)) continue;
    return hay.slice(i, i + n.length);
  }
  return null;
}

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

const CURRENCY_BEFORE = /(\p{Sc}|\b[A-Z]{3}) ?$/u;
const CURRENCY_AFTER = /^ ?(\p{Sc}|[A-Z]{3}\b)/u;

/** Numeric token of `text` that reads as `gold`, with its currency, as printed. */
export function findNumber(text: string, gold: number): string | null {
  const t = text.normalize('NFKC');
  for (const token of findNumericTokens(t)) {
    const readings = localeNumberCandidates(token.text).map((v) => (token.negative ? -v : v));
    if (!readings.some((v) => sameNumber(v, gold))) continue;
    const before = CURRENCY_BEFORE.exec(t.slice(Math.max(0, token.start - (token.negative ? 5 : 4)), token.start - (token.negative ? 1 : 0)));
    const after = CURRENCY_AFTER.exec(t.slice(token.end, token.end + 5));
    const sign = token.negative ? '-' : '';
    if (before) return `${before[0]}${sign}${token.text}`;
    if (after) return `${sign}${token.text}${after[0]}`;
    return `${sign}${token.text}`;
  }
  return null;
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const URL_ATTRS = new Set(['href', 'src']);

const TRUE_PHRASES = ['in stock', 'auf lager', 'available', 'yes', '✓'];
const FALSE_PHRASES = ['out of stock', 'sold out', 'currently unavailable', 'unavailable', 'nicht vorrätig', 'on-site', 'no'];

function isAbsoluteUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** Locates one gold scalar in the units; null when it is not shown. */
export function locate(units: Unit[], gold: unknown): Cell | null {
  if (gold === null || gold === undefined) return null;
  if (typeof gold === 'number') {
    for (const u of units) {
      const hit = findNumber(u.text, gold);
      if (hit !== null) return { v: hit, b: u.id };
    }
    if (Number.isInteger(gold) && gold >= 0 && gold < NUMBER_WORDS.length) {
      const word = NUMBER_WORDS[gold];
      for (const u of units) {
        const hit = findText(u.text, word);
        if (hit !== null) return { v: hit, b: u.id };
        for (const v of Object.values(u.attrs)) {
          const inAttr = findText(v, word);
          if (inAttr !== null) return { v: inAttr, b: u.id };
        }
      }
    }
    for (const u of units) {
      for (const [k, v] of Object.entries(u.attrs)) {
        if (URL_ATTRS.has(k)) continue;
        const hit = findNumber(v, gold);
        if (hit !== null) return { v: hit, b: u.id };
      }
    }
    return null;
  }
  if (typeof gold === 'boolean') {
    for (const phrase of gold ? TRUE_PHRASES : FALSE_PHRASES) {
      for (const u of units) {
        const hit = findText(u.text, phrase);
        if (hit !== null) return { v: hit, b: u.id };
      }
    }
    return null;
  }
  if (typeof gold === 'string') {
    if (isAbsoluteUrl(gold)) {
      for (const u of units) {
        for (const v of Object.values(u.attrs)) if (v === gold) return { v, b: u.id };
      }
    }
    for (const u of units) {
      const hit = findText(u.text, gold);
      if (hit !== null) return { v: hit, b: u.id };
    }
    for (const u of units) {
      for (const v of Object.values(u.attrs)) {
        const hit = findText(v, gold);
        if (hit !== null) return { v: hit, b: u.id };
      }
    }
    return null;
  }
  if (Array.isArray(gold)) {
    const items: unknown[] = [];
    const cited = new Map<string, number>();
    for (const item of gold) {
      const cell = locate(units, item);
      if (cell === null) continue;
      items.push(cell.v);
      if (cell.b) cited.set(cell.b, (cited.get(cell.b) ?? 0) + 1);
    }
    if (items.length === 0) return null;
    const b = [...cited].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    return { v: items, b };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Answering
// ─────────────────────────────────────────────────────────────

export type OracleRecord = Record<string, Cell>;

function goldRecords(fixture: Pick<Fixture, 'gold' | 'expectedShape'>): Array<Record<string, unknown>> {
  if (fixture.gold === null) return [];
  return fixture.expectedShape === 'array' ? (fixture.gold as Array<Record<string, unknown>>) : [fixture.gold as Record<string, unknown>];
}

function answerRecord(units: Unit[], gold: Record<string, unknown>, fields: string[]): OracleRecord {
  const out: OracleRecord = {};
  for (const f of fields) {
    const value = Object.hasOwn(gold, f) ? gold[f] : null;
    out[f] = locate(units, value) ?? { v: null, b: null };
  }
  return out;
}

/** The records the oracle would return for this prompt. */
export function oracleRecords(fixture: Pick<Fixture, 'gold' | 'expectedShape' | 'recordKey'>, prompt: ParsedPrompt): OracleRecord[] {
  const golds = goldRecords(fixture);
  if (golds.length === 0) return [];
  if (fixture.expectedShape === 'object') {
    return [answerRecord(unitsOf(prompt.blocks, prompt.rows), golds[0], prompt.fields)];
  }
  const used = new Set<number>();
  const matched: Array<{ scope: PromptScope; record: OracleRecord }> = [];
  for (const gold of golds) {
    let best: { index: number; score: number } | null = null;
    prompt.scopes.forEach((scope, index) => {
      if (used.has(index)) return;
      const units = scope.row ? unitsOf([], [scope.row]) : unitsOf(scope.blocks, []);
      const key = fixture.recordKey;
      if (key && gold[key] !== null && gold[key] !== undefined && locate(units, gold[key]) === null) return;
      let score = 0;
      for (const f of Object.keys(gold)) if (gold[f] !== null && locate(units, gold[f]) !== null) score++;
      if (score > 0 && (best === null || score > best.score)) best = { index, score };
    });
    if (best === null) continue;
    const { index } = best as { index: number; score: number };
    used.add(index);
    const scope = prompt.scopes[index];
    const units = scope.row ? unitsOf([], [scope.row]) : unitsOf(scope.blocks, []);
    matched.push({ scope, record: answerRecord(units, gold, prompt.fields) });
  }
  return matched.sort((a, b) => a.scope.order - b.scope.order).map((m) => m.record);
}

export interface OracleOptions {
  /** Rewrites the oracle's records before they are sent (adversarial variants). */
  transform?: (records: OracleRecord[], prompt: ParsedPrompt) => OracleRecord[];
  /** Usage reported per call. */
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

function response(text: string, opts: OracleOptions): LlmResponse {
  return {
    text,
    finishReason: 'stop',
    inputTokens: opts.inputTokens ?? 1_000,
    outputTokens: opts.outputTokens ?? 200,
    costUsd: opts.costUsd ?? 0,
    latencyMs: 1,
  };
}

/**
 * FakeProvider handler answering from the fixture's gold. Repair prompts
 * (no "<page>" section) are answered with the bad output unchanged, which
 * the engine then reports as a parse failure.
 */
export function oracleHandler(fixture: Pick<Fixture, 'gold' | 'expectedShape' | 'recordKey'>, opts: OracleOptions = {}): FakeHandler {
  return (_caps, req) => {
    if (!req.user.includes('\n<page>\n')) return response(req.user, opts);
    const prompt = parsePrompt(req);
    let records = oracleRecords(fixture, prompt);
    if (opts.transform) records = opts.transform(records, prompt);
    return response(JSON.stringify({ records }), opts);
  };
}
