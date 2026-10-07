// Conservative catastrophic-backtracking screen for recipe regexes.
//
// Recipe regexes are written by a model (or derived from page text), and the
// interpreter runs them with V8's backtracking engine, which cannot be
// interrupted. A regex is therefore accepted only when its worst case is at
// most quadratic in the (capped) input length. The rules, applied to a parsed
// pattern compiled in unicode mode:
//
//   1. No backreferences (they defeat any static bound).
//   2. Inside a group repeated more than once, nothing may vary in length:
//      no variable quantifier and no alternation ((a+)+, (a|ab)*, (\w+\s)*).
//      This rules out exponential blow-up outright.
//   3. Outside repeated groups, a variable quantifier is "delimited" when its
//      atom cannot match anything that may come next (its FOLLOW set), so it
//      has exactly one place to stop: [^,]* then ",", \d+ then "x". An
//      assertion ($, \b, lookaround) in the FOLLOW set counts as "anything":
//      a failing assertion makes the quantifier retry every shorter length.
//      An undelimited unbounded quantifier hands O(n) stopping points to the
//      rest of the pattern, so it may be the only one, and no unbounded
//      quantifier (delimited or not) may come after it: each would rescan
//      O(n) chars per stopping point. ".*x.*y", "a*a*b" and "\s*(.+)$" are
//      all cubic once every start position is tried; "(.*) reviews" and
//      "Price:\s*(\d+)" stay quadratic.
//   4. Undelimited bounded quantifiers and alternations whose branches may
//      start alike multiply the ways through the pattern; the product is
//      capped (lower when an undelimited unbounded quantifier is present).
//   5. Lookarounds may not contain variable quantifiers or be quantified.
//
// Character-set overlap is decided soundly: single characters are tested
// with the engine itself, ranges by interval, and class escapes (\d, \s,
// \p{L}, ...) by the Unicode general-category families they can contain.
// Anything the analysis cannot decide counts as overlapping.

import { RECIPE_LIMITS } from './limits.js';

export type RegexCheck = { ok: true; captureGroups: number } | { ok: false; reason: string };

/** Largest {n,m} bound accepted (V8 unrolls counted repeats). */
const MAX_QUANTIFIER_BOUND = 1_000;
/** Product of nested fixed repeat counts ((?:(?:a{10}){10}){10}). */
const MAX_REPEAT_PRODUCT = 10_000;
/**
 * Ways through the pattern without / with one undelimited unbounded
 * quantifier. Every way can cost a scan of the input from each start
 * position, so these stay small: 16 × the quadratic floor is ~1.5 s on a
 * hostile 10,000-char input, the worst this module lets through.
 */
const MAX_CHOICES = [16, 4];
const MAX_GROUP_DEPTH = 32;

export function isSafeRegex(pattern: string): boolean {
  return checkRegex(pattern).ok;
}

/** Validates a recipe regex: length, unicode-mode syntax and the backtracking rules above. */
export function checkRegex(pattern: string): RegexCheck {
  if (typeof pattern !== 'string' || pattern.length === 0) return { ok: false, reason: 'pattern must be a non-empty string' };
  if (pattern.length > RECIPE_LIMITS.maxRegexChars) {
    return { ok: false, reason: `pattern is longer than ${RECIPE_LIMITS.maxRegexChars} chars` };
  }
  let captureGroups: number;
  try {
    // An empty alternative always matches, so exec('') reports every group.
    captureGroups = (new RegExp(`${pattern}|`, 'u').exec('') as RegExpExecArray).length - 1;
  } catch (err) {
    return { ok: false, reason: `pattern does not compile in unicode mode: ${(err as Error).message}` };
  }
  overlapWork = MAX_OVERLAP_WORK;
  try {
    const tree = new Parser(pattern).parse();
    const stats: Stats = { choices: 1 };
    const ambiguous = analyze(tree, END, false, stats, 1, 0);
    if (stats.choices > MAX_CHOICES[ambiguous]) return { ok: false, reason: 'too many ambiguous ways to match (backtracking)' };
    return { ok: true, captureGroups };
  } catch (err) {
    if (err instanceof UnsafePattern) return { ok: false, reason: err.message };
    // The parser is stricter than V8 in a few corners; unknown means unsafe.
    return { ok: false, reason: 'pattern uses syntax the safety check does not support' };
  }
}

