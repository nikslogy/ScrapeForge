import { createHash } from 'node:crypto';
import { INLINE_TAGS } from './dom.js';
import { F_IN_DATA_TABLE, F_IN_HEADING, F_IN_NAV, F_NAV_CLASS, type NodeInfo } from './layout.js';
import { DOCUMENT_LIMITS } from './limits.js';

// Record-group detection: repeated sibling structures such as product cards,
// search results or comments. Runs on the visible layout tree before blocks
// are emitted so record blocks can parent their content.

export interface DetectedGroup {
  members: NodeInfo[];
  /** sha256 (16 hex) of the member key + core structure tokens. */
  signature: string;
}

// Tags that are never records themselves: text blocks, table internals,
// form/void elements. Table rows are handled as tables, never as records.
const EXCLUDED_MEMBER_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'dt', 'dd', 'tr', 'td',
  'th', 'thead', 'tbody', 'tfoot', 'caption', 'colgroup', 'col', 'option', 'optgroup',
  'br', 'hr', 'img', 'input', 'select', 'textarea', 'button', 'area', 'map', 'picture',
  'figcaption', 'summary', 'label', 'legend',
]);

const MAX_STRUCT_TOKENS = 64;
const MAX_STRUCT_DEPTH = 3;
const MIN_SIMILARITY = 0.5;
/** Single link this short (with ~all of the member's text) = a menu item. */
const SHORT_LINK_CHARS = 40;
const MAX_WRAPPER_DESCENT = 8;
/** Nested groups survive only with at least this many records per outer record. */
const LARGE_INNER_PER_OUTER = 5;
/** Outer members that are ≥ this share pure wrappers of an inner group are layout. */
const LAYOUT_WRAPPER_SHARE = 0.8;
/** A nav-named element holding more of the page text than this is a layout wrapper. */
const NAV_CLASS_MAX_TEXT_SHARE = 0.3;

function memberKey(info: NodeInfo): string {
  info.key ??= `${info.el.name}.${info.stableClass}`;
  return info.key;
}

function isShortSingleLink(m: NodeInfo): boolean {
  const ownLink = m.el.name === 'a' && m.el.attribs.href !== undefined ? 1 : 0;
  return m.linkCount + ownLink === 1 && m.linkTextLen >= 0.9 * m.textLen && m.textLen < SHORT_LINK_CHARS;
}

function isLinkList(m: NodeInfo): boolean {
  return m.linkCount >= 3 && m.linkTextLen >= 0.9 * m.textLen && m.linkTextLen / m.linkCount < 30;
}

/**
 * Number of distinct content parts (element children holding text or an
 * image), looking through single-child wrappers. Plain bullet text and
 * "one link per item" lists have one part; cards and results have several.
 */
function contentParts(m: NodeInfo): number {
  let cur = m;
  for (let k = 0; k < MAX_WRAPPER_DESCENT; k++) {
    let parts = 0;
    let only: NodeInfo | undefined;
    for (const c of cur.children) {
      if (c.textLen > 0 || c.imgCount > 0 || c.el.name === 'img') {
        parts++;
        only = c;
      }
    }
    if (parts === 1 && cur.ownTextLen === 0 && only) {
      cur = only;
      continue;
    }
    return parts;
  }
  return 0;
}

/** Cheap checks first: most children (icons, spans, links) fail here. */
function plausibleMember(m: NodeInfo): boolean {
  if (m.textLen < DOCUMENT_LIMITS.minRecordTextChars || m.children.length === 0) return false;
  const name = m.el.name;
  if (EXCLUDED_MEMBER_TAGS.has(name)) return false;
  return !(INLINE_TAGS.has(name) && !m.hasBlockDesc);
}

function eligibleMember(m: NodeInfo): boolean {
  if (m.depth > DOCUMENT_LIMITS.maxBlockDepth) return false;
  if (isShortSingleLink(m) || isLinkList(m)) return false;
  return contentParts(m) >= 2;
}

function eligibleParent(p: NodeInfo): boolean {
  if (p.children.length < 2) return false;
  if (p.flags & (F_IN_DATA_TABLE | F_IN_NAV | F_IN_HEADING)) return false;
  return p.depth < DOCUMENT_LIMITS.maxBlockDepth;
}

/**
 * tag.class tokens of the member's descendants (≤ 3 levels, ≤ 64 tokens),
 * memoized per detection run.
 */
