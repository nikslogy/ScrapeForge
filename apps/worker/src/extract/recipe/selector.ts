// Static policy for recipe CSS selectors.
//
// Selectors run through cheerio (css-select), which also supports jQuery-style
// and dynamic pseudo-classes. Recipes are limited to a standard, cheap subset:
// type/class/id/attribute selectors, the four combinators, structural
// pseudo-classes and :not/:is/:where/:has. Rejected on purpose:
//   - :contains/:icontains (non-standard; text of every candidate subtree),
//   - jQuery positionals (:first, :eq(), :gt(), ...; non-standard semantics),
//   - dynamic/state pseudo-classes that never match a static snapshot,
//   - pseudo-elements, namespaces, :has nested inside :has (quadratic).
// Complexity is capped by length, compound count and argument nesting. The
// parser is a gate only; a selector that passes is also compiled by cheerio.

import * as cheerio from 'cheerio';
import { RECIPE_LIMITS } from './limits.js';

export interface SelectorPolicy {
  /**
   * Field selectors run relative to a record or scope and may start with ">"
   * (direct children). Record and scope selectors are document-level.
   */
  relative: boolean;
}

const NO_ARG_PSEUDOS = new Set([
  'first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'only-of-type',
  'empty', 'checked', 'disabled', 'enabled', 'required', 'optional', 'scope',
]);
const NTH_PSEUDOS = new Set(['nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type']);
const SELECTOR_PSEUDOS = new Set(['not', 'is', 'where', 'has']);
const ATTRIBUTE_OPERATORS = ['~=', '|=', '^=', '$=', '*=', '='];
const NTH_ARGUMENT = /^\s*(?:odd|even|[+-]?\d{0,9}n(?:\s*[+-]\s*\d{1,9})?|[+-]?\d{1,9})\s*$/i;
// C0 controls other than whitespace, DEL, and lone surrogates never belong in a selector.
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

class SelectorError extends Error {}

/** null when the selector is acceptable, otherwise the reason it is not. */
export function checkSelector(selector: unknown, policy: SelectorPolicy): string | null {
  if (typeof selector !== 'string') return 'selector must be a string';
  if (selector.length > RECIPE_LIMITS.maxSelectorChars) return `selector is longer than ${RECIPE_LIMITS.maxSelectorChars} chars`;
  if (selector.trim() === '') return policy.relative ? null : 'selector must not be empty';
  if (FORBIDDEN_CHARS.test(selector)) return 'selector contains control characters';
  try {
    new SelectorParser(selector, policy.relative).parse();
  } catch (err) {
    if (err instanceof SelectorError) return err.message;
    throw err;
  }
  return compileError(selector);
}

let probe: cheerio.CheerioAPI | undefined;

/** Compiles the selector by running it on a tiny document. */
function compileError(selector: string): string | null {
  probe ??= cheerio.load('<html><head></head><body><div><p></p></div></body></html>');
  try {
    probe.root().find(selector);
    return null;
  } catch (err) {
    return `selector does not compile: ${(err as Error).message}`;
  }
}

class SelectorParser {
  private pos = 0;
  private compounds = 0;

  constructor(
    private readonly src: string,
    private readonly relative: boolean,
  ) {}

  parse(): void {
    this.list(0, false, this.relative ? '>' : '');
    if (this.pos < this.src.length) this.fail(`unexpected "${this.src[this.pos]}"`);
  }

  private fail(message: string): never {
    throw new SelectorError(`${message} at ${this.pos} in selector`);
  }

  /** `leading`: combinators allowed before the first compound of each complex selector. */
  private list(depth: number, inHas: boolean, leading: string): void {
    for (;;) {
      this.complex(depth, inHas, leading);
      this.skipWhitespace();
      if (this.src[this.pos] !== ',') return;
      this.pos++;
    }
  }

  private complex(depth: number, inHas: boolean, leading: string): void {
    this.skipWhitespace();
    const c = this.src[this.pos];
    if (c === '>' || c === '+' || c === '~') {
      if (!leading.includes(c)) this.fail(`selector may not start with "${c}"`);
      this.pos++;
      this.skipWhitespace();
    }
    this.compound(depth, inHas);
    for (;;) {
      const hadSpace = this.skipWhitespace();
      const next = this.src[this.pos];
      if (next === '>' || next === '+' || next === '~') {
        this.pos++;
        this.skipWhitespace();
        this.compound(depth, inHas);
      } else if (next === undefined || next === ',' || next === ')') {
        return;
      } else if (hadSpace) {
        this.compound(depth, inHas);
      } else {
        this.fail(`unexpected "${next}"`);
      }
    }
  }