// ─────────────────────────────────────────────────────────────
// Parser (unicode-mode ECMAScript pattern grammar, enough for analysis)
// ─────────────────────────────────────────────────────────────

type ClassItem =
  | { kind: 'char'; cp: number }
  | { kind: 'range'; from: number; to: number }
  /** Class escape: d D s S w W p{..} P{..} */
  | { kind: 'escape'; name: string };

type Matcher = { kind: 'char'; cp: number } | { kind: 'set'; items: ClassItem[]; negated: boolean } | { kind: 'dot' };

type Atom = Matcher | { kind: 'assert' } | { kind: 'group'; body: Alternative[]; look: boolean };

interface Term {
  atom: Atom;
  min: number;
  max: number;
}

type Alternative = Term[];

class UnsafePattern extends Error {}
class UnsupportedSyntax extends Error {}

const CONTROL_ESCAPES: Record<string, number> = { t: 9, n: 10, v: 11, f: 12, r: 13 };

class Parser {
  private pos = 0;

  constructor(private readonly src: string) {}

  parse(): Alternative[] {
    const body = this.disjunction(0);
    if (this.pos < this.src.length) throw new UnsupportedSyntax('unbalanced )');
    return body;
  }

  private disjunction(depth: number): Alternative[] {
    if (depth > MAX_GROUP_DEPTH) throw new UnsafePattern('groups are nested too deeply');
    const alternatives: Alternative[] = [this.alternative(depth)];
    while (this.src[this.pos] === '|') {
      this.pos++;
      alternatives.push(this.alternative(depth));
    }
    return alternatives;
  }

  private alternative(depth: number): Alternative {
    const terms: Term[] = [];
    while (this.pos < this.src.length && this.src[this.pos] !== '|' && this.src[this.pos] !== ')') {
      const atom = this.atom(depth);
      const [min, max] = this.quantifier();
      terms.push({ atom, min, max });
    }
    return terms;
  }

  private atom(depth: number): Atom {
    const ch = this.src[this.pos];
    switch (ch) {
      case '^':
      case '$':
        this.pos++;
        return { kind: 'assert' };
      case '.':
        this.pos++;
        return { kind: 'dot' };
      case '[':
        this.pos++;
        return this.characterClass();
      case '(':
        this.pos++;
        return this.group(depth);
      case '\\':
        this.pos++;
        return this.atomEscape();
      default:
        return { kind: 'char', cp: this.literal() };
    }
  }

  private literal(): number {
    const cp = this.src.codePointAt(this.pos) as number;
    this.pos += cp > 0xffff ? 2 : 1;
    return cp;
  }

  private group(depth: number): Atom {
    let look = false;
    if (this.src.startsWith('?:', this.pos)) {
      this.pos += 2;
    } else if (this.src.startsWith('?=', this.pos) || this.src.startsWith('?!', this.pos)) {
      this.pos += 2;
      look = true;
    } else if (this.src.startsWith('?<=', this.pos) || this.src.startsWith('?<!', this.pos)) {
      this.pos += 3;
      look = true;
    } else if (this.src.startsWith('?<', this.pos)) {
      const close = this.src.indexOf('>', this.pos);
      if (close < 0) throw new UnsupportedSyntax('bad group name');
      this.pos = close + 1;
    } else if (this.src[this.pos] === '?') {
      throw new UnsupportedSyntax('unsupported group modifier');
    }
    const body = this.disjunction(depth + 1);
    if (this.src[this.pos] !== ')') throw new UnsupportedSyntax('missing )');
    this.pos++;
    return { kind: 'group', body, look };
  }

