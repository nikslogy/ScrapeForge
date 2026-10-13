// Targeted block selection for pages larger than one model call.
//
// When a page does not fit and the answer is one object (or a list with no
// detected record group), sending the first N characters loses every value
// printed further down. Instead the blocks most relevant to the requested
// fields are chosen with BM25 over block text, heading path and the
// attributes the renderer shows. The top of the page is always kept (title,
// price and summary usually live there), and each hit brings its neighbours
// (labels such as "Price" are often the block before the value). The
// selection is rendered in document order by renderBlocks.

import type { FieldSpec, SourceBlock, SourceDocument } from '../types.js';

export interface BlockSelection {
  /** Chosen block ids, in document order. */
  blockIds: string[];
  /** Blocks that scored above zero for the query. */
  matched: number;
}

/** Share of the budget always given to the top of the page. */
const LEAD_SHARE = 0.15;
/** Rendering overhead per block ("[b123] ", attribute braces, newline). */
const LINE_OVERHEAD = 12;
/** Neighbours brought along with each hit, before and after. */
const NEIGHBOURS_BEFORE = 1;
const NEIGHBOURS_AFTER = 1;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Characters of one block that are scored (long paragraphs keep their start). */
const MAX_SCORED_CHARS = 2_000;
const MAX_QUERY_TERMS = 200;

// Words that say little about where a value is.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'when', 'what', 'which', 'only', 'into', 'its', 'are', 'was',
  'were', 'not', 'null', 'none', 'true', 'false', 'string', 'number', 'integer', 'boolean', 'array', 'object', 'value',
  'values', 'field', 'page', 'shown', 'listed', 'given', 'any', 'all', 'each', 'per', 'out', 'has', 'have', 'otherwise',
  'der', 'die', 'das', 'und', 'les', 'des', 'del', 'los', 'las', 'une', 'el', 'la', 'le', 'il', 'di', 'de', 'en',
]);

// Words pages print near common fields that field names rarely contain.
const RELATED: Record<string, readonly string[]> = {
  price: ['price', 'cost', 'sale', 'now', 'was', 'msrp', 'usd', 'eur', 'gbp', 'preis', 'prix', 'precio', 'prezzo'],
  rating: ['rating', 'rated', 'stars', 'star', 'reviews', 'review', 'score', 'bewertung', 'avis'],
  review: ['reviews', 'review', 'ratings', 'rating'],
  stock: ['stock', 'available', 'availability', 'unavailable', 'sold', 'lager', 'disponible'],
  sku: ['sku', 'item', 'model', 'part', 'mpn', 'art', 'artikel'],
  brand: ['brand', 'manufacturer', 'by', 'marke', 'marque'],
  author: ['author', 'by', 'written', 'byline'],
  date: ['date', 'published', 'updated', 'posted', 'on'],
  salary: ['salary', 'pay', 'compensation', 'year', 'hour', 'annual'],
  location: ['location', 'city', 'address', 'based', 'office'],
  weight: ['weight', 'weighs', 'kg', 'lb', 'lbs', 'grams'],
  shipping: ['shipping', 'delivery', 'ships', 'versand', 'livraison'],
  currency: ['currency', 'usd', 'eur', 'gbp'],
};

function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const t = m[0];
    // Unspaced scripts: every character is a term.
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(t)) {
      for (const ch of t) out.push(ch);
    } else if (t.length >= 2) {
      out.push(t);
    }
  }
  return out;
}

/** "salaryMin" → "salary min"; "free_shipping" → "free shipping". */
function nameWords(name: string): string {
  return name.replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2').replace(/[_\-.]+/g, ' ');
}

