// Conservative static check for regular expressions supplied by customers.
//
// Customer schemas may carry "pattern" / "patternProperties" keywords, and Ajv
// runs them with the native (backtracking) RegExp engine against values that
// come from pages. A tenant controls both the schema and the page, and native
// RegExp cannot be interrupted, so one catastrophic pattern would stall a
// shared worker thread. There is no RE2 in the dependency set, so patterns are
// screened statically before compilation (and validate/ajv.ts additionally
// refuses to run patterns on very long strings).
//
// The check is deliberately conservative (a rejected schema gets a clear
// error; a hung worker hurts every tenant). For every quantifier the analysis
// computes what may come right after it (its FOLLOW set; for the last term of
// a repeated group that includes the start of the next iteration). A
// quantifier whose atom can match nothing in its FOLLOW set has exactly one
// place to stop ("delimited": [^,]*, then ","; \d+ then "." or the end) and
// cannot multiply the ways to match. A pattern is unsafe when
//   1. a group repeated more than once contains an undelimited variable-count
//      quantifier ("star height" > 1): (a+)+, (a*)*, (\w+\s?)*, (.*,){11}
//   2. a group repeated more than once contains an alternation whose branches
//      may start with the same character or match empty: (a|a)*, (a|ab)+,
//      (\w|\d)+, ((x|x)y)+
//   3. more than one undelimited unbounded quantifier remains: .*a.*b, a*a*b
//      are polynomial of degree three or more
//   4. undelimited bounded quantifiers and ambiguous alternations multiply to
//      too many ways through: a?a?a?…aaa or (a|a)(a|a)… are exponential in
//      the pattern's length.
// Accepted patterns are at most quadratic in the input; validate/ajv.ts caps
// the input length so that stays in the low milliseconds.

export const MAX_PATTERN_LENGTH = 256;

const MAX_UNDELIMITED_UNBOUNDED = 1;
// Ways through the pattern allowed with zero / one undelimited unbounded
// quantifier (the latter multiplies every way by the input length squared).
const MAX_CHOICES_BY_UNBOUNDED = [10_000, 16];

type Atom =
  | { kind: 'char'; ch: string }
  | { kind: 'class'; source: string }
  | { kind: 'assert' }
  | { kind: 'backref' }
  | { kind: 'group'; body: Alternative[] };

interface Term {
  atom: Atom;
  min: number;
  max: number;
}

type Alternative = Term[];

class PatternSyntaxError extends Error {}

/**
 * True when `pattern` compiles as a unicode RegExp (Ajv's mode), is at most
 * `maxLength` chars long, and shows none of the catastrophic-backtracking
 * shapes listed above.
 */