  private atomEscape(): Atom {
    const ch = this.src[this.pos];
    if (ch === 'b' || ch === 'B') {
      this.pos++;
      return { kind: 'assert' };
    }
    if (ch === 'k' || (ch >= '1' && ch <= '9')) throw new UnsafePattern('backreferences are not allowed');
    const item = this.classEscape();
    if (item.kind === 'escape') return { kind: 'set', items: [item], negated: false };
    return { kind: 'char', cp: (item as { cp: number }).cp };
  }

  /** Escape after "\" valid both outside and inside a class (\b handled by callers). */
  private classEscape(): ClassItem {
    const ch = this.src[this.pos];
    if (ch === undefined) throw new UnsupportedSyntax('trailing \\');
    this.pos++;
    switch (ch) {
      case 'd':
      case 'D':
      case 's':
      case 'S':
      case 'w':
      case 'W':
        return { kind: 'escape', name: ch };
      case 'p':
      case 'P': {
        const close = this.src.indexOf('}', this.pos);
        if (this.src[this.pos] !== '{' || close < 0) throw new UnsupportedSyntax('bad property escape');
        const name = `${ch}{${this.src.slice(this.pos + 1, close)}}`;
        this.pos = close + 1;
        return { kind: 'escape', name };
      }
      case 'x': {
        const hex = this.src.slice(this.pos, this.pos + 2);
        this.pos += 2;
        return { kind: 'char', cp: parseInt(hex, 16) };
      }
      case 'u': {
        if (this.src[this.pos] === '{') {
          const close = this.src.indexOf('}', this.pos);
          if (close < 0) throw new UnsupportedSyntax('missing }');
          const cp = parseInt(this.src.slice(this.pos + 1, close), 16);
          this.pos = close + 1;
          return { kind: 'char', cp };
        }
        const cp = parseInt(this.src.slice(this.pos, this.pos + 4), 16);
        this.pos += 4;
        // A surrogate pair written as two \u escapes is one code point.
        if (cp >= 0xd800 && cp <= 0xdbff && this.src.startsWith('\\u', this.pos)) {
          const low = parseInt(this.src.slice(this.pos + 2, this.pos + 6), 16);
          if (low >= 0xdc00 && low <= 0xdfff) {
            this.pos += 6;
            return { kind: 'char', cp: (cp - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000 };
          }
        }
        return { kind: 'char', cp };
      }
      case 'c':
        return { kind: 'char', cp: this.src.charCodeAt(this.pos++) % 32 };
      case '0':
        return { kind: 'char', cp: 0 };
      default:
        if (CONTROL_ESCAPES[ch] !== undefined) return { kind: 'char', cp: CONTROL_ESCAPES[ch] };
        // Identity escape of a syntax character ("\.", "\(", "\-").
        return { kind: 'char', cp: ch.codePointAt(0) as number };
    }
  }

  private characterClass(): Atom {
    let negated = false;
    if (this.src[this.pos] === '^') {
      negated = true;
      this.pos++;
    }
    const items: ClassItem[] = [];
    while (this.pos < this.src.length && this.src[this.pos] !== ']') {
      const first = this.classAtom();
      if (this.src[this.pos] === '-' && this.src[this.pos + 1] !== ']' && this.pos + 1 < this.src.length) {
        this.pos++;
        const last = this.classAtom();
        if (first.kind !== 'char' || last.kind !== 'char') throw new UnsupportedSyntax('bad range');
        items.push({ kind: 'range', from: first.cp, to: last.cp });
      } else {
        items.push(first);
      }
    }
    if (this.src[this.pos] !== ']') throw new UnsupportedSyntax('missing ]');
    this.pos++;
    return { kind: 'set', items, negated };
  }

  private classAtom(): ClassItem {
    if (this.src[this.pos] !== '\\') return { kind: 'char', cp: this.literal() };
    this.pos++;
    if (this.src[this.pos] === 'b') {
      this.pos++;
      return { kind: 'char', cp: 8 };
    }
    if (this.src[this.pos] === '-') {
      this.pos++;
      return { kind: 'char', cp: 45 };
    }
    return this.classEscape();
  }

  private quantifier(): [number, number] {
    const ch = this.src[this.pos];
    let bounds: [number, number];
    if (ch === '*') bounds = [0, Infinity];
    else if (ch === '+') bounds = [1, Infinity];
    else if (ch === '?') bounds = [0, 1];
    else if (ch === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.pos, this.pos + 24));
      if (!m) throw new UnsupportedSyntax('bad quantifier');
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      if (min > MAX_QUANTIFIER_BOUND || (max !== Infinity && max > MAX_QUANTIFIER_BOUND)) {
        throw new UnsafePattern(`quantifier bounds above ${MAX_QUANTIFIER_BOUND} are not allowed`);
      }
      this.pos += m[0].length - 1;
      bounds = [min, max];
    } else {
      return [1, 1];
    }
    this.pos++;
    if (this.src[this.pos] === '?') this.pos++; // lazy: same backtracking bound
    return bounds;
  }
}