  private compound(depth: number, inHas: boolean): void {
    if (++this.compounds > RECIPE_LIMITS.maxCompoundSelectors) {
      this.fail(`more than ${RECIPE_LIMITS.maxCompoundSelectors} compound selectors`);
    }
    let parts = 0;
    if (this.src[this.pos] === '*') {
      this.pos++;
      parts++;
    } else if (this.atIdentStart()) {
      this.ident();
      parts++;
    }
    if (this.src[this.pos] === '|') this.fail('namespaces are not supported');
    for (;;) {
      const c = this.src[this.pos];
      if (c === '#') {
        this.pos++;
        this.name();
      } else if (c === '.') {
        this.pos++;
        this.ident();
      } else if (c === '[') {
        this.attribute();
      } else if (c === ':') {
        this.pseudo(depth, inHas);
      } else {
        break;
      }
      parts++;
    }
    if (parts === 0) this.fail('expected a selector');
  }

  private attribute(): void {
    this.pos++;
    this.skipWhitespace();
    this.ident();
    this.skipWhitespace();
    if (this.src[this.pos] === ']') {
      this.pos++;
      return;
    }
    if (this.pos >= this.src.length) this.fail('attribute selector is not closed');
    const op = ATTRIBUTE_OPERATORS.find((o) => this.src.startsWith(o, this.pos));
    if (!op) this.fail('unsupported attribute operator');
    this.pos += op.length;
    this.skipWhitespace();
    const q = this.src[this.pos];
    if (q === '"' || q === "'") this.string(q);
    else this.ident();
    this.skipWhitespace();
    const flag = this.src[this.pos];
    if (flag === 'i' || flag === 'I' || flag === 's' || flag === 'S') {
      this.pos++;
      this.skipWhitespace();
    }
    if (this.src[this.pos] !== ']') this.fail('attribute selector is not closed');
    this.pos++;
  }

  private pseudo(depth: number, inHas: boolean): void {
    this.pos++;
    if (this.src[this.pos] === ':') this.fail('pseudo-elements are not allowed');
    const name = this.ident().toLowerCase();
    if (this.src[this.pos] !== '(') {
      if (!NO_ARG_PSEUDOS.has(name)) this.fail(`:${name} is not allowed`);
      return;
    }
    this.pos++;
    if (NTH_PSEUDOS.has(name)) {
      const close = this.src.indexOf(')', this.pos);
      if (close < 0 || !NTH_ARGUMENT.test(this.src.slice(this.pos, close))) this.fail(`bad :${name}() argument`);
      this.pos = close + 1;
      return;
    }
    if (!SELECTOR_PSEUDOS.has(name)) this.fail(`:${name}() is not allowed`);
    if (depth + 1 > RECIPE_LIMITS.maxSelectorNesting) this.fail('selector arguments are nested too deeply');
    if (name === 'has' && inHas) this.fail(':has() inside :has() is not allowed');
    this.list(depth + 1, inHas || name === 'has', name === 'has' ? '>+~' : '');
    this.skipWhitespace();
    if (this.src[this.pos] !== ')') this.fail(`:${name}( is not closed`);
    this.pos++;
  }

  private skipWhitespace(): boolean {
    const start = this.pos;
    while (/[ \t\n\r\f]/.test(this.src[this.pos] ?? '')) this.pos++;
    return this.pos > start;
  }

  private atIdentStart(): boolean {
    const c = this.src[this.pos];
    if (c === undefined) return false;
    if (c === '-') {
      const n = this.src[this.pos + 1];
      return n !== undefined && (n === '-' || isNameStart(n) || n === '\\');
    }
    return isNameStart(c) || c === '\\';
  }

  private ident(): string {
    if (!this.atIdentStart()) this.fail('expected a name');
    const start = this.pos;
    if (this.src[this.pos] === '-') this.pos++;
    this.nameChars();
    return this.src.slice(start, this.pos);
  }

  private name(): void {
    const start = this.pos;
    this.nameChars();
    if (this.pos === start) this.fail('expected a name');
  }

  private nameChars(): void {
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) return;
      if (c === '\\') this.escape();
      else if (isNameChar(c)) this.pos++;
      else return;
    }
  }

  private escape(): void {
    this.pos++;
    const c = this.src[this.pos];
    if (c === undefined || c === '\n' || c === '\r' || c === '\f') this.fail('bad escape');
    const hex = /^[0-9a-fA-F]{1,6}/.exec(this.src.slice(this.pos, this.pos + 6));
    if (hex) {
      this.pos += hex[0].length;
      if (/[ \t\n\r\f]/.test(this.src[this.pos] ?? '')) this.pos++;
    } else {
      this.pos += (c.codePointAt(0) as number) > 0xffff ? 2 : 1;
    }
  }

  private string(quote: string): void {
    this.pos++;
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined || c === '\n' || c === '\r' || c === '\f') this.fail('string is not closed');
      if (c === quote) {
        this.pos++;
        return;
      }
      if (c === '\\') this.pos += 2;
      else this.pos++;
    }
  }
}

function isNameStart(c: string): boolean {
  return /[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80;
}

function isNameChar(c: string): boolean {
  return /[A-Za-z0-9_-]/.test(c) || c.charCodeAt(0) >= 0x80;
}
