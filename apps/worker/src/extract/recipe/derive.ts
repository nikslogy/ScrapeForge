// Selector and regex derivation for recipe induction.
//
// Given an element found to hold a sample value, these helpers propose
// selectors that re-find it relative to its record (or the page), most stable
// first: itemprop / id / test attributes / stable classes, then ancestor- or
// sibling-qualified forms, then positional forms. Generated CSS hashes
// ("css-1x2y3z", "Button_root__a1b2c") and UI-state classes are never used.
// Every proposal still has to pass checkSelector / checkRegex and reproduce
// the sample values on every sample record before induction keeps it.

import { type DomElement, type DomNode, isElement } from './dom.js';
import { checkRegex } from './safe-regex.js';
import { checkSelector } from './selector.js';

const SIMPLE_IDENT = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/;
const SIMPLE_TAG = /^[a-z][a-z0-9-]*$/;

// UI state varies between records and pages of one template.
const STATE_CLASSES = new Set([
  'active', 'current', 'selected', 'open', 'opened', 'show', 'shown', 'hidden', 'visible', 'collapsed',
  'expanded', 'disabled', 'focus', 'focused', 'hover', 'first', 'last', 'odd', 'even', 'clearfix',
  'loaded', 'lazyloaded', 'lazyload', 'in', 'fade',
]);

/** Attributes whose value names a role rather than data, safe to select on. */
const ROLE_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-component', 'data-component-type', 'data-role', 'role', 'name', 'type'];

const MAX_ATTR_VALUE_IN_SELECTOR = 60;

export function isStableClass(token: string): boolean {
  if (token.length === 0 || token.length > 40 || !SIMPLE_IDENT.test(token)) return false;
  const lower = token.toLowerCase();
  if (STATE_CLASSES.has(lower) || lower.startsWith('is-') || lower.startsWith('has-')) return false;
  // CSS-in-JS and CSS-module hashes.
  if (/^(?:css|sc|jsx|emotion|styled|svelte|astro|tw)-/i.test(token)) return false;
  if (/_{1,2}[a-zA-Z0-9]{5,}$/.test(token) && /\d/.test(token)) return false;
  // Random-looking tokens: three or more digits mixed with letters ("a1b2c3", "x9k2m").
  const digits = token.replace(/\D/g, '').length;
  return !(digits >= 3 && /[a-zA-Z]/.test(token));
}

export function stableClasses(el: DomElement): string[] {
  const cls = el.attribs.class;
  if (!cls) return [];
  return [...new Set(cls.split(/\s+/).filter(isStableClass))];
}