// ─────────────────────────────────────────────────────────────
// Analysis
// ─────────────────────────────────────────────────────────────

/** What may be matched next. `any` absorbs everything (assertions, unknowns). */
interface First {
  items: Matcher[];
  any: boolean;
  /** The sequence can match the empty string. */
  nullable: boolean;
}

const END: First = { items: [], any: false, nullable: true };
const ANYTHING: First = { items: [], any: true, nullable: true };

interface Stats {
  /** Product of undelimited bounded choices and overlapping alternations. */
  choices: number;
}

/**
 * Walks one disjunction in pattern order. `ambiguous` counts undelimited
 * unbounded quantifiers already passed on this path (0 or 1); the return
 * value is that count after the disjunction (max over its branches).
 */
function analyze(
  alternatives: Alternative[],
  follow: First,
  insideRepeat: boolean,
  stats: Stats,
  repeatProduct: number,
  ambiguous: number,
): number {
  if (alternatives.length > 1) {
    if (insideRepeat) throw new UnsafePattern('alternation inside a repeated group');
    if (alternativesOverlap(alternatives)) multiply(stats, alternatives.length);
  }
  let after = ambiguous;
  for (const alternative of alternatives) {
    let seen = ambiguous;
    for (let i = 0; i < alternative.length; i++) {
      const term = alternative[i];
      const atom = term.atom;
      const variable = term.min !== term.max;
      if (atom.kind === 'assert') continue;
      const termFollow = firstOfSequence(alternative, i + 1, follow);
      if (atom.kind === 'group') {
        if (atom.look) {
          if (term.min !== 1 || term.max !== 1) throw new UnsafePattern('quantified lookaround');
          if (containsVariable(atom.body)) throw new UnsafePattern('quantifier inside a lookaround');
          // Still checks nested repetition counts inside the lookaround.
          analyze(atom.body, ANYTHING, insideRepeat, stats, repeatProduct, 0);
          continue;
        }
        const repeats = term.max > 1;
        const product = repeats ? repeatProduct * (term.max === Infinity ? Math.max(term.min, 1) : term.max) : repeatProduct;
        if (product > MAX_REPEAT_PRODUCT) throw new UnsafePattern('nested repetition counts are too large');
        // The end of a repeated body is followed by the next iteration.
        const bodyFollow = repeats ? union(termFollow, firstOfDisjunction(atom.body)) : termFollow;
        seen = analyze(atom.body, bodyFollow, insideRepeat || repeats, stats, product, seen);
        if (!variable) continue;
        if (insideRepeat) throw new UnsafePattern('nested quantifier');
        seen = quantified(term, groupDelimited(atom.body, termFollow), seen, stats);
        continue;
      }
      if (term.max > 1 && repeatProduct * (term.max === Infinity ? Math.max(term.min, 1) : term.max) > MAX_REPEAT_PRODUCT) {
        throw new UnsafePattern('nested repetition counts are too large');
      }
      if (!variable) continue;
      if (insideRepeat) throw new UnsafePattern('nested quantifier');
      seen = quantified(term, delimited(atom, termFollow), seen, stats);
    }
    after = Math.max(after, seen);
  }
  return after;
}

