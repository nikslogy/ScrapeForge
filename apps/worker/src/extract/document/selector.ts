import { type DomElement, isElement, isSimpleIdent, tagSelector } from './dom.js';
import type { NodeInfo } from './layout.js';

// Selectors are `tag:nth-child(k)` paths from html > body. They are computed
// on the unmodified parse (nothing is ever removed from the DOM), so they
// re-select the same element in cheerio.load(rawHtml).

function segment(info: NodeInfo): string {
  return `${tagSelector(info.el.name)}:nth-child(${info.nth})`;
}

/**
 * Unique selector for a visible element. Ancestors are memoized as they are
 * built; V8 concatenation shares prefixes (rope strings), so memoizing every
 * level stays linear in memory until a string is flattened.
 */
export function selectorOf(info: NodeInfo): string {
  if (info.sel !== undefined) return info.sel;
  const chain: NodeInfo[] = [];
  let cur: NodeInfo | null = info;
  while (cur !== null && cur.sel === undefined) {
    chain.push(cur);
    cur = cur.parent;
  }
  let sel = cur?.sel ?? 'html';
  for (let i = chain.length - 1; i >= 0; i--) {
    sel = `${sel} > ${segment(chain[i])}`;
    chain[i].sel = sel;
  }
  return sel;
}

interface Step {
  tag: string;
  cls?: string;
  /** Inclusive nth-child bounds: :nth-child(n+min):nth-child(-n+max). */
  min?: number;
  max?: number;
  /** nth-child indexes excluded with :not(:nth-child(k)). */
  not?: number[];
}

function stepToString(step: Step): string {
  let s = step.tag;
  if (step.cls) s += `.${step.cls}`;
  if (step.min !== undefined && step.min > 1) s += `:nth-child(n+${step.min})`;
  if (step.max !== undefined) s += `:nth-child(-n+${step.max})`;
  if (step.not) for (const k of step.not) s += `:not(:nth-child(${k}))`;
  return s;
}

function hasClass(el: DomElement, cls: string): boolean {
  const c = el.attribs.class;
  if (!c || !c.includes(cls)) return false;
  return c.split(/\s+/).includes(cls);
}

function commonStep(level: NodeInfo[]): Step {
  const first = level[0].el;
  const tag = level.every((i) => i.el.name === first.name) ? tagSelector(first.name) : '*';
  for (const cls of (first.attribs.class ?? '').split(/\s+/)) {
    if (!cls || !isSimpleIdent(cls)) continue;
    if (level.every((i) => hasClass(i.el, cls))) return { tag, cls };
  }
  return { tag };
}

function matchesStep(el: DomElement, nth: number, step: Step): boolean {
  if (step.tag !== '*' && el.name !== step.tag) return false;
  if (step.cls && !hasClass(el, step.cls)) return false;
  if (step.min !== undefined && nth < step.min) return false;
  if (step.max !== undefined && nth > step.max) return false;
  if (step.not && step.not.includes(nth)) return false;
  return true;
}

interface Match {
  el: DomElement;
  nth: number;
}

/**
 * Evaluate `lca > step1 > step2 ...` against the raw DOM, hidden elements
 * included (the selector runs against the raw snapshot). undefined when the
 * match set explodes past `cap`.
 */
function evaluate(lca: DomElement, steps: Step[], cap: number): Match[] | undefined {
  let frontier: Match[] = [{ el: lca, nth: 1 }];
  for (const step of steps) {
    const next: Match[] = [];
    for (const { el } of frontier) {
      let nth = 0;
      for (const c of el.children) {
        if (!isElement(c)) continue;
        nth++;
        if (matchesStep(c, nth, step)) {
          next.push({ el: c, nth });
          if (next.length > cap) return undefined;
        }
      }
    }
    frontier = next;
  }
  return frontier;
}

function sameSet(matches: Match[], want: Set<DomElement>): boolean {
  if (matches.length !== want.size) return false;
  for (const m of matches) if (!want.has(m.el)) return false;
  return true;
}

/** Exact lists are slow in css-select (O(entries × siblings) per element); keep them short. */
const MAX_EXACT_LIST = 100;
const MAX_NOT_EXCLUSIONS = 8;

export interface GroupSelector {
  selector: string;
  /** False when no exact form was affordable and the selector over-matches. */
  exact: boolean;
}

/**
 * Selector matching exactly `members` in the raw snapshot. Prefers a
 * generalizing form (`lca-path > li.product`); when extra siblings match
 * (hidden cards, filtered items, records past the block cap) it narrows with
 * an nth-child range and a few :not(:nth-child(k)); then a list of exact
 * paths (≤ 100 members); finally the generalizing form, flagged inexact.
 */
export function groupSelector(members: NodeInfo[]): GroupSelector {
  if (members.length === 0) return { selector: '', exact: true };
  const exactList = (): string => members.map(selectorOf).join(', ');
  const depth = members[0].depth;
  if (!members.every((m) => m.depth === depth)) {
    return { selector: exactList(), exact: true };
  }

  // Climb level by level until every chain meets at one ancestor.
  const levels: NodeInfo[][] = [members];
  let current = members;
  let lca: NodeInfo | undefined;
  while (!lca) {
    const parents: NodeInfo[] = [];
    const seen = new Set<NodeInfo>();
    for (const m of current) {
      const p = m.parent;
      if (p === null) return { selector: exactList(), exact: true };
      if (!seen.has(p)) {
        seen.add(p);
        parents.push(p);
      }
    }
    if (parents.length === 1) lca = parents[0];
    else {
      levels.push(parents);
      current = parents;
    }
  }

  const steps = levels.reverse().map(commonStep);
  const last = steps[steps.length - 1];
  const want = new Set(members.map((m) => m.el));
  const cap = members.length * 4 + 64;
  const render = (): string => `${selectorOf(lca as NodeInfo)} > ${steps.map(stepToString).join(' > ')}`;
  const general = render();

  let got = evaluate(lca.el, steps, cap);
  if (got && !sameSet(got, want)) {
    // Narrow to the members' nth-child range when that excludes something
    // (e.g. the prefix of a list kept at the block cap).
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (const m of members) {
      if (m.nth < min) min = m.nth;
      if (m.nth > max) max = m.nth;
    }
    if (got.some((m) => m.nth < min)) last.min = min;
    if (got.some((m) => m.nth > max)) last.max = max;
    if (last.min !== undefined || last.max !== undefined) got = evaluate(lca.el, steps, cap);
  }
  if (got && !sameSet(got, want)) {
    const memberNth = new Set(members.map((m) => m.nth));
    const extras = got.filter((m) => !want.has(m.el));
    const extraNth = [...new Set(extras.map((m) => m.nth))];
    if (got.length - extras.length === want.size && extraNth.length <= MAX_NOT_EXCLUSIONS && extraNth.every((k) => !memberNth.has(k))) {
      last.not = extraNth.sort((x, y) => x - y);
      got = evaluate(lca.el, steps, cap);
    }
  }
  if (got && sameSet(got, want)) return { selector: render(), exact: true };
  if (members.length <= MAX_EXACT_LIST) return { selector: exactList(), exact: true };
  return { selector: general, exact: false };
}
