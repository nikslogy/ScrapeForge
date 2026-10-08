// Conservative static check for regular expressions supplied by customers.
//
// Customer schemas may carry "pattern" / "patternProperties" keywords, and Ajv
// runs them with the native (backtracking) RegExp engine, in unicode mode and
// without the i/m flags, against values that come from pages. A tenant
// controls both the schema and the page, and native RegExp cannot be
// interrupted, so one catastrophic pattern would stall a shared worker
// thread. There is no RE2 in the dependency set, so patterns are screened
// statically before compilation (and validate/ajv.ts refuses to run patterns
// on strings longer than 2,000 chars).
//
// The check follows the recipe screen (recipe/safe-regex.ts) and adds the
// cases ordinary schema patterns need. A quantifier is "delimited" when its
// atom cannot match anything that may be consumed next (its FOLLOW set, with
// zero-width assertions skipped: they cost O(1) per position): [^,]* then
// ",", \d+ then "." or the end. Otherwise it is ambiguous: when it is
// unbounded, every shorter length is a stopping point the rest of the pattern
// is tried from. A pattern is unsafe when
//   1. a group repeated more than once contains an undelimited variable-count
//      quantifier or a variable-count group ("star height" > 1): (a+)+,
//      (a*)*, (\w+\s?)*, (.*,){11}
//   2. a group repeated more than once contains an alternation whose branches
//      may start with the same character, with a class, or match empty:
//      (a|a)*, (a|ab)+, (\w|\d)+
//   3. a long quantifier (unbounded, or more than 16 repeats) or a long
//      repeated group runs from the stopping points of an earlier ambiguous
//      unbounded quantifier, i.e. it can consume characters of that
//      quantifier's run: each of the O(n) stopping points rescans O(n)
//      characters. \s*(.+)$, a*.*$, [a-z]*\w+, .*x.*y are cubic once every
//      start position is tried. A mandatory term that cannot match the run
//      ends it (\d+(\.\d+)?: the inner \d+ only runs after the "."); so does
//      a repeated group whose every iteration needs a character the later
//      quantifier cannot consume (([^,]*,)*[^,]*: rescans stop at the next
//      ","). One exception keeps common format patterns usable: a pattern
//      anchored with ^ is tried from one position only, so a single rescan
//      that is separated from the ambiguous quantifier by a mandatory
//      character (^[^@\s]+@[^@\s]+\.[^@\s]+$: the host part only rescans at
//      a ".") is quadratic and allowed. Adjacent redundant quantifiers
//      (^\s*(.+)$, ^[a-z]*\w+$) never are.
//   4. undelimited short quantifiers and ambiguous alternations multiply to
//      too many ways through, times the characters every ambiguous stopping
//      point consumes before the path is cut, relative to the input-size
//      exponent (0 to 2) the rest of the analysis established: a?a?a?…aaa,
//      (a|a)(a|a)…, \d{0,9}\d{0,9}…x, and unanchored (.*) reviews or
//      \S*\S\S\Sx, where each of the O(n²) stopping points pays for the
//      literal after it.
//   5. a lookaround contains a variable quantifier, a backreference or more
//      than 16 characters (it runs at every position it is reached from);
//      a backreference is quantified, sits in a repeated group, or runs from
//      an ambiguous stopping point; a counted repeat exceeds 1,000 or nested
//      counts multiply past 10,000.
// Accepted patterns are at most quadratic in the input length; with the
// 2,000-char input cap that stays in the low milliseconds (see the timing
// tests in test/schema/safe-regex.test.ts).

export const MAX_PATTERN_LENGTH = 256;

export type RegexSafety = { ok: true } | { ok: false; reason: string };

/** Largest {n,m} bound accepted (V8 unrolls counted repeats of groups). */
const MAX_QUANTIFIER_BOUND = 1_000;
/** Product of nested fixed repeat counts ((?:(?:a{10}){10}){10}). */
const MAX_REPEAT_PRODUCT = 10_000;
/** Repeats above this count are treated like an unbounded quantifier (a scan). */
const LONG_REPEAT = 16;
/**
 * Ways through the pattern × (1 + characters consumed per ambiguous stopping
 * point), allowed for a worst-case input-size exponent of 0, 1 and 2 (an
 * anchored pattern without scans; a scan or an unanchored pattern; both, or
 * one rescan). Exponent 2 alone costs ~25 ms on a hostile 2,000-char
 * two-byte string, so it leaves almost no room.
 */