/** Accounts for one variable quantifier; returns the updated ambiguous count. */
function quantified(term: Term, isDelimited: boolean, ambiguous: number, stats: Stats): number {
  if (term.max !== Infinity) {
    if (!isDelimited) multiply(stats, term.max - term.min + 1);
    return ambiguous;
  }
  if (ambiguous > 0) {
    throw new UnsafePattern('unbounded quantifier after an ambiguous unbounded quantifier (polynomial backtracking)');
  }
  return isDelimited ? 0 : 1;
}

function multiply(stats: Stats, factor: number): void {
  stats.choices = Math.min(stats.choices * factor, Number.MAX_SAFE_INTEGER);
}

function containsVariable(alternatives: Alternative[]): boolean {
  return alternatives.some((alt) =>
    alt.some((t) => t.min !== t.max || (t.atom.kind === 'group' && containsVariable(t.atom.body))),
  );
}

function firstOfSequence(terms: Alternative, from: number, follow: First): First {
  const out: First = { items: [], any: false, nullable: true };
  for (let i = from; i < terms.length; i++) {
    const term = terms[i];
    const atom = term.atom;
    if (atom.kind === 'assert' || (atom.kind === 'group' && atom.look)) {
      // A zero-width test that can fail anywhere: nothing after it delimits.
      out.any = true;
      out.nullable = false;
      return out;
    }
    if (atom.kind === 'group') {
      const inner = firstOfDisjunction(atom.body);
      out.items.push(...inner.items);
      if (inner.any) {
        out.any = true;
        out.nullable = false;
        return out;
      }
      if (term.min > 0 && !inner.nullable) {
        out.nullable = false;
        return out;
      }
      continue;
    }
    out.items.push(atom);
    if (term.min > 0) {
      out.nullable = false;
      return out;
    }
  }
  out.items.push(...follow.items);
  out.any = follow.any;
  out.nullable = follow.nullable;
  return out;
}

function firstOfDisjunction(alternatives: Alternative[]): First {
  const out: First = { items: [], any: false, nullable: false };
  for (const alternative of alternatives) {
    const first = firstOfSequence(alternative, 0, END);
    out.items.push(...first.items);
    if (first.any) out.any = true;
    if (first.nullable) out.nullable = true;
  }
  return out;
}

function union(a: First, b: First): First {
  return { items: [...a.items, ...b.items], any: a.any || b.any, nullable: a.nullable || b.nullable };
}

function delimited(atom: Matcher, follow: First): boolean {
  if (follow.any) return false;
  return follow.items.every((item) => !overlaps(atom, item));
}

function groupDelimited(body: Alternative[], follow: First): boolean {
  const first = firstOfDisjunction(body);
  if (first.any || first.nullable) return false;
  return first.items.every((item) => delimited(item, follow));
}