/** Query terms from field names, descriptions and enum values, with related words. */
export function queryTerms(fields: readonly FieldSpec[]): Map<string, number> {
  const weights = new Map<string, number>();
  const add = (term: string, weight: number): void => {
    if (term.length < 2 || STOPWORDS.has(term) || weights.size >= MAX_QUERY_TERMS) return;
    weights.set(term, Math.max(weights.get(term) ?? 0, weight));
  };
  for (const f of fields) {
    const own = tokenize(nameWords(f.name));
    for (const t of own) {
      add(t, 2);
      for (const r of RELATED[t] ?? []) add(r, 1);
      // "reviewCount" → also "reviews"; "prices" → "price".
      if (t.endsWith('s') && RELATED[t.slice(0, -1)]) for (const r of RELATED[t.slice(0, -1)]) add(r, 1);
    }
    for (const t of tokenize(f.description ?? '').slice(0, 30)) add(t, 1);
    const enums = (f.schema as { enum?: unknown[] } | undefined)?.enum;
    if (Array.isArray(enums)) for (const e of enums.slice(0, 20)) if (typeof e === 'string') for (const t of tokenize(e)) add(t, 1);
  }
  return weights;
}

function blockTerms(b: SourceBlock): string[] {
  const parts = [b.text.slice(0, MAX_SCORED_CHARS), b.headingPath.join(' ')];
  const a = b.attrs;
  if (a) for (const k of ['class', 'itemprop', 'aria-label', 'title', 'alt', 'id', 'name']) if (a[k]) parts.push(a[k].replace(/[-_]/g, ' '));
  return tokenize(parts.join(' '));
}

/** Rendered size of one block, roughly as renderBlocks prints it. */
function blockChars(b: SourceBlock): number {
  let n = b.text.length + LINE_OVERHEAD;
  if (b.attrs) for (const v of Object.values(b.attrs)) n += Math.min(v.length, 300) + 8;
  return n;
}

/** BM25 score of every block for the query (0 when no term matches). */
export function scoreBlocks(doc: SourceDocument, query: Map<string, number>): Float64Array {
  const blocks = doc.blocks;
  const scores = new Float64Array(blocks.length);
  if (query.size === 0 || blocks.length === 0) return scores;
  const termLists = blocks.map(blockTerms);
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const terms of termLists) {
    totalLen += terms.length;
    for (const t of new Set(terms)) if (query.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = blocks.length;
  const avgLen = Math.max(1, totalLen / n);
  termLists.forEach((terms, i) => {
    if (terms.length === 0) return;
    const tf = new Map<string, number>();
    for (const t of terms) if (query.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const [t, f] of tf) {
      const d = df.get(t) ?? 0;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      score += (query.get(t) ?? 1) * idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * terms.length) / avgLen)));
    }
    scores[i] = score;
  });
  return scores;
}

/**
 * Blocks to send for `fields` within about `maxChars` of rendering: the top
 * of the page, then the best-scoring blocks with their neighbours. The
 * caller renders them with renderBlocks({ blockIds, maxChars }), which keeps
 * document order and never exceeds maxChars.
 */
export function selectBlocks(doc: SourceDocument, fields: readonly FieldSpec[], maxChars: number): BlockSelection {
  const blocks = doc.blocks;
  const chosen = new Uint8Array(blocks.length);
  let used = 0;
  const take = (i: number): boolean => {
    if (i < 0 || i >= blocks.length || chosen[i]) return true;
    const size = blockChars(blocks[i]);
    if (used + size > maxChars) return false;
    chosen[i] = 1;
    used += size;
    return true;
  };

  // The top of the page.
  const lead = maxChars * LEAD_SHARE;
  for (let i = 0; i < blocks.length && used < lead; i++) if (!take(i)) break;

  const scores = scoreBlocks(doc, queryTerms(fields));
  const order = [...scores.keys()].filter((i) => scores[i] > 0).sort((a, b) => scores[b] - scores[a] || a - b);
  for (const i of order) {
    if (used >= maxChars) break;
    take(i);
    for (let k = 1; k <= NEIGHBOURS_BEFORE; k++) take(i - k);
    for (let k = 1; k <= NEIGHBOURS_AFTER; k++) take(i + k);
  }
  // Room left: the rest in document order.
  for (let i = 0; i < blocks.length && used < maxChars; i++) take(i);

  const blockIds: string[] = [];
  chosen.forEach((c, i) => {
    if (c) blockIds.push(blocks[i].id);
  });
  return { blockIds, matched: order.length };
}