const MAX_CHOICES_BY_EXPONENT = [10_000, 16, 2];
const MAX_GROUP_DEPTH = 32;

/**
 * True when `pattern` compiles as a unicode RegExp (Ajv's mode), is at most
 * `maxLength` chars long, and shows none of the backtracking shapes above.
 */
export function isSafeRegex(pattern: string, maxLength = MAX_PATTERN_LENGTH): boolean {
  return checkRegexSafety(pattern, maxLength).ok;
}

/** Like isSafeRegex, with the reason a pattern is refused. */
export function checkRegexSafety(pattern: string, maxLength = MAX_PATTERN_LENGTH): RegexSafety {
  if (typeof pattern !== 'string') return { ok: false, reason: 'pattern must be a string' };
  if (pattern.length > maxLength) return { ok: false, reason: `pattern is longer than ${maxLength} chars` };
  try {
    new RegExp(pattern, 'u');
  } catch {
    return { ok: false, reason: 'pattern does not compile in unicode mode' };
  }
  overlapWork = MAX_OVERLAP_WORK;
  try {
    const tree = new Parser(pattern).parse();
    const stats: Stats = {
      choices: 1,
      stopWork: 0,
      scans: false,
      rescans: 0,
      anchored: tree.every((alt) => alt.length > 0 && alt[0].atom.kind === 'assert' && alt[0].atom.start),
    };
    walk(tree, END, { insideRepeat: false, repeatProduct: 1 }, [], stats);
    const exponent = (stats.anchored ? 0 : 1) + (stats.scans ? 1 + stats.rescans : 0);
    if (exponent > 2) throw new UnsafePattern('rescanning quantifier in an unanchored pattern (polynomial backtracking)');
    // Every way through costs the per-stop work again at every stopping point.
    if (stats.choices * (1 + stats.stopWork) > MAX_CHOICES_BY_EXPONENT[exponent]) {
      throw new UnsafePattern('too many ambiguous ways to match (backtracking)');
    }
    return { ok: true };
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

type Atom =
  | Matcher
  /** Zero-width: ^ $ \b \B. `start` marks "^". */
  | { kind: 'assert'; start: boolean }
  | { kind: 'backref' }
  | { kind: 'group'; body: Alternative[]; look: boolean };

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
        return { kind: 'assert', start: ch === '^' };
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
      return { kind: 'assert', start: false };
    }
    if (ch === 'k') {
      const close = this.src.indexOf('>', this.pos);
      if (this.src[this.pos + 1] !== '<' || close < 0) throw new UnsupportedSyntax('bad backreference');
      this.pos = close + 1;
      return { kind: 'backref' };
    }
    if (ch >= '1' && ch <= '9') {
      while (this.src[this.pos] >= '0' && this.src[this.pos] <= '9') this.pos++;
      return { kind: 'backref' };
    }
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

/** What may be consumed next. `any` absorbs everything (backreferences). */
interface First {
  items: Matcher[];
  any: boolean;
  /** The sequence can match the empty string. */
  nullable: boolean;
}

const END: First = { items: [], any: false, nullable: true };

/**
 * An ambiguous unbounded quantifier whose stopping points are still "live":
 * positions inside its run, from where the rest of the pattern is retried.
 */
interface Pending {
  id: number;
  /** Characters that can occur inside the run. */
  run: Matcher[];
  runAny: boolean;
  /** Repeated groups: the mandatory characters of each alternative of one iteration. */
  segments?: Matcher[][];
  /** No mandatory character has been consumed since the quantifier. */
  adjacent: boolean;
  /** Characters a path consumes from one stopping point before it is cut. */
  work: number;
}

interface Stats {
  /** Product of undelimited short choices and ambiguous alternations. */
  choices: number;
  /** Most characters consumed from one ambiguous stopping point (rescans aside). */
  stopWork: number;
  /** A scan (unbounded or long quantifier, backreference) runs somewhere. */
  scans: boolean;
  /** Long quantifiers run from ambiguous stopping points (allowed once, anchored, separated). */
  rescans: number;
  anchored: boolean;
}

interface Ctx {
  /** Below a group repeated more than once. */
  insideRepeat: boolean;
  /** Product of enclosing repeat counts. */
  repeatProduct: number;
}

let pendingIds = 0;

/**
 * Walks one disjunction in pattern order with the pending stopping points
 * that reach it; returns the pending points live after it.
 */
function walk(alternatives: Alternative[], follow: First, ctx: Ctx, pending: Pending[], stats: Stats): Pending[] {
  if (alternatives.length > 1 && alternativesOverlap(alternatives)) {
    if (ctx.insideRepeat) throw new UnsafePattern('ambiguous alternation inside a repeated group');
    multiply(stats, alternatives.length);
  }
  const out: Pending[] = [];
  for (const alternative of alternatives) {
    let live = pending;
    for (let i = 0; i < alternative.length; i++) {
      const term = alternative[i];
      const atom = term.atom;
      if (atom.kind === 'assert') continue;
      checkRepeatProduct(term, ctx.repeatProduct);
      const termFollow = firstOfSequence(alternative, i + 1, follow);
      if (atom.kind === 'backref') {
        if (term.min !== term.max) throw new UnsafePattern('quantified backreference');
        if (ctx.insideRepeat) throw new UnsafePattern('backreference inside a repeated group');
        if (live.length > 0) throw new UnsafePattern('backreference after an ambiguous quantifier');
        stats.scans = true;
        continue;
      }
      if (atom.kind === 'group' && atom.look) {
        if (term.min !== 1 || term.max !== 1) throw new UnsafePattern('quantified lookaround');
        if (containsVariableOrBackref(atom.body)) throw new UnsafePattern('quantifier or backreference inside a lookaround');
        if (maxLength(atom.body) > LONG_REPEAT) throw new UnsafePattern('lookaround longer than 16 characters');
        // Fixed and short: O(1) wherever it is reached; zero-width for the rest.
        walk(atom.body, END, { insideRepeat: false, repeatProduct: ctx.repeatProduct }, [], stats);
        continue;
      }
      live = atom.kind === 'group' ? walkGroup(term, atom.body, termFollow, ctx, live, stats) : walkMatcher(term, atom, termFollow, ctx, live, stats);
    }
    out.push(...live);
  }
  return dedupe(out);
}

function walkMatcher(term: Term, atom: Matcher, follow: First, ctx: Ctx, live: Pending[], stats: Stats): Pending[] {
  const long = term.max > LONG_REPEAT;
  const fed = live.filter((p) => runOverlaps(p, [atom], false));
  if (long) rescan(fed.filter((p) => !segmentedAgainst(p, [atom], false)), stats);
  // A mandatory term that cannot match the run ends it; one that can separates
  // (and costs its characters at every stopping point; a rescan is counted in
  // the exponent instead).
  let next = live.flatMap((p): Pending[] => {
    if (!fed.includes(p)) return term.min >= 1 ? [] : [p];
    return [consume(p, long ? 0 : term.max, term.min >= 1, stats)];
  });
  if (long) stats.scans = true;
  if (term.min !== term.max && !delimited(atom, follow)) {
    if (ctx.insideRepeat) throw new UnsafePattern('nested quantifier (a repeated group contains an ambiguous quantifier)');
    if (long) next = [...next, { id: ++pendingIds, run: [atom], runAny: false, adjacent: true, work: 0 }];
    else multiply(stats, term.max - term.min + 1);
  }
  return next;
}

function walkGroup(term: Term, body: Alternative[], follow: First, ctx: Ctx, live: Pending[], stats: Stats): Pending[] {
  const repeats = term.max > 1;
  const product = repeats ? ctx.repeatProduct * repeatCount(term) : ctx.repeatProduct;
  const first = firstOfDisjunction(body);
  const run = matchersOf(body);
  const bodyLength = maxLength(body);
  const long = term.max === Infinity || bodyLength === Infinity || term.max * bodyLength > LONG_REPEAT;

  // Stopping points whose run can start an iteration walk into the body; the
  // others can only skip the group (or match it empty).
  const fed = live.filter((p) => first.any || runOverlaps(p, first.items, false));
  const blocked = live.filter((p) => !fed.includes(p));
  // The end of a repeated body is followed by the next iteration.
  const bodyFollow = repeats ? union(follow, first) : follow;
  let through = walk(body, bodyFollow, { insideRepeat: ctx.insideRepeat || repeats, repeatProduct: product }, fed, stats);
  if (repeats && long) {
    // A whole iteration fits inside an ambiguous run: the loop rescans it.
    const survivors = fed.filter((p) => through.some((q) => q.id === p.id));
    rescan(survivors.filter((p) => !segmentedAgainst(p, run.items, run.any)), stats);
  } else if (repeats) {
    // Up to term.max iterations consume from the same stopping point.
    through = through.map((q) => {
      const before = fed.find((p) => p.id === q.id);
      return before ? consume(q, (q.work - before.work) * (term.max - 1), false, stats) : q;
    });
  }
  if (long) stats.scans = true;

  let next = through;
  if (term.min === 0 || first.nullable) next = [...next, ...blocked];
  if (term.min === 0) next = [...next, ...fed];
  if (term.min !== term.max) {
    if (ctx.insideRepeat) throw new UnsafePattern('nested quantifier (a repeated group contains a variable group)');
    if (!groupDelimited(first, follow)) {
      if (long) {
        next = [...next, { id: ++pendingIds, run: run.items, runAny: run.any, segments: body.map(mandatoryMatchers), adjacent: true, work: 0 }];
      } else {
        multiply(stats, term.max - term.min + 1);
      }
    }
  }
  return dedupe(next);
}

/** Long quantifiers reached from live ambiguous stopping points. */
function rescan(pending: Pending[], stats: Stats): void {
  if (pending.length === 0) return;
  if (pending.some((p) => p.adjacent)) {
    throw new UnsafePattern('unbounded quantifier right after an ambiguous one that can match the same characters (polynomial backtracking)');
  }
  if (!stats.anchored) throw new UnsafePattern('unbounded quantifier after an ambiguous one in an unanchored pattern (polynomial backtracking)');
  if (stats.rescans >= 1) throw new UnsafePattern('more than one unbounded quantifier after ambiguous ones (polynomial backtracking)');
  stats.rescans = 1;
}

function consume(p: Pending, chars: number, separates: boolean, stats: Stats): Pending {
  const work = p.work + chars;
  stats.stopWork = Math.max(stats.stopWork, work);
  return { ...p, work, adjacent: separates ? false : p.adjacent };
}

function multiply(stats: Stats, factor: number): void {
  stats.choices = Math.min(stats.choices * factor, Number.MAX_SAFE_INTEGER);
}

function repeatCount(term: Term): number {
  return term.max === Infinity ? Math.max(term.min, 1) : term.max;
}

function checkRepeatProduct(term: Term, repeatProduct: number): void {
  if (term.max > 1 && repeatProduct * repeatCount(term) > MAX_REPEAT_PRODUCT) {
    throw new UnsafePattern('nested repetition counts are too large');
  }
}

function dedupe(pending: Pending[]): Pending[] {
  if (pending.length < 2) return pending;
  const seen = new Set<string>();
  const out: Pending[] = [];
  for (const p of pending) {
    const key = `${p.id}:${p.adjacent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function containsVariableOrBackref(alternatives: Alternative[]): boolean {
  return alternatives.some((alt) =>
    alt.some((t) => t.min !== t.max || t.atom.kind === 'backref' || (t.atom.kind === 'group' && containsVariableOrBackref(t.atom.body))),
  );
}

/** Most characters one match of the disjunction can consume (Infinity when unbounded). */
function maxLength(alternatives: Alternative[]): number {
  let best = 0;
  for (const alt of alternatives) {
    let sum = 0;
    for (const t of alt) {
      const atom = t.atom;
      if (atom.kind === 'assert' || (atom.kind === 'group' && atom.look) || t.max === 0) continue;
      if (atom.kind === 'backref' || t.max === Infinity) return Infinity;
      sum += t.max * (atom.kind === 'group' ? maxLength(atom.body) : 1);
      if (sum === Infinity) return Infinity;
    }
    best = Math.max(best, sum);
  }
  return best;
}

/** Every character matcher a disjunction can consume with (lookarounds excluded). */
function matchersOf(alternatives: Alternative[], acc: { items: Matcher[]; any: boolean } = { items: [], any: false }): { items: Matcher[]; any: boolean } {
  for (const alt of alternatives) {
    for (const t of alt) {
      const atom = t.atom;
      if (atom.kind === 'assert' || t.max === 0) continue;
      if (atom.kind === 'backref') acc.any = true;
      else if (atom.kind === 'group') {
        if (!atom.look) matchersOf(atom.body, acc);
      } else acc.items.push(atom);
    }
  }
  return acc;
}

/** Characters one alternative must consume (single-alternative groups included). */
function mandatoryMatchers(alt: Alternative): Matcher[] {
  const out: Matcher[] = [];
  for (const t of alt) {
    if (t.min < 1) continue;
    const atom = t.atom;
    if (atom.kind === 'group') {
      if (!atom.look && atom.body.length === 1) out.push(...mandatoryMatchers(atom.body[0]));
    } else if (atom.kind !== 'assert' && atom.kind !== 'backref') {
      out.push(atom);
    }
  }
  return out;
}

function runOverlaps(p: Pending, matchers: readonly Matcher[], any: boolean): boolean {
  if (p.runAny || any) return true;
  return matchers.some((m) => p.run.some((r) => overlaps(m, r)));
}

/**
 * A repeated group whose every iteration needs a character the later scan
 * cannot consume: rescans from its stopping points stop at the next
 * iteration boundary, so together they cover the input about once.
 */
function segmentedAgainst(p: Pending, scan: readonly Matcher[], scanAny: boolean): boolean {
  if (!p.segments || scanAny) return false;
  return p.segments.every((mandatory) => mandatory.some((m) => scan.every((s) => !overlaps(m, s))));
}

function firstOfSequence(terms: Alternative, from: number, follow: First): First {
  const out: First = { items: [], any: false, nullable: true };
  for (let i = from; i < terms.length; i++) {
    const term = terms[i];
    const atom = term.atom;
    // Zero-width tests are O(1) here (lookarounds are fixed and short): what
    // matters is what is consumed after them.
    if (atom.kind === 'assert' || (atom.kind === 'group' && atom.look) || term.max === 0) continue;
    if (atom.kind === 'backref') {
      // Matches whatever the group captured (possibly nothing).
      out.any = true;
      continue;
    }
    if (atom.kind === 'group') {
      const inner = firstOfDisjunction(atom.body);
      out.items.push(...inner.items);
      if (inner.any) out.any = true;
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
  if (follow.any) out.any = true;
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

/** True when nothing that may be consumed next can be matched by `atom` (unique stopping point). */
function delimited(atom: Matcher, follow: First): boolean {
  if (follow.any) return false;
  return follow.items.every((item) => !overlaps(atom, item));
}

function groupDelimited(first: First, follow: First): boolean {
  if (first.any || first.nullable) return false;
  return first.items.every((item) => delimited(item, follow));
}

/**
 * Branches that may start with the same character, with a class, or match
 * empty. Deliberately coarser than `overlaps`: an alternation of classes
 * inside a loop is rejected even when the classes are disjoint (write one
 * class instead).
 */
function alternativesOverlap(alternatives: Alternative[]): boolean {
  const seen = new Set<number>();
  for (const alternative of alternatives) {
    const first = firstOfSequence(alternative, 0, END);
    if (first.any || first.nullable) return true;
    for (const item of first.items) {
      if (item.kind !== 'char' || seen.has(item.cp)) return true;
      seen.add(item.cp);
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// Character-set overlap (same rules as recipe/safe-regex.ts)
// ─────────────────────────────────────────────────────────────

const LINE_TERMINATORS = new Set([0x0a, 0x0d, 0x2028, 0x2029]);

function overlaps(a: Matcher, b: Matcher): boolean {
  if (a.kind === 'dot' || b.kind === 'dot') {
    const other = a.kind === 'dot' ? b : a;
    if (other.kind === 'char') return !LINE_TERMINATORS.has(other.cp);
    if (other.kind === 'set' && !other.negated) return !other.items.every((item) => item.kind === 'char' && LINE_TERMINATORS.has(item.cp));
    return true;
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
