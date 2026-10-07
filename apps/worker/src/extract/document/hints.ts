import { firstStableClass } from './dom.js';

// Class/id vocabulary: words that mark small elements as evidence-carrying
// fields (price, rating, availability, sku, brand, date, author, label/value)
// and words that mark navigation chrome.

export const HINT_NONE = 0;
/** Generic UI words (label, value, count, star...): a field only when it has text. */
export const HINT_WEAK = 1;
/** Strong evidence words: the class itself is evidence even without text. */
export const HINT_STRONG = 2;

// Substrings that are specific enough to match anywhere in a class name
// ("productPrice", "price_color", "star-rating", "instock").
const STRONG_SUBSTRINGS = /price|rating|availab|instock|outofstock|sku|gtin|isbn|brand|author|byline|discount|currency|manufacturer/;

// Class/id tokens of navigation chrome. "menu" and "filter" are deliberately
// absent: restaurant menus and "filter-results" wrappers hold real records.
const NAV_TOKENS = new Set([
  'nav', 'navbar', 'navigation', 'breadcrumb', 'breadcrumbs', 'pagination', 'pager',
  'sidebar', 'facet', 'facets', 'megamenu', 'footer',
]);

// Whole tokens only: as substrings these produce false positives
// ("update" ⊃ "date", "account" ⊃ "count", "preview" ⊃ "review").
const STRONG_TOKENS = new Set([
  'date', 'datetime', 'pubdate', 'published', 'updated', 'modified', 'posted', 'time',
  'timestamp', 'stock', 'mpn', 'upc', 'ean', 'cost', 'amount', 'msrp', 'score',
  'vendor', 'seller', 'sale', 'review', 'reviews', 'votes', 'condition',
]);

const WEAK_TOKENS = new Set([
  'label', 'value', 'key', 'val', 'badge', 'count', 'size', 'color', 'colour',
  'variant', 'weight', 'star', 'stars', 'model', 'spec', 'specs',
]);

function tokensOf(raw: string): { lower: string; tokens: string[] } {
  const lower = raw.slice(0, 500).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return { lower, tokens: lower.split(/[^a-z0-9]+/) };
}

function hintOf(lower: string, tokens: string[]): number {
  if (STRONG_SUBSTRINGS.test(lower)) return HINT_STRONG;
  let level = HINT_NONE;
  for (const token of tokens) {
    if (STRONG_TOKENS.has(token)) return HINT_STRONG;
    if (WEAK_TOKENS.has(token)) level = HINT_WEAK;
  }
  return level;
}

function navOf(tokens: string[]): boolean {
  for (const token of tokens) if (NAV_TOKENS.has(token)) return true;
  return false;
}

export interface ClassInfo {
  /** HINT_* level. */
  hint: number;
  /** Names navigation chrome (nav bars, breadcrumbs, sidebars, pagers). */
  nav: boolean;
  /** First stable class token, digits stripped (see firstStableClass). */
  stable: string;
}

const NO_CLASS: ClassInfo = Object.freeze({ hint: HINT_NONE, nav: false, stable: '' });
const classCache = new Map<string, ClassInfo>();

/**
 * Everything the builder derives from a class attribute, memoized per value
 * (class strings repeat heavily across cards, so one lookup per element).
 */
export function analyzeClass(classAttr: string | undefined): ClassInfo {
  if (!classAttr) return NO_CLASS;
  let info = classCache.get(classAttr);
  if (info === undefined) {
    const { lower, tokens } = tokensOf(classAttr);
    info = { hint: hintOf(lower, tokens), nav: navOf(tokens), stable: firstStableClass(classAttr) };
    // Bounded memo of a pure function.
    if (classCache.size > 20_000) classCache.clear();
    classCache.set(classAttr, info);
  }
  return info;
}

/** Hint level and nav-ness of an id attribute (ids are unique, so not memoized). */
export function analyzeId(idAttr: string): { hint: number; nav: boolean } {
  if (idAttr.length > 200) return { hint: HINT_NONE, nav: false };
  const { lower, tokens } = tokensOf(idAttr);
  return { hint: hintOf(lower, tokens), nav: navOf(tokens) };
}

/** True when a class value suggests rating/stock evidence worth rendering. */
export function isEvidenceClass(classAttr: string): boolean {
  return /rating|star|stock|availab/i.test(classAttr);
}