export function isSafeRegex(pattern: string, maxLength = MAX_PATTERN_LENGTH): boolean {
  if (typeof pattern !== 'string' || pattern.length > maxLength) return false;
  try {
    new RegExp(pattern, 'u');
  } catch {
    return false;
  }
  try {
    const tree = new Parser(pattern).parse();
    const stats: Analysis = { hazard: false, unbounded: 0, choices: 1 };
    analyze(tree, END_OF_PATTERN, false, stats);
    if (stats.hazard || stats.unbounded > MAX_UNDELIMITED_UNBOUNDED) return false;
    return stats.choices <= MAX_CHOICES_BY_UNBOUNDED[stats.unbounded];
  } catch {
    // The parser is stricter than V8 in a few corners; unknown means unsafe.
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Parser (subset of the ECMAScript pattern grammar, enough for analysis)
// ─────────────────────────────────────────────────────────────

const CONTROL_ESCAPES: Record<string, string> = { t: '\t', n: '\n', r: '\r', f: '\f', v: '\v', '0': '\0' };

class Parser {
  private pos = 0;

  constructor(private readonly src: string) {}

  parse(): Alternative[] {
    const body = this.disjunction();
    if (this.pos < this.src.length) throw new PatternSyntaxError('unbalanced )');
    return body;
  }

  private disjunction(): Alternative[] {
    const alternatives: Alternative[] = [this.alternative()];
    while (this.src[this.pos] === '|') {
      this.pos++;
      alternatives.push(this.alternative());
    }
    return alternatives;
  }

  private alternative(): Alternative {
    const terms: Term[] = [];
    while (this.pos < this.src.length && this.src[this.pos] !== '|' && this.src[this.pos] !== ')') {
      const atom = this.atom();
      const [min, max] = this.quantifier();
      terms.push({ atom, min, max });
    }
    return terms;
  }

  private atom(): Atom {
    const start = this.pos;
    const cp = this.src.codePointAt(this.pos) ?? 0;
    const ch = String.fromCodePoint(cp);
    this.pos += ch.length;
    switch (ch) {
      case '^':
      case '$':
        return { kind: 'assert' };
      case '.':
        return { kind: 'class', source: '.' };
      case '[':
        return this.characterClass(start);
      case '(':
        return this.group();
      case '\\':
        return this.escape(start);
      default:
        return { kind: 'char', ch };
    }
  }

  private group(): Atom {
    // Lookarounds consume nothing, but their inner quantifiers still
    // backtrack, so they are analysed like any other group.
    if (this.src.startsWith('?:', this.pos) || this.src.startsWith('?=', this.pos) || this.src.startsWith('?!', this.pos)) {
      this.pos += 2;
    } else if (this.src.startsWith('?<=', this.pos) || this.src.startsWith('?<!', this.pos)) {
      this.pos += 3;
    } else if (this.src.startsWith('?<', this.pos)) {
      const close = this.src.indexOf('>', this.pos);
      if (close < 0) throw new PatternSyntaxError('bad group name');
      this.pos = close + 1;
    }
    const body = this.disjunction();
    if (this.src[this.pos] !== ')') throw new PatternSyntaxError('missing )');
    this.pos++;
    return { kind: 'group', body };
  }

  private characterClass(start: number): Atom {
    if (this.src[this.pos] === '^') this.pos++;
    while (this.pos < this.src.length && this.src[this.pos] !== ']') {
      if (this.src[this.pos] === '\\') {
        const next = this.src[this.pos + 1];
        this.pos += 2;
        if ((next === 'p' || next === 'P' || next === 'u') && this.src[this.pos] === '{') this.skipBraces();
      } else {
        this.pos++;
      }
    }
    if (this.src[this.pos] !== ']') throw new PatternSyntaxError('missing ]');
    this.pos++;
    return { kind: 'class', source: this.src.slice(start, this.pos) };
  }

  private escape(start: number): Atom {
    const ch = this.src[this.pos++];
    if (ch === undefined) throw new PatternSyntaxError('trailing \\');
    switch (ch) {
      case 'b':
      case 'B':
        return { kind: 'assert' };
      case 'd':
      case 'w':
      case 's':
      case 'D':
      case 'W':
      case 'S':
        return { kind: 'class', source: `\\${ch}` };
      case 'p':
      case 'P':
        if (this.src[this.pos] === '{') this.skipBraces();
        return { kind: 'class', source: this.src.slice(start, this.pos) };
      case 'k':
        if (this.src[this.pos] === '<') {
          const close = this.src.indexOf('>', this.pos);
          if (close < 0) throw new PatternSyntaxError('bad backreference');
          this.pos = close + 1;
        }
        return { kind: 'backref' };
      case 'u': {
        let hex: string;
        if (this.src[this.pos] === '{') {
          const close = this.src.indexOf('}', this.pos);
          if (close < 0) throw new PatternSyntaxError('missing }');
          hex = this.src.slice(this.pos + 1, close);
          this.pos = close + 1;
        } else {
          hex = this.src.slice(this.pos, this.pos + 4);
          this.pos += 4;
        }
        return { kind: 'char', ch: String.fromCodePoint(parseInt(hex, 16)) };
      }
      case 'x': {
        const hex = this.src.slice(this.pos, this.pos + 2);
        this.pos += 2;
        return { kind: 'char', ch: String.fromCharCode(parseInt(hex, 16)) };
      }
      case 'c': {
        const letter = this.src.charCodeAt(this.pos++);
        return { kind: 'char', ch: String.fromCharCode(letter % 32) };
      }
      default:
        if (ch >= '1' && ch <= '9') {
          while (/\d/.test(this.src[this.pos] ?? '')) this.pos++;
          return { kind: 'backref' };
        }
        return { kind: 'char', ch: CONTROL_ESCAPES[ch] ?? ch };
    }
  }

  private skipBraces(): void {
    const close = this.src.indexOf('}', this.pos);
    if (close < 0) throw new PatternSyntaxError('missing }');
    this.pos = close + 1;
  }

  private quantifier(): [number, number] {
    const ch = this.src[this.pos];
    let bounds: [number, number];
    if (ch === '*') bounds = [0, Infinity];
    else if (ch === '+') bounds = [1, Infinity];
    else if (ch === '?') bounds = [0, 1];
    else if (ch === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.pos, this.pos + 32));
      if (!m) return [1, 1];
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      this.pos += m[0].length - 1;
      bounds = [min, max];
    } else {
      return [1, 1];
    }
    this.pos++;
    if (this.src[this.pos] === '?') this.pos++; // lazy modifier: same backtracking
    return bounds;
  }
}

