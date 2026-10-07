// Reads one customer field from one entity: concept paths, offer selection,
// leaf unwrapping, @id dereferencing. Every hit carries the item id and JSON
// pointer it was read from, and the raw value exactly as published.

import { parseLocaleNumber, findNumericTokens } from '../validate/numbers.js';
import { type Concept, type FieldPlan, type ValueKind, conceptsForName, outputMode, pathsFor } from './concepts.js';
import { type Entity, type Node, type RefIndex, childNode, indexNode, isRefOnly } from './entities.js';
import { type Family, familiesOf } from './families.js';
import { STRUCTURED_LIMITS } from './limits.js';
import { identifierTokens, isPlainObject, isTemplatePlaceholder, looksLikeUrl, own, typeTail, typesOf } from './text.js';
import { isNumericLike, type PageIndex } from './visibility.js';

export type HitNote = 'multiple_offers' | 'multiple_values';

export interface Hit {
  /** Concept id the value was read as ('' for an exact key match). */
  readonly concept: string;
  readonly raw: unknown;
  readonly itemId: string;
  readonly pointer: string;
  readonly kind: ValueKind;
  readonly notes: readonly HitNote[];
}

/** Wrapper keys unwrapped per leaf kind, in order ({"@value"}, Brand.name, ImageObject.url, ...). */
const OBJECT_KEYS: Readonly<Record<ValueKind, readonly string[]>> = {
  text: ['@value'],
  name: ['name', '@value'],
  body: ['text', '@value'],
  // Embedded JSON prices: {amount, currencyCode}, {value, currency}, {current, formatted}.
  number: ['@value', 'value', 'amount', 'price', 'current', 'formatted', 'display', 'displayValue'],
  quantity: ['@value', 'value', 'name'],
  url: ['url', 'contentUrl', 'src', 'href', '@id', '@value'],
  date: ['@value'],
  enum: ['@id', '@value', 'name'],
  duration: ['@value'],
};

const NUMBER_KINDS: ReadonlySet<ValueKind> = new Set(['text', 'name', 'number', 'quantity']);

// priceSpecification.priceType values that mark a reference ("was") price.
const LIST_PRICE_TYPES = new Set(['listprice', 'strikethroughprice', 'msrp', 'srp']);

const MAX_ARRAY_SCAN = 50;

interface OfferSelection {
  /** The offer the price was taken from (or the only offer). */
  readonly offer: Node;
  readonly aggregate: boolean;
  readonly price?: Node;
  readonly currency?: Node;
  /** Offers disagree on price or currency; the choice is reported. */
  readonly multiple: boolean;
}

function acceptString(s: string, kind: ValueKind): boolean {
  const t = s.trim();
  if (!t || isTemplatePlaceholder(t)) return false;
  switch (kind) {
    case 'number':
      return isNumericLike(t);
    case 'quantity':
      return t.length <= 200 && /\d/.test(t);
    case 'url':
      return looksLikeUrl(t);
    case 'date':
      return t.length <= 100 && /\d/.test(t);
    case 'duration':
    case 'enum':
      return t.length <= 500;
    case 'name':
      // An author given as a profile URL is not a name.
      return t.length <= 1000 && !looksLikeUrl(t);
    default:
      return true;
  }
}

/** Numeric value of a raw price for comparisons only (never returned). */
function numberOf(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const t = raw.normalize('NFKC');
  const tokens = findNumericTokens(t, 2);
  if (tokens.length !== 1) return undefined;
  return parseLocaleNumber(tokens[0].text) ?? undefined;
}

function currencyOf(node: Node | undefined): string {
  const v = node?.value;
  return typeof v === 'string' ? v.trim().toUpperCase() : '';
}

/** Tail of an enumeration value given as a string or {"@id"}: "https://schema.org/ListPrice" → "listprice". */
function enumTail(v: unknown): string | undefined {
  const s = isPlainObject(v) ? own(v, '@id') : v;
  return typeTail(s)?.toLowerCase();
}

function splitKeywords(s: string): string[] {
  return s
    .split(/\s*[,;|]\s*/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, STRUCTURED_LIMITS.maxMultiValues);
}

function ownKeys(obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k in obj) {
    if (!Object.hasOwn(obj, k)) continue;
    out.push(k);
    if (out.length >= STRUCTURED_LIMITS.maxKeysPerObject) break;
  }
  return out;
}