function structTokens(m: NodeInfo, cache: Map<NodeInfo, Set<string>>): Set<string> {
  const cached = cache.get(m);
  if (cached) return cached;
  const tokens = new Set<string>();
  // Breadth-first over one array; `levelEnd` marks where each depth stops.
  const queue: NodeInfo[] = [...m.children];
  let levelEnd = queue.length;
  let depth = 1;
  for (let i = 0; i < queue.length && i < MAX_STRUCT_TOKENS * 2 && tokens.size < MAX_STRUCT_TOKENS; i++) {
    if (i === levelEnd) {
      if (++depth > MAX_STRUCT_DEPTH) break;
      levelEnd = queue.length;
    }
    const c = queue[i];
    tokens.add(memberKey(c));
    if (depth < MAX_STRUCT_DEPTH) for (const g of c.children) queue.push(g);
  }
  cache.set(m, tokens);
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

interface Similar {
  members: NodeInfo[];
  core: string[];
}

/** Members sampled to estimate the core structure of very large groups. */
const CORE_SAMPLE = 64;

/** Keep members whose structure matches the majority ("core") structure. */
function filterSimilar(members: NodeInfo[], cache: Map<NodeInfo, Set<string>>): Similar {
  const freq = new Map<string, number>();
  const step = members.length > CORE_SAMPLE ? members.length / CORE_SAMPLE : 1;
  let sampled = 0;
  for (let i = 0; i < members.length; i += step) {
    sampled++;
    for (const t of structTokens(members[Math.floor(i)], cache)) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  const need = Math.ceil(sampled / 2);
  const core = new Set<string>();
  for (const [t, n] of freq) if (n >= need) core.add(t);
  const kept = members.filter((m) => jaccard(structTokens(m, cache), core) >= MIN_SIMILARITY);
  return { members: kept, core: [...core].sort() };
}

interface Candidate {
  parent: NodeInfo;
  key: string;
  members: NodeInfo[];
}

function perParentCandidates(all: NodeInfo[], cache: Map<NodeInfo, Set<string>>): Candidate[] {
  const out: Candidate[] = [];
  for (const p of all) {
    if (!eligibleParent(p)) continue;
    let plausible: NodeInfo[] | undefined;
    for (const c of p.children) {
      if (plausibleMember(c)) (plausible ??= []).push(c);
    }
    if (!plausible || plausible.length < 2) continue;
    const byKey = new Map<string, NodeInfo[]>();
    for (const c of plausible) {
      const key = memberKey(c);
      const list = byKey.get(key);
      if (list) list.push(c);
      else byKey.set(key, [c]);
    }
    for (const [key, list] of byKey) {
      if (list.length < 2) continue;
      const eligible = list.filter(eligibleMember);
      if (eligible.length < 2) continue;
      const similar = filterSimilar(eligible, cache).members;
      if (similar.length >= 2) out.push({ parent: p, key, members: similar });
    }
  }
  return out;
}

/**
 * Merge per-parent candidates whose parents are same-key siblings (grid rows
 * of cards: div.row > div.col × 3, repeated).
 */
function mergeCousins(cands: Candidate[], cache: Map<NodeInfo, Set<string>>): NodeInfo[][] {
  const buckets = new Map<string, Candidate[]>();
  const singles: NodeInfo[][] = [];
  for (const c of cands) {
    const gp = c.parent.parent;
    if (!gp) {
      singles.push(c.members);
      continue;
    }
    const k = `${gp.order}|${memberKey(c.parent)}|${c.key}`;
    const list = buckets.get(k);
    if (list) list.push(c);
    else buckets.set(k, [c]);
  }
  const out = singles;
  for (const list of buckets.values()) {
    if (list.length === 1) {
      out.push(list[0].members);
      continue;
    }
    const merged = list.flatMap((c) => c.members).sort((a, b) => a.order - b.order);
    out.push(filterSimilar(merged, cache).members);
  }
  return out;
}

/** The single child holding all of `m`'s content, when `m` is a pure wrapper. */
function soleContentChild(m: NodeInfo): NodeInfo | undefined {
  if (m.ownTextLen > 0) return undefined;
  let only: NodeInfo | undefined;
  for (const c of m.children) {
    if (c.textLen > 0 || c.imgCount > 0 || c.el.name === 'img') {
      if (only) return undefined;
      only = c;
    }
  }
  return only && only.textLen === m.textLen && only.imgCount === m.imgCount ? only : undefined;
}

/** `c` is a member of `set`, or wraps one through single-child wrappers. */
function leadsToMember(c: NodeInfo, set: Set<NodeInfo>): boolean {
  let cur: NodeInfo | undefined = c;
  for (let k = 0; cur && k <= MAX_WRAPPER_DESCENT; k++) {
    if (set.has(cur)) return true;
    cur = soleContentChild(cur);
  }
  return false;
}

/** li > article.card: prefer the single meaningful child as the record. */
function descendWrappers(members: NodeInfo[]): NodeInfo[] {
  let cur = members;
  for (let k = 0; k < MAX_WRAPPER_DESCENT; k++) {
    const next: NodeInfo[] = [];
    let key: string | undefined;
    for (const m of cur) {
      const only = soleContentChild(m);
      if (!only) return cur;
      const name = only.el.name;
      if (EXCLUDED_MEMBER_TAGS.has(name) || (INLINE_TAGS.has(name) && !only.hasBlockDesc)) return cur;
      const ck = memberKey(only);
      if (key === undefined) key = ck;
      else if (key !== ck) return cur;
      next.push(only);
    }
    cur = next;
  }
  return cur;
}

function signatureOf(members: NodeInfo[], cache: Map<NodeInfo, Set<string>>): string {
  const core = filterSimilar(members, cache).core;
  return createHash('sha256')
    .update(`${memberKey(members[0])}|${core.join(',')}`)
    .digest('hex')
    .slice(0, 16);
}

/** Group index of the nearest strict ancestor that is a member of another group. */
function enclosingGroup(m: NodeInfo, memberGroup: Map<NodeInfo, number>): number {
  for (let p = m.parent; p !== null; p = p.parent) {
    const g = memberGroup.get(p);
    if (g !== undefined) return g;
  }
  return -1;
}

/**
 * Resolve nested groups. An outer group whose members are (almost) pure
 * wrappers of an inner group is layout (grid rows around cards) and is
 * dropped. Otherwise the outer group is kept and inner repetition survives
 * only when it is large (≥ 5 records per enclosing outer record).
 */
function resolveNesting(groups: NodeInfo[][]): NodeInfo[][] {
  const memberGroup = new Map<NodeInfo, number>();
  groups.forEach((g, gi) => {
    for (const m of g) if (!memberGroup.has(m)) memberGroup.set(m, gi);
  });
  const enclosing = groups.map((g) => enclosingGroup(g[0], memberGroup));
  const dropped = groups.map(() => false);

  groups.forEach((inner, bi) => {
    const ai = enclosing[bi];
    if (ai < 0) return;
    const innerSet = new Set(inner);
    let wrappers = 0;
    for (const a of groups[ai]) {
      const content = a.children.filter((c) => c.textLen > 0);
      if (content.length > 0 && content.every((c) => leadsToMember(c, innerSet))) wrappers++;
    }
    if (wrappers >= LAYOUT_WRAPPER_SHARE * groups[ai].length) dropped[ai] = true;
  });

  const keep = groups.map((_, i) => !dropped[i]);
  groups.forEach((inner, bi) => {
    if (dropped[bi]) return;
    let ai = enclosing[bi];
    while (ai >= 0 && dropped[ai]) ai = enclosing[ai];
    if (ai < 0) return;
    const outerSet = new Set(groups[ai]);
    const containers = new Set<NodeInfo>();
    for (const m of inner) {
      for (let p = m.parent; p !== null; p = p.parent) {
        if (outerSet.has(p)) {
          containers.add(p);
          break;
        }
      }
    }
    if (containers.size > 0 && inner.length / containers.size < LARGE_INNER_PER_OUTER) keep[bi] = false;
  });
  return groups.filter((_, i) => keep[i]);
}

/**
 * Turn class-named nav chrome (div.sidebar, ul.pagination) into F_IN_NAV for
 * its subtree, unless the element holds a large share of the page text: then
 * the class names a layout wrapper (body.has-sidebar, div.content-with-sidebar).
 * `all` is in pre-order, so parents are settled before their children.
 */
function applyNavClasses(all: NodeInfo[]): void {
  if (all.length === 0) return;
  const limit = all[0].textLen * NAV_CLASS_MAX_TEXT_SHARE;
  for (const info of all) {
    const parent = info.parent;
    if (parent && parent.flags & F_IN_NAV) info.flags |= F_IN_NAV;
    else if (info.flags & F_NAV_CLASS && info.textLen <= limit) info.flags |= F_IN_NAV;
  }
}

/**
 * Detect record groups: ≥ 3 visible siblings (or same-key cousins) sharing
 * tag + stable class, with similar internal structure, each with ≥ 10 visible
 * chars and more than one content part, outside nav/menus/headings/data
 * tables. Sets NodeInfo.group / hasRecordDesc as a side effect.
 */
export function detectRecordGroups(all: NodeInfo[]): DetectedGroup[] {
  applyNavClasses(all);
  const cache = new Map<NodeInfo, Set<string>>();
  const merged = mergeCousins(perParentCandidates(all, cache), cache)
    .map(descendWrappers)
    .filter((g) => g.length >= DOCUMENT_LIMITS.minRecordsPerGroup);

  // Defensive: one element can only belong to one group.
  const claimed = new Set<NodeInfo>();
  const distinct = merged.filter((g) => {
    if (g.some((m) => claimed.has(m))) return false;
    for (const m of g) claimed.add(m);
    return true;
  });

  let groups = resolveNesting(distinct);
  if (groups.length > DOCUMENT_LIMITS.maxRecordGroups) {
    groups = [...groups].sort((a, b) => b.length - a.length).slice(0, DOCUMENT_LIMITS.maxRecordGroups);
  }
  groups.sort((a, b) => a[0].order - b[0].order);

  const out: DetectedGroup[] = groups.map((members) => ({ members, signature: signatureOf(members, cache) }));
  out.forEach((g, gi) => {
    for (const m of g.members) {
      m.group = gi;
      for (let p = m.parent; p !== null && !p.hasRecordDesc; p = p.parent) p.hasRecordDesc = true;
    }
  });
  return out;
}