// ─────────────────────────────────────────────────────────────
// Analysis
// ─────────────────────────────────────────────────────────────

/** Characters that can come next (coarse: classes are kept by source). */
interface FirstSet {
  chars: Set<string>;
  classes: string[];
  /** Anything may come next (backreference, unknown construct). */
  any: boolean;
  /** The sequence can match the empty string. */
  nullable: boolean;
}

// What follows the whole pattern: nothing to match (success, or "$").
const END_OF_PATTERN: FirstSet = { chars: new Set(), classes: [], any: false, nullable: false };

interface Analysis {
  hazard: boolean;
  /** Undelimited quantifiers without an upper bound outside repeated groups (rule 3). */
  unbounded: number;
  /** Product of undelimited bounded choices and ambiguous alternations (rule 4). */
  choices: number;
}

/**
 * Walks one disjunction. `follow` is what may come after it; `insideRepeat`
 * is true below a group repeated more than once (rules 1 and 2 apply there,
 * rules 3 and 4 elsewhere).
 */
function analyze(alternatives: Alternative[], follow: FirstSet, insideRepeat: boolean, stats: Analysis): void {
  if (alternatives.length > 1 && alternativesOverlap(alternatives)) {
    if (insideRepeat) stats.hazard = true;
    else multiplyChoices(stats, alternatives.length);
  }
  for (const alternative of alternatives) {
    for (let i = 0; i < alternative.length && !stats.hazard; i++) {
      const term = alternative[i];
      const termFollow = firstOfSequence(alternative, i + 1, follow);
      const variable = term.min !== term.max;
      if (term.atom.kind === 'group') {
        const repeats = term.max > 1;
        // The last part of a repeated body is followed by the next iteration.
        const bodyFollow = repeats ? union(termFollow, firstOfDisjunction(term.atom.body)) : termFollow;
        analyze(term.atom.body, bodyFollow, insideRepeat || repeats, stats);
        if (variable && insideRepeat) stats.hazard = true;
        else if (variable) countUndelimited(term, stats);
        continue;
      }
      if (!variable || isDelimited(term.atom, termFollow)) continue;
      if (insideRepeat) stats.hazard = true;
      else countUndelimited(term, stats);
    }
  }
}

function countUndelimited(term: Term, stats: Analysis): void {
  if (term.max === Infinity) stats.unbounded++;
  else multiplyChoices(stats, term.max - term.min + 1);
}

