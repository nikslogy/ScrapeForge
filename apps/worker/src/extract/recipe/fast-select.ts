// Single-pass matcher for the simple selectors most recipes use.
//
// css-select walks every record subtree once per field and checks each match
// against every context element, which dominates a 5,000-record run. The
// common selector shapes (tag, .class, #id, [attr], [attr=value], structural
// pseudo-classes, descendant and child combinators) are compiled here into
// closures so the interpreter can test all fields during ONE walk of each
// record. Semantics replicate css-select as cheerio's find() runs it (see the
// differential tests): the leftmost compound may match the scope element
// itself or anything below it, a leading ">" means a direct child of the
// scope, class tokens split on JS whitespace, and the HTML attributes that
// css-select compares case-insensitively are compared the same way. Anything
// outside this subset returns null and goes through cheerio.

import { type DomElement, type DomNode, isElement } from './dom.js';

export interface FastSelector {
  /**
   * Starts one query relative to `scope` (like one find() call): the returned
   * test is true for elements that match. Callers pass only descendants of
   * the scope (a walk of its subtree); containment is not re-checked, which
   * would cost O(depth) per element. Memoized partial results live as long as
   * the returned function.
   */
  within(scope: DomNode): (el: DomElement) => boolean;
}

type Test = (el: DomElement, q: QueryState) => boolean;

/** Element-sibling positions of one parent's children, computed once per query. */
interface Positions {
  index: number;
  fromEnd: number;
  typeIndex: number;
  typeFromEnd: number;
}

interface QueryState {
  positions: Map<DomNode, Map<DomElement, Positions>>;
}

interface Compound {
  tests: Test[];
}

const MAX_FAST_COMPOUNDS = 6;
const IDENT = /^-?[_a-zA-Z][_a-zA-Z0-9-]*/;
const ATTR_NAME = /^[_a-zA-Z][-_a-zA-Z0-9]*/;
const NTH = /^\s*(?:(odd)|(even)|([+-]?\d*)n(?:\s*([+-])\s*(\d+))?|([+-]?\d+))\s*$/i;

// Values css-select compares case-insensitively for HTML documents.
const CASE_INSENSITIVE_ATTRS = new Set([
  'accept', 'accept-charset', 'align', 'alink', 'axis', 'bgcolor', 'charset', 'checked', 'clear', 'codetype',
  'color', 'compact', 'declare', 'defer', 'dir', 'direction', 'disabled', 'enctype', 'face', 'frame', 'hreflang',
  'http-equiv', 'lang', 'language', 'link', 'media', 'method', 'multiple', 'nohref', 'noresize', 'noshade',
  'nowrap', 'readonly', 'rel', 'rev', 'rules', 'scope', 'scrolling', 'selected', 'shape', 'target', 'text',
  'type', 'valign', 'valuetype', 'vlink',
]);

const cache = new Map<string, FastSelector | null>();
const MAX_CACHE = 1_000;

/** Compiled matcher, or null when the selector is outside the fast subset. */
export function compileFastSelector(selector: string): FastSelector | null {
  const hit = cache.get(selector);
  if (hit !== undefined) return hit;
  let compiled: FastSelector | null;
  try {
    compiled = parse(selector);
  } catch {
    compiled = null;
  }
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(selector, compiled);
  return compiled;
}

class Unsupported extends Error {}

function parse(selector: string): FastSelector | null {
  let s = selector.trim();
  if (s === '') return null;
  let leadingChild = false;
  if (s.startsWith('>')) {
    leadingChild = true;
    s = s.slice(1).trimStart();
  }
  const compounds: Compound[] = [];
  const combinators: Array<' ' | '>'> = [];
  let pos = 0;
  for (;;) {
    const [compound, next] = parseCompound(s, pos);
    compounds.push(compound);
    pos = next;
    if (pos >= s.length) break;
    const m = /^\s*(>)?\s*/.exec(s.slice(pos)) as RegExpExecArray;
    if (m[0].length === 0) throw new Unsupported('expected a combinator');
    pos += m[0].length;
    if (pos >= s.length) throw new Unsupported('trailing combinator');
    combinators.push(m[1] ? '>' : ' ');
  }
  if (compounds.length > MAX_FAST_COMPOUNDS) return null;
  const last = compounds.length - 1;
  return {
    within(scope) {
      // Results depend only on (compound, element, scope), so they are shared
      // by every element tested in this query.
      const ctx: MatchContext = { compounds, combinators, leadingChild, scope, memo: undefined, positions: new Map() };
      return (el) => el !== scope && matchAt(ctx, last, el);
    },
  };
}