/** Branches that may start with the same character, or match empty. */
function alternativesOverlap(alternatives: Alternative[]): boolean {
  const firsts = alternatives.map((alt) => firstOfSequence(alt, 0, END));
  for (let i = 0; i < firsts.length; i++) {
    if (firsts[i].any || firsts[i].nullable) return true;
    for (let j = i + 1; j < firsts.length; j++) {
      for (const a of firsts[i].items) {
        for (const b of firsts[j].items) if (overlaps(a, b)) return true;
      }
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// Character-set overlap
// ─────────────────────────────────────────────────────────────

const LINE_TERMINATORS = new Set([0x0a, 0x0d, 0x2028, 0x2029]);

function overlaps(a: Matcher, b: Matcher): boolean {
  if (a.kind === 'dot' || b.kind === 'dot') {
    const other = a.kind === 'dot' ? b : a;
    return !(other.kind === 'char' && LINE_TERMINATORS.has(other.cp));
  }
  if (a.kind === 'char' && b.kind === 'char') return a.cp === b.cp;
  if (a.kind === 'char') return setMatches(b as Extract<Matcher, { kind: 'set' }>, a.cp);
  if (b.kind === 'char') return setMatches(a, b.cp);
  if (a.negated || b.negated) return true;
  return a.items.some((x) => b.items.some((y) => itemsOverlap(x, y)));
}

function setMatches(set: Extract<Matcher, { kind: 'set' }>, cp: number): boolean {
  const hit = set.items.some((item) => itemMatches(item, cp));
  return set.negated ? !hit : hit;
}

function itemMatches(item: ClassItem, cp: number): boolean {
  if (item.kind === 'char') return item.cp === cp;
  if (item.kind === 'range') return cp >= item.from && cp <= item.to;
  // Out of budget: assume a match (the conservative answer).
  if (--overlapWork < 0) return true;
  return escapeRegex(item.name).test(String.fromCodePoint(cp));
}

const MAX_RANGE_SCAN = 512;
/**
 * Character tests one check may spend deciding overlaps; past it every pair
 * counts as overlapping (conservative), so a pattern built from many ranges
 * cannot make validation itself slow.
 */
const MAX_OVERLAP_WORK = 20_000;
let overlapWork = MAX_OVERLAP_WORK;

function itemsOverlap(x: ClassItem, y: ClassItem): boolean {
  if (x.kind === 'char') return itemMatches(y, x.cp);
  if (y.kind === 'char') return itemMatches(x, y.cp);
  if (x.kind === 'range' && y.kind === 'range') return x.from <= y.to && y.from <= x.to;
  if (x.kind === 'range' || y.kind === 'range') {
    const range = (x.kind === 'range' ? x : y) as Extract<ClassItem, { kind: 'range' }>;
    const escape = (x.kind === 'escape' ? x : y) as Extract<ClassItem, { kind: 'escape' }>;
    if (range.to - range.from > MAX_RANGE_SCAN) return true;
    for (let cp = range.from; cp <= range.to; cp++) if (itemMatches(escape, cp)) return true;
    return false;
  }
  return !escapesDisjoint(x.name, y.name);
}

// Unicode general-category families each positive escape can match. Two
// escapes whose families do not intersect are disjoint. \s holds Zs/Zl/Zp,
// the C0 controls \t-\r and U+FEFF (Cf); \w is [A-Za-z0-9_] (L, N, Pc).
const FAMILIES: Record<string, readonly string[]> = {
  d: ['N'],
  s: ['Z', 'C'],
  w: ['L', 'N', 'P'],
};
for (const name of ['L', 'Letter', 'Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'Uppercase_Letter', 'Lowercase_Letter']) FAMILIES[`p{${name}}`] = ['L'];
for (const name of ['N', 'Number', 'Nd', 'Nl', 'No', 'Decimal_Number']) FAMILIES[`p{${name}}`] = ['N'];
for (const name of ['P', 'Punctuation', 'Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po']) FAMILIES[`p{${name}}`] = ['P'];
for (const name of ['S', 'Symbol', 'Sc', 'Sm', 'Sk', 'So', 'Currency_Symbol']) FAMILIES[`p{${name}}`] = ['S'];
for (const name of ['Z', 'Separator', 'Zs', 'Space_Separator']) FAMILIES[`p{${name}}`] = ['Z'];

function complement(name: string): string {
  if (name.length === 1) return name === name.toLowerCase() ? name.toUpperCase() : name.toLowerCase();
  return (name[0] === 'p' ? 'P' : 'p') + name.slice(1);
}

function escapesDisjoint(a: string, b: string): boolean {
  if (complement(a) === b) return true;
  const fa = FAMILIES[a];
  const fb = FAMILIES[b];
  if (!fa || !fb) return false;
  return !fa.some((f) => fb.includes(f));
}

const escapeCache = new Map<string, RegExp>();

function escapeRegex(name: string): RegExp {
  let re = escapeCache.get(name);
  if (!re) {
    re = new RegExp(`^\\${name}$`, 'u');
    // Names come from patterns that compiled, so the cache only grows with
    // distinct valid escapes; still keep it bounded.
    if (escapeCache.size > 512) escapeCache.clear();
    escapeCache.set(name, re);
  }
  return re;
}