export class Resolver {
  private readonly memo = new WeakMap<Entity, Array<Hit | null | undefined>>();
  private readonly offers = new WeakMap<object, OfferSelection | null>();
  private readonly keyConcepts = new WeakMap<object, Map<string, string[]>>();

  constructor(
    private readonly refs: RefIndex,
    private readonly page: PageIndex,
  ) {}

  /** The field's value on this entity alone (memoized). */
  field(entity: Entity, plan: FieldPlan): Hit | undefined {
    let row = this.memo.get(entity);
    if (!row) {
      row = [];
      this.memo.set(entity, row);
    }
    const cached = row[plan.index];
    if (cached !== undefined) return cached ?? undefined;
    const hit = this.compute(entity, plan);
    row[plan.index] = hit ?? null;
    return hit;
  }

  private compute(entity: Entity, plan: FieldPlan): Hit | undefined {
    const field = plan.field;
    for (const c of plan.concepts) {
      const hit = entity.flat ? this.flat(entity, c, plan) : this.concept(entity.node, entity.families, c, plan, true);
      if (hit) return hit;
      if (entity.wrapper && c.wrapper) {
        for (const path of c.wrapper) {
          const h = this.viaSteps(entity.wrapper, [path], c, plan);
          if (h) return h;
        }
      }
    }
    if (plan.exactKeyFallback && !entity.flat) return this.exactKey(entity, plan, field.type);
    return undefined;
  }

  // ── structured entities ────────────────────────────────────

  private concept(node: Node, families: readonly Family[], c: Concept, plan: FieldPlan, allowOffered: boolean): Hit | undefined {
    if (c.special) {
      const h = this.special(node, families, c, plan);
      if (h) return h;
    }
    for (const path of pathsFor(c, families)) {
      const h = this.viaSteps(node, path.split('/'), c, plan);
      if (h) return h;
    }
    // Non-standard but common: "salePrice" or "rating" directly on the entity.
    for (const key of this.directKeys(node.value, c.id)) {
      const h = this.viaSteps(node, [key], c, plan);
      if (h) return h;
    }
    // Offers listed in a catalog describe their product in itemOffered.
    if (allowOffered && families.includes('offer')) {
      const offered = this.rawChild(node, 'itemOffered');
      if (offered && isPlainObject(offered.value)) {
        const offeredFamilies = familiesOf(typesOf(offered.value));
        return this.concept(offered, offeredFamilies[0] === 'other' ? ['product'] : offeredFamilies, c, plan, false);
      }
    }
    return undefined;
  }

  /** Own keys of an object whose names mean this concept ("salePrice" → price). */
  private directKeys(value: unknown, conceptId: string): readonly string[] {
    if (!isPlainObject(value)) return [];
    let map = this.keyConcepts.get(value);
    if (!map) {
      map = new Map();
      for (const key of ownKeys(value)) {
        if (key.startsWith('@')) continue;
        for (const concept of conceptsForName(key)) {
          const list = map.get(concept.id);
          if (list) list.push(key);
          else map.set(concept.id, [key]);
        }
      }
      this.keyConcepts.set(value, map);
    }
    return map.get(conceptId) ?? [];
  }

  /** Field name equal to an own key ("color" ↔ "color", "isbn_13" ↔ "isbn13" not included). */
  private exactKey(entity: Entity, plan: FieldPlan, type: FieldPlan['field']['type']): Hit | undefined {
    if (type === 'object') return undefined;
    const data = entity.node.value as Record<string, unknown>;
    const kind: ValueKind = type === 'number' || type === 'integer' ? 'number' : type === 'boolean' ? 'enum' : 'text';
    const pseudo: Concept = { id: '', kind, syn: [], ...(type === 'array' ? { multi: 'values' as const, join: ', ' } : {}) };
    for (const key of ownKeys(data)) {
      if (key.startsWith('@') || identifierTokens(key).join(' ') !== plan.keyPhrase) continue;
      const h = this.viaSteps(entity.node, [key], pseudo, plan);
      if (h) return h;
    }
    return undefined;
  }

  // ── paths and leaves ───────────────────────────────────────

  private viaSteps(node: Node, steps: readonly string[], c: Concept, plan: FieldPlan, notes: HitNote[] = []): Hit | undefined {
    let cur: Node | undefined = node;
    for (const step of steps) {
      cur = this.step(cur, step, notes, 0);
      if (!cur) return undefined;
    }
    return this.leafHit(cur, c, plan, notes);
  }