function parseCompound(s: string, start: number): [Compound, number] {
  const tests: Test[] = [];
  let pos = start;
  const rest = (): string => s.slice(pos);
  if (s[pos] === '*') {
    pos++;
  } else {
    const tag = IDENT.exec(rest());
    if (tag) {
      const name = tag[0].toLowerCase();
      tests.push((el) => el.name === name);
      pos += tag[0].length;
    }
  }
  for (;;) {
    const c = s[pos];
    if (c === '.' || c === '#') {
      const m = IDENT.exec(s.slice(pos + 1));
      if (!m) throw new Unsupported('name');
      tests.push(c === '.' ? classTest(m[0]) : equalsTest('id', m[0], false));
      pos += 1 + m[0].length;
    } else if (c === '[') {
      const m = /^\[\s*([_a-zA-Z][-_a-zA-Z0-9]*)\s*(?:=\s*(?:"([^"\\]*)"|'([^'\\]*)'|(-?[_a-zA-Z][_a-zA-Z0-9-]*))\s*)?\]/.exec(rest());
      if (!m || !ATTR_NAME.test(m[1])) throw new Unsupported('attribute');
      const name = m[1].toLowerCase();
      const value = m[2] ?? m[3] ?? m[4];
      tests.push(value === undefined ? existsTest(name) : equalsTest(name, value, CASE_INSENSITIVE_ATTRS.has(name)));
      pos += m[0].length;
    } else if (c === ':') {
      const [test, next] = parsePseudo(s, pos);
      tests.push(test);
      pos = next;
    } else {
      break;
    }
  }
  if (pos === start) throw new Unsupported('empty compound');
  return [{ tests }, pos];
}

function parsePseudo(s: string, start: number): [Test, number] {
  const m = /^:([a-z-]+)(?:\(([^()]*)\))?/i.exec(s.slice(start));
  if (!m) throw new Unsupported('pseudo');
  const name = m[1].toLowerCase();
  const arg = m[2];
  const end = start + m[0].length;
  if (arg === undefined) {
    switch (name) {
      case 'first-child':
        return [(el, q) => positionOf(el, q).index === 0, end];
      case 'last-child':
        return [(el, q) => positionOf(el, q).fromEnd === 0, end];
      case 'only-child':
        return [(el, q) => positionOf(el, q).index === 0 && positionOf(el, q).fromEnd === 0, end];
      case 'first-of-type':
        return [(el, q) => positionOf(el, q).typeIndex === 0, end];
      case 'last-of-type':
        return [(el, q) => positionOf(el, q).typeFromEnd === 0, end];
      case 'only-of-type':
        return [(el, q) => positionOf(el, q).typeIndex === 0 && positionOf(el, q).typeFromEnd === 0, end];
      default:
        throw new Unsupported(name);
    }
  }
  const nth = nthTest(arg);
  switch (name) {
    case 'nth-child':
      return [(el, q) => nth(positionOf(el, q).index), end];
    case 'nth-last-child':
      return [(el, q) => nth(positionOf(el, q).fromEnd), end];
    case 'nth-of-type':
      return [(el, q) => nth(positionOf(el, q).typeIndex), end];
    case 'nth-last-of-type':
      return [(el, q) => nth(positionOf(el, q).typeFromEnd), end];
    default:
      throw new Unsupported(name);
  }
}

/** an+b check on a 0-based position (as nth-check does). */
function nthTest(arg: string): (index: number) => boolean {
  const m = NTH.exec(arg);
  if (!m) throw new Unsupported('nth');
  let a: number;
  let b: number;
  if (m[1]) [a, b] = [2, 1];
  else if (m[2]) [a, b] = [2, 0];
  else if (m[6] !== undefined) [a, b] = [0, Number(m[6])];
  else {
    const coef = m[3];
    a = coef === '' || coef === '+' ? 1 : coef === '-' ? -1 : Number(coef);
    b = m[5] === undefined ? 0 : (m[4] === '-' ? -1 : 1) * Number(m[5]);
  }
  return (index) => {
    const pos = index + 1;
    if (a === 0) return pos === b;
    const n = (pos - b) / a;
    return Number.isInteger(n) && n >= 0;
  };
}

/**
 * Positions among element siblings (0-based, from the start and the end, all
 * tags and same tag). Computed for all children of a parent at once and kept
 * for the query, so :nth-child on a list with 100,000 items stays linear.
 */
function positionOf(el: DomElement, q: QueryState): Positions {
  const parent = el.parent ?? el;
  let table = q.positions.get(parent);
  if (!table) {
    table = new Map();
    const siblings = el.parent ? ((el.parent as DomNode & { children?: DomNode[] }).children ?? [el]) : [el];
    const elements = siblings.filter(isElement);
    const typeCount = new Map<string, number>();
    for (const e of elements) typeCount.set(e.name, (typeCount.get(e.name) ?? 0) + 1);
    const typeSeen = new Map<string, number>();
    elements.forEach((e, i) => {
      const t = typeSeen.get(e.name) ?? 0;
      typeSeen.set(e.name, t + 1);
      (table as Map<DomElement, Positions>).set(e, {
        index: i,
        fromEnd: elements.length - 1 - i,
        typeIndex: t,
        typeFromEnd: (typeCount.get(e.name) as number) - 1 - t,
      });
    });
    q.positions.set(parent, table);
  }
  return table.get(el) as Positions;
}

function ownAttr(el: DomElement, name: string): string | undefined {
  const attribs = el.attribs;
  return Object.prototype.hasOwnProperty.call(attribs, name) ? attribs[name] : undefined;
}

function classTest(token: string): Test {
  return (el) => {
    const cls = ownAttr(el, 'class');
    return cls !== undefined && cls.length >= token.length && cls.split(/\s+/).includes(token);
  };
}

function existsTest(name: string): Test {
  return (el) => ownAttr(el, name) != null;
}

function equalsTest(name: string, value: string, ignoreCase: boolean): Test {
  if (!ignoreCase) return (el) => ownAttr(el, name) === value;
  const lower = value.toLowerCase();
  return (el) => {
    const v = ownAttr(el, name);
    return v !== undefined && v.length === lower.length && v.toLowerCase() === lower;
  };
}

function matchesCompound(compound: Compound, el: DomElement, q: QueryState): boolean {
  for (const t of compound.tests) if (!t(el, q)) return false;
  return true;
}

interface MatchContext extends QueryState {
  compounds: Compound[];
  combinators: Array<' ' | '>'>;
  leadingChild: boolean;
  scope: DomNode;
  /**
   * Per compound: does this element or one of its ancestors (up to the scope)
   * match it? Memoized so a descendant combinator costs O(1) amortized per
   * element instead of a walk over all ancestors (and "div div div div p" on
   * a deep tree is not exponential).
   */
  memo: Array<Map<DomNode, boolean>> | undefined;
}

function matchAt(ctx: MatchContext, i: number, el: DomElement): boolean {
  // Invariant: `el` is the scope or inside it (callers walk the scope's subtree).
  if (!matchesCompound(ctx.compounds[i], el, ctx)) return false;
  if (i === 0) return !ctx.leadingChild || el.parent === ctx.scope;
  // Compounds left of this one would have to match outside the scope.
  if (el === ctx.scope) return false;
  if (ctx.combinators[i - 1] === '>') {
    const parent = el.parent;
    return isElement(parent) && matchAt(ctx, i - 1, parent);
  }
  return selfOrAncestorMatches(ctx, i - 1, el.parent);
}

/** Does `start` or an ancestor of it, up to and including the scope, match compound `j`? Iterative. */
function selfOrAncestorMatches(ctx: MatchContext, j: number, start: DomNode | null): boolean {
  ctx.memo ??= ctx.compounds.map(() => new Map<DomNode, boolean>());
  const memo = ctx.memo[j];
  const chain: DomElement[] = [];
  let above = false;
  for (let n = start; ; n = n.parent) {
    if (!isElement(n)) break;
    const known = memo.get(n);
    if (known !== undefined) {
      above = known;
      break;
    }
    chain.push(n);
    // Nothing above the scope can take part in a match.
    if (n === ctx.scope) break;
  }
  for (let c = chain.length - 1; c >= 0; c--) {
    above = above || matchAt(ctx, j, chain[c]);
    memo.set(chain[c], above);
  }
  return above;
}