/** Value usable in a selector without suggesting a per-record id. */
function isStableAttrValue(v: string): boolean {
  return v.length > 0 && v.length <= MAX_ATTR_VALUE_IN_SELECTOR && !/\d{3,}/.test(v) && !/[\u0000-\u001f"\\]/.test(v);
}

export function cssString(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function tagOf(el: DomElement): string {
  return SIMPLE_TAG.test(el.name) ? el.name : '*';
}

/**
 * Compound selectors for one element, most stable first. `readAttr` adds
 * `tag[attr]` (presence of the attribute being read), which keeps e.g.
 * `a[title]` from matching an image link without a title.
 */
export function stepVariants(el: DomElement, readAttr?: string): string[] {
  const tag = tagOf(el);
  const out: string[] = [];
  const itemprop = el.attribs.itemprop;
  if (itemprop && isStableAttrValue(itemprop)) out.push(`${tag}[itemprop=${cssString(itemprop)}]`);
  const id = el.attribs.id;
  if (id && SIMPLE_IDENT.test(id) && isStableClass(id)) out.push(`#${id}`);
  for (const name of ROLE_ATTRS) {
    const v = el.attribs[name];
    if (v !== undefined && Object.prototype.hasOwnProperty.call(el.attribs, name) && isStableAttrValue(v)) {
      out.push(`${tag}[${name}=${cssString(v)}]`);
    }
  }
  const classes = stableClasses(el).slice(0, 4);
  for (const c of classes) out.push(`${tag}.${c}`);
  if (classes.length >= 2) out.push(`${tag}.${classes[0]}.${classes[1]}`);
  if (readAttr && SIMPLE_IDENT.test(readAttr) && readAttr !== 'class') out.push(`${tag}[${readAttr}]`);
  out.push(tag);
  return [...new Set(out)];
}

/** Steps for ancestors/siblings used as anchors: only distinctive ones (no bare tag). */
function anchorSteps(el: DomElement): string[] {
  const tag = tagOf(el);
  return stepVariants(el).filter((s) => s !== tag).slice(0, 3);
}

function elementSiblings(el: DomElement): DomElement[] {
  const parent = el.parent as (DomNode & { children?: DomNode[] }) | null;
  return (parent?.children ?? []).filter(isElement);
}

/** 1-based index among element siblings of the same tag (for :nth-of-type). */
function nthOfType(el: DomElement): number {
  let n = 0;
  for (const sib of elementSiblings(el)) {
    if (sib.name === el.name) n++;
    if (sib === el) return n;
  }
  return n;
}

function previousElement(el: DomElement): DomElement | undefined {
  const sibs = elementSiblings(el);
  const i = sibs.indexOf(el);
  return i > 0 ? sibs[i - 1] : undefined;
}

/**
 * Relative selectors for `el` inside `scope` ("" when el is the scope),
 * most stable first, all passing checkSelector.
 */
export function selectorCandidates(el: DomElement, scope: DomNode, readAttr?: string): string[] {
  if (el === scope) return [''];
  const path: DomElement[] = [];
  for (let n: DomNode | null = el; n && n !== scope; n = n.parent) {
    if (!isElement(n)) return [];
    path.push(n);
  }
  const own = stepVariants(el, readAttr);
  const out: string[] = [...own];
  const ownTop = own.slice(0, 3);

  for (const ancestor of path.slice(1, 4)) {
    for (const a of anchorSteps(ancestor)) for (const s of ownTop) out.push(`${a} ${s}`);
  }
  const prev = previousElement(el);
  if (prev) {
    for (const p of anchorSteps(prev)) {
      out.push(`${p} + ${tagOf(el)}`);
      out.push(`${p} ~ ${tagOf(el)}`);
    }
  }
  const tag = tagOf(el);
  if (tag !== '*') {
    out.push(`${tag}:nth-of-type(${nthOfType(el)})`);
    const parent = path[1];
    if (parent) {
      for (const p of [...anchorSteps(parent), tagOf(parent)]) out.push(`${p} > ${tag}:nth-of-type(${nthOfType(el)})`);
    }
  }
  // Full child path from the scope, positional where siblings share a tag.
  if (path.length <= 8 && path.every((n) => tagOf(n) !== '*')) {
    const steps = [...path].reverse().map((n) => {
      const same = elementSiblings(n).filter((s) => s.name === n.name).length;
      return same > 1 ? `${n.name}:nth-of-type(${nthOfType(n)})` : n.name;
    });
    out.push(`> ${steps.join(' > ')}`);
  }
  return [...new Set(out)].filter((s) => checkSelector(s, { relative: true }) === null);
}

// ─────────────────────────────────────────────────────────────
// Regexes for values inside longer text
// ─────────────────────────────────────────────────────────────

const REGEX_SYNTAX = /[\^$\\.*+?()[\]{}|/]/g;

export function escapeRegex(s: string): string {
  return s.replace(REGEX_SYNTAX, '\\$&');
}

const MAX_SHAPE_SOURCE_CHARS = 60;
const MAX_ANCHOR_CHARS = 30;

/**
 * Generalizes a value into a pattern of the same shape: digit runs (with
 * separators) → \d[\d.,]*, letter runs → \p{L}+, whitespace → \s+, anything
 * else literal. "£51.77" → "£\d[\d.,]*", "In stock" → "\p{L}+\s+\p{L}+".
 */
export function valueShape(value: string): string | null {
  if (value.length === 0 || value.length > MAX_SHAPE_SOURCE_CHARS) return null;
  let out = '';
  const re = /(\d[\d.,]*)|(\p{L}+)|(\s+)|([^])/gu;
  for (const m of value.matchAll(re)) {
    if (m[1]) out += '\\d[\\d.,]*';
    else if (m[2]) out += '\\p{L}+';
    else if (m[3]) out += '\\s+';
    else out += escapeRegex(m[4]);
  }
  return out;
}

function anchorTokens(text: string, fromEnd: boolean): string | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const token = fromEnd ? tokens[tokens.length - 1] : tokens[0];
  // Digits in an anchor usually vary per record ("(22 available)").
  if (token.length > MAX_ANCHOR_CHARS || /\d/.test(token)) return null;
  return escapeRegex(token);
}

export interface RegexProposal {
  regex: string;
  /** Apply "trim" after the regex (generic captures keep surrounding spaces). */
  trim: boolean;
}

/**
 * Regexes that capture `matched` (found at `index` of `haystack`), anchored
 * on the neighbouring words, most specific first. Only safe patterns
 * (checkRegex) are returned.
 */
export function regexCandidates(haystack: string, index: number, matched: string): RegexProposal[] {
  const pre = haystack.slice(0, index);
  const post = haystack.slice(index + matched.length);
  const shape = valueShape(matched);
  const leftWord = anchorTokens(pre, true);
  const rightWord = anchorTokens(post, false);
  // Haystacks are whitespace-collapsed, so one optional space covers the gap
  // (and keeps the pattern free of extra unbounded quantifiers).
  const left = leftWord === null ? null : `${leftWord}${/\s$/.test(pre) ? '\\s?' : ''}`;
  const right = rightWord === null ? null : `${/^\s/.test(post) ? '\\s?' : ''}${rightWord}`;
  const out: RegexProposal[] = [];
  if (shape) {
    if (left) out.push({ regex: `${left}(${shape})`, trim: false });
    if (right) out.push({ regex: `(${shape})${right}`, trim: false });
    if (left && right) out.push({ regex: `${left}(${shape})${right}`, trim: false });
    if (pre.trim() === '') out.push({ regex: `^(${shape})`, trim: false });
    if (post.trim() === '') out.push({ regex: `(${shape})$`, trim: false });
    out.push({ regex: `(${shape})`, trim: false });
  }
  // Shape-free fallbacks: everything after the left word / before the right word.
  if (leftWord && post.trim() === '') out.push({ regex: `${leftWord}(.*)`, trim: true });
  if (rightWord && pre.trim() === '') out.push({ regex: `^(.*?)${right}`, trim: true });
  const seen = new Set<string>();
  return out.filter((p) => {
    if (seen.has(p.regex)) return false;
    seen.add(p.regex);
    return checkRegex(p.regex).ok;
  });
}

/**
 * Regexes picking one class token: anchored on the stable token before it
 * ("star-rating Three" → "\bstar-rating\s+(\S+)"), or after it, or by position.
 */
export function classTokenRegexes(tokens: string[], index: number): string[] {
  const out: string[] = [];
  const before = tokens[index - 1];
  const after = tokens[index + 1];
  if (before !== undefined && isStableClass(before)) out.push(`(?:^|\\s)${escapeRegex(before)}\\s+(\\S+)`);
  if (after !== undefined && isStableClass(after)) out.push(`(\\S+)\\s+${escapeRegex(after)}(?:\\s|$)`);
  if (index <= 3) out.push(`^${'\\S+\\s+'.repeat(index)}(\\S+)`);
  return out.filter((r) => checkRegex(r).ok);
}