  /**
   * One property step. An array on the way is read through its first object
   * (noted when there were several); a {"@id"} reference is followed.
   */
  private step(node: Node, key: string, notes: HitNote[], hops: number): Node | undefined {
    let cur = node;
    if (Array.isArray(cur.value)) {
      const arr = cur.value;
      let first = -1;
      let objects = 0;
      for (let i = 0; i < arr.length && i < MAX_ARRAY_SCAN; i++) {
        if (!isPlainObject(arr[i])) continue;
        if (first < 0) first = i;
        objects++;
      }
      if (first < 0) return undefined;
      if (objects > 1 && !notes.includes('multiple_values')) notes.push('multiple_values');
      cur = indexNode(cur, first);
    }
    const v = cur.value;
    if (!isPlainObject(v)) return undefined;
    if (Object.hasOwn(v, key)) {
      const next = v[key];
      return next === null || next === undefined || next === '' ? undefined : childNode(cur, key);
    }
    const target = this.deref(cur, hops);
    return target ? this.step(target, key, notes, hops + 1) : undefined;
  }

  /** Own property without array descent (offers, priceSpecification), following a reference. */
  private rawChild(node: Node, key: string): Node | undefined {
    let cur: Node | undefined = node;
    for (let hops = 0; cur && hops <= STRUCTURED_LIMITS.maxRefHops; hops++) {
      const v: unknown = cur.value;
      if (!isPlainObject(v)) return undefined;
      if (Object.hasOwn(v, key)) {
        const next = v[key];
        return next === null || next === undefined ? undefined : childNode(cur, key);
      }
      cur = this.deref(cur, hops);
    }
    return undefined;
  }

  private deref(node: Node, hops: number): Node | undefined {
    if (hops >= STRUCTURED_LIMITS.maxRefHops) return undefined;
    const v = node.value;
    if (!isPlainObject(v)) return undefined;
    const target = this.refs.get(own(v, '@id'));
    return target && target.value !== v && isPlainObject(target.value) ? target : undefined;
  }

  private derefIfRef(node: Node): Node {
    return isRefOnly(node.value) ? (this.deref(node, 0) ?? node) : node;
  }