function multiplyChoices(stats: Analysis, factor: number): void {
  // Saturate instead of overflowing to Infinity.
  stats.choices = Math.min(stats.choices * factor, Number.MAX_SAFE_INTEGER);
}

function firstOfSequence(terms: Alternative, from: number, follow: FirstSet): FirstSet {
  const out: FirstSet = { chars: new Set(), classes: [], any: false, nullable: true };
  for (let i = from; i < terms.length; i++) {
    const term = terms[i];
    const atom = term.atom;
    if (atom.kind === 'assert') continue; // zero-width
    let atomNullable = false;
    if (atom.kind === 'char') {
      out.chars.add(atom.ch);
    } else if (atom.kind === 'class') {
      out.classes.push(atom.source);
    } else if (atom.kind === 'backref') {
      out.any = true;
    } else {
      const inner = firstOfDisjunction(atom.body);
      mergeInto(out, inner);
      atomNullable = inner.nullable;
    }
    if (term.min > 0 && !atomNullable) {
      out.nullable = false;
      return out;
    }
  }
  mergeInto(out, follow);
  out.nullable = follow.nullable;
  return out;
}

function firstOfDisjunction(alternatives: Alternative[]): FirstSet {
  const out: FirstSet = { chars: new Set(), classes: [], any: false, nullable: false };
  for (const alternative of alternatives) {
    const first = firstOfSequence(alternative, 0, { ...END_OF_PATTERN, nullable: true });
    mergeInto(out, first);
    if (first.nullable) out.nullable = true;
  }
  return out;
}

function union(a: FirstSet, b: FirstSet): FirstSet {
  const out: FirstSet = { chars: new Set(a.chars), classes: [...a.classes], any: a.any, nullable: a.nullable || b.nullable };
  mergeInto(out, b);
  return out;
}

function mergeInto(target: FirstSet, source: FirstSet): void {
  for (const ch of source.chars) target.chars.add(ch);
  target.classes.push(...source.classes);
  if (source.any) target.any = true;
}

const ESCAPE_CLASSES = new Set(['\\d', '\\w', '\\s', '\\D', '\\W', '\\S']);
const DISJOINT_ESCAPES = new Set(['\\d|\\s', '\\s|\\d', '\\w|\\s', '\\s|\\w', '\\d|\\D', '\\D|\\d', '\\w|\\W', '\\W|\\w', '\\s|\\S', '\\S|\\s']);

/** True when nothing that may follow can be matched by `atom` (unique stopping point). */
function isDelimited(atom: Atom, follow: FirstSet): boolean {
  if (follow.any || (atom.kind !== 'char' && atom.kind !== 'class')) return false;
  for (const ch of follow.chars) {
    if (atom.kind === 'char' ? atom.ch === ch : classMatches(atom.source, ch)) return false;
  }
  for (const source of follow.classes) {
    if (atom.kind === 'char' ? classMatches(source, atom.ch) : !escapesDisjoint(atom.source, source)) return false;
  }
  return true;
}

function escapesDisjoint(a: string, b: string): boolean {
  return ESCAPE_CLASSES.has(a) && DISJOINT_ESCAPES.has(`${a}|${b}`);
}

function classMatches(source: string, ch: string): boolean {
  try {
    return new RegExp(`^(?:${source})$`, 'u').test(ch);
  } catch {
    return true;
  }
}

/** Branches that may start with the same character (classes count as overlapping anything). */
function alternativesOverlap(alternatives: Alternative[]): boolean {
  const seen = new Set<string>();
  for (const alternative of alternatives) {
    const first = firstOfSequence(alternative, 0, { ...END_OF_PATTERN, nullable: true });
    if (first.any || first.nullable || first.classes.length > 0) return true;
    for (const ch of first.chars) {
      if (seen.has(ch)) return true;
      seen.add(ch);
    }
  }
  return false;
}