  /** The node holding an acceptable scalar for `kind`, unwrapping arrays and wrapper objects. */
  private scalar(node: Node, kind: ValueKind, depth: number): Node | undefined {
    const v = node.value;
    if (typeof v === 'string') return acceptString(v, kind) ? node : undefined;
    if (typeof v === 'number') return Number.isFinite(v) && NUMBER_KINDS.has(kind) ? node : undefined;
    if (typeof v === 'boolean') return kind === 'enum' ? node : undefined;
    if (depth >= STRUCTURED_LIMITS.maxLeafDepth) return undefined;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length && i < MAX_ARRAY_SCAN; i++) {
        const r = this.scalar(indexNode(node, i), kind, depth + 1);
        if (r) return r;
      }
      return undefined;
    }
    if (!isPlainObject(v)) return undefined;
    for (const key of OBJECT_KEYS[kind]) {
      if (!Object.hasOwn(v, key)) continue;
      // An @id is a URL only when it is not a fragment identifier ("…/#product").
      if (key === '@id' && kind === 'url' && (typeof v[key] !== 'string' || (v[key] as string).includes('#'))) continue;
      const r = this.scalar(childNode(node, key), kind, depth + 1);
      if (r) return r;
    }
    const target = this.deref(node, 0);
    return target ? this.scalar(target, kind, depth + 1) : undefined;
  }

  /** Every acceptable value of an array (HowToSection steps flattened one level). */
  private multi(node: Node, kind: ValueKind): Node[] {
    const out: Node[] = [];
    const max = STRUCTURED_LIMITS.maxMultiValues;
    const add = (n: Node, depth: number) => {
      if (out.length >= max) return;
      const v = n.value;
      if (isPlainObject(v) && depth < 2 && Array.isArray(own(v, 'itemListElement'))) {
        const inner = childNode(n, 'itemListElement');
        const arr = inner.value as unknown[];
        for (let i = 0; i < arr.length && out.length < max; i++) add(indexNode(inner, i), depth + 1);
        return;
      }
      const leaf = this.scalar(n, kind, 0);
      if (leaf && !out.some((o) => o.value === leaf.value)) out.push(leaf);
    };
    const v = node.value;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length && out.length < max; i++) add(indexNode(node, i), 0);
    } else {
      add(node, 0);
    }
    return out;
  }

  private leafHit(node: Node, c: Concept, plan: FieldPlan, notes: readonly HitNote[]): Hit | undefined {
    const mode = outputMode(c, plan.field);
    if (mode === 'scalar') {
      const leaf = this.scalar(node, c.kind, 0);
      if (!leaf || (c.check && !c.check(leaf.value))) return undefined;
      return { concept: c.id, raw: leaf.value, itemId: leaf.itemId, pointer: leaf.pointer, kind: c.kind, notes: [...notes] };
    }
    const values = this.multi(node, c.kind);
    if (values.length === 0) return undefined;
    const raws = values.map((n) => n.value);
    if (c.check && !raws.every(c.check)) return undefined;
    // One value: point at it exactly; several: point at their container.
    const at = values.length === 1 ? values[0] : node;
    let raw: unknown;
    if (mode === 'array') {
      raw = c.multi === 'keywords' && raws.length === 1 && typeof raws[0] === 'string' ? splitKeywords(raws[0]) : raws;
    } else if (mode === 'join') {
      raw = raws.length === 1 ? raws[0] : raws.map((r) => String(r)).join(c.join ?? ', ');
    } else {
      raw = raws.length === 1 ? raws[0] : raws;
    }
    return { concept: c.id, raw, itemId: at.itemId, pointer: at.pointer, kind: c.kind, notes: [...notes] };
  }

  // ── offers, prices, salaries ───────────────────────────────

  private special(node: Node, families: readonly Family[], c: Concept, plan: FieldPlan): Hit | undefined {
    switch (c.special) {
      case 'price': {
        const sel = this.selection(node, families);
        return sel?.price ? this.leafHit(sel.price, c, plan, sel.multiple ? ['multiple_offers'] : []) : undefined;
      }
      case 'originalPrice': {
        const sel = this.selection(node, families);
        const spec = sel ? this.priceSpec(sel.offer, true) : undefined;
        return spec ? this.leafHit(spec.price, c, plan, []) : undefined;
      }
      case 'lowPrice':
      case 'highPrice': {
        const sel = this.selection(node, families);
        const bound = sel?.aggregate ? this.rawChild(sel.offer, c.special) : undefined;
        return bound ? this.leafHit(bound, c, plan, []) : undefined;
      }
      case 'currency':
        return this.currency(node, families, c, plan);
      case 'offerField': {
        const sel = this.selection(node, families);
        const value = sel && c.offerKey ? this.rawChild(sel.offer, c.offerKey) : undefined;
        return value ? this.leafHit(value, c, plan, []) : undefined;
      }
      case 'salary':
      case 'salaryMin':
      case 'salaryMax':
        return this.salary(node, c.special, c, plan);
      default:
        return undefined;
    }
  }

  private currency(node: Node, families: readonly Family[], c: Concept, plan: FieldPlan): Hit | undefined {
    const sel = this.selection(node, families);
    if (sel) {
      const cur = sel.price ? sel.currency : this.rawChild(sel.offer, 'priceCurrency');
      if (cur) {
        const h = this.leafHit(cur, c, plan, sel.multiple ? ['multiple_offers'] : []);
        if (h) return h;
      }
    }
    if (families.includes('job')) {
      for (const path of ['baseSalary/currency', 'salaryCurrency', 'estimatedSalary/currency']) {
        const h = this.viaSteps(node, path.split('/'), c, plan);
        if (h) return h;
      }
    }
    // Embedded JSON price objects: "price": {"amount": "12.99", "currencyCode": "USD"}.
    for (const key of this.directKeys(node.value, 'price')) {
      const priceNode = childNode(node, key);
      for (const inner of this.directKeys(priceNode.value, 'currency')) {
        const h = this.viaSteps(priceNode, [inner], c, plan);
        if (h) return h;
      }
    }
    return undefined;
  }

  /**
   * The offer an entity's price comes from (memoized per entity object):
   *   • one Offer → it; price from price, else a non-reference priceSpecification, else lowPrice;
   *   • an AggregateOffer → lowPrice (noted when highPrice differs), else price, else its offers;
   *   • several offers → the first, when they all agree; when they disagree, an
   *     AggregateOffer among them, else the first whose price is visible on the
   *     page, else the first — always noted as multiple_offers.
   * Offers given as strings or numbers are not offers.
   */
  private selection(node: Node, families: readonly Family[]): OfferSelection | undefined {
    const key = node.value;
    if (!isPlainObject(key)) return undefined;
    const cached = this.offers.get(key);
    if (cached !== undefined) return cached ?? undefined;
    let sel: OfferSelection | undefined;
    if (families.includes('offer')) sel = this.fromOffer(node, 0);
    else {
      const offers = this.rawChild(node, 'offers');
      sel = offers ? this.fromOffers(offers, 0) : undefined;
    }
    this.offers.set(key, sel ?? null);
    return sel;
  }

  private fromOffers(offers: Node, depth: number): OfferSelection | undefined {
    const v = offers.value;
    if (isPlainObject(v)) return this.fromOffer(this.derefIfRef(offers), depth);
    if (!Array.isArray(v)) return undefined;
    const nodes: Node[] = [];
    for (let i = 0; i < v.length && nodes.length < STRUCTURED_LIMITS.maxOffers; i++) {
      if (isPlainObject(v[i])) nodes.push(this.derefIfRef(indexNode(offers, i)));
    }
    if (nodes.length === 0) return undefined;
    if (nodes.length === 1) return this.fromOffer(nodes[0], depth);
    const sels: OfferSelection[] = [];
    for (const n of nodes) {
      const s = this.fromOffer(n, depth);
      if (s) sels.push(s);
    }
    if (sels.length === 0) return undefined;
    const priced = sels.filter((s) => s.price !== undefined);
    if (priced.length === 0) return sels[0];
    const first = numberOf(priced[0].price!.value);
    const firstCurrency = currencyOf(priced[0].currency);
    const agree = priced.every((s) => {
      const n = numberOf(s.price!.value);
      return n !== undefined && n === first && currencyOf(s.currency) === firstCurrency;
    });
    if (agree) return priced[0];
    const chosen = priced.find((s) => s.aggregate) ?? priced.find((s) => this.page.visible(s.price!.value, 'number')) ?? priced[0];
    return { ...chosen, multiple: true };
  }

  private fromOffer(o: Node, depth: number): OfferSelection | undefined {
    const v = o.value;
    if (!isPlainObject(v)) return undefined;
    const currency = this.leafNode(o, 'priceCurrency', 'text');
    const aggregate = typesOf(v).includes('AggregateOffer') || (!Object.hasOwn(v, 'price') && (Object.hasOwn(v, 'lowPrice') || Object.hasOwn(v, 'highPrice')));
    if (aggregate) {
      const low = this.leafNode(o, 'lowPrice', 'number');
      if (low) {
        const high = this.leafNode(o, 'highPrice', 'number');
        const differs = high !== undefined && numberOf(high.value) !== numberOf(low.value);
        return { offer: o, aggregate: true, price: low, currency, multiple: differs };
      }
      const price = this.leafNode(o, 'price', 'number');
      if (price) return { offer: o, aggregate: true, price, currency, multiple: false };
      const nested = depth < 1 ? this.rawChild(o, 'offers') : undefined;
      const inner = nested ? this.fromOffers(nested, depth + 1) : undefined;
      return inner ?? { offer: o, aggregate: true, currency, multiple: false };
    }
    let price = this.leafNode(o, 'price', 'number');
    let cur = currency;
    if (!price) {
      const spec = this.priceSpec(o, false);
      if (spec) {
        price = spec.price;
        cur ??= spec.currency;
      }
    }
    price ??= this.leafNode(o, 'lowPrice', 'number');
    return { offer: o, aggregate: false, price, currency: cur, multiple: false };
  }

  /**
   * A priceSpecification entry: the current price (no priceType or SalePrice;
   * unit prices with a referenceQuantity skipped) or, with `reference`, an
   * explicitly typed ListPrice / StrikethroughPrice / MSRP / SRP.
   */
  private priceSpec(o: Node, reference: boolean): { price: Node; currency?: Node } | undefined {
    const specs = this.rawChild(o, 'priceSpecification');
    if (!specs) return undefined;
    const list = Array.isArray(specs.value) ? (specs.value as unknown[]) : [specs.value];
    for (let i = 0; i < list.length && i < STRUCTURED_LIMITS.maxPriceSpecs; i++) {
      const n = this.derefIfRef(Array.isArray(specs.value) ? indexNode(specs, i) : specs);
      const sv = n.value;
      if (!isPlainObject(sv)) continue;
      const type = enumTail(own(sv, 'priceType'));
      if (reference) {
        if (type === undefined || !LIST_PRICE_TYPES.has(type)) continue;
      } else {
        if (type !== undefined && type !== 'saleprice') continue;
        if (Object.hasOwn(sv, 'referenceQuantity')) continue;
      }
      const price = this.leafNode(n, 'price', 'number');
      if (price) return { price, currency: this.leafNode(n, 'priceCurrency', 'text') };
    }
    return undefined;
  }

  private leafNode(node: Node, key: string, kind: ValueKind): Node | undefined {
    const child = this.rawChild(node, key);
    return child ? this.scalar(child, kind, 0) : undefined;
  }

  /**
   * baseSalary (or estimatedSalary) as MonetaryAmount: a single value fills
   * salary; a range fills only salaryMin / salaryMax (or salary when both ends
   * are equal). A range is never collapsed into one guessed number.
   */
  private salary(node: Node, which: 'salary' | 'salaryMin' | 'salaryMax', c: Concept, plan: FieldPlan): Hit | undefined {
    for (const key of ['baseSalary', 'estimatedSalary']) {
      let amount = this.rawChild(node, key);
      if (!amount) continue;
      const notes: HitNote[] = [];
      if (Array.isArray(amount.value)) {
        const arr = amount.value;
        const first = arr.findIndex((x) => x !== null && x !== undefined);
        if (first < 0) continue;
        if (arr.length > 1) notes.push('multiple_values');
        amount = indexNode(amount, first);
      }
      const v = amount.value;
      if (!isPlainObject(v)) {
        if (which !== 'salary') continue;
        const h = this.leafHit(amount, c, plan, notes);
        if (h) return h;
        continue;
      }
      const value = this.rawChild(amount, 'value');
      if (value && !isPlainObject(value.value)) {
        if (which !== 'salary') continue;
        const h = this.leafHit(value, c, plan, notes);
        if (h) return h;
        continue;
      }
      // QuantitativeValue under value, or min/max directly on the amount.
      const q = value ?? amount;
      if (which === 'salary') {
        const single = value ? this.rawChild(q, 'value') : undefined;
        if (single) {
          const h = this.leafHit(single, c, plan, notes);
          if (h) return h;
        }
        const min = this.leafNode(q, 'minValue', 'number');
        const max = this.leafNode(q, 'maxValue', 'number');
        if (min && max && numberOf(min.value) === numberOf(max.value)) return this.leafHit(min, c, plan, notes);
        continue;
      }
      const bound = this.rawChild(q, which === 'salaryMin' ? 'minValue' : 'maxValue');
      if (bound) {
        const h = this.leafHit(bound, c, plan, notes);
        if (h) return h;
      }
    }
    return undefined;
  }

  // ── OpenGraph and meta ─────────────────────────────────────

  private flat(entity: Entity, c: Concept, plan: FieldPlan): Hit | undefined {
    const data = entity.node.value as Record<string, unknown>;
    if (entity.flat === 'opengraph') {
      if (c.special === 'price') {
        const key = ogPriceKey(data);
        return key ? this.leafHit(childNode(entity.node, key), c, plan, []) : undefined;
      }
      if (c.special === 'originalPrice') {
        const key = ogOriginalPriceKey(data);
        return key ? this.leafHit(childNode(entity.node, key), c, plan, []) : undefined;
      }
      if (c.special === 'currency') {
        const priceKey = ogPriceKey(data);
        const key = priceKey ? priceKey.replace(/:amount$/, ':currency') : undefined;
        return key && Object.hasOwn(data, key) ? this.leafHit(childNode(entity.node, key), c, plan, []) : undefined;
      }
    }
    const keys = (entity.flat === 'opengraph' ? c.og : c.meta) ?? [];
    for (const key of keys) {
      if (!Object.hasOwn(data, key)) continue;
      const h = this.leafHit(childNode(entity.node, key), c, plan, []);
      if (h) return h;
    }
    return undefined;
  }
}

const OG_PRICE_KEYS = ['product:sale_price:amount', 'product:price:amount', 'og:price:amount'];

function ogPriceKey(data: Record<string, unknown>): string | undefined {
  return OG_PRICE_KEYS.find((k) => typeof own(data, k) === 'string' && isNumericLike(own(data, k) as string));
}

/** Explicit original price, or the regular price when a distinct sale price is published. */
function ogOriginalPriceKey(data: Record<string, unknown>): string | undefined {
  const explicit = 'product:original_price:amount';
  if (typeof own(data, explicit) === 'string' && isNumericLike(own(data, explicit) as string)) return explicit;
  const sale = numberOf(own(data, 'product:sale_price:amount'));
  const regular = numberOf(own(data, 'product:price:amount'));
  return sale !== undefined && regular !== undefined && regular !== sale ? 'product:price:amount' : undefined;
}
