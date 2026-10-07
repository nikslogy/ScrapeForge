// Entity discovery: turns SourceDocument.structured into candidate entities
// (things a record can be read from) and candidate lists (listing pages).
//
//   json-ld / microdata  every item is an entity; mainEntity links add nested
//                        entities; ItemList / OfferCatalog / FAQPage / review
//                        arrays / ProductGroup variants become lists.
//   embedded-json        app state (__NEXT_DATA__, Nuxt, Apollo) is walked
//                        breadth-first within a node budget. schema.org-typed
//                        nodes are taken as is; untyped objects only under a
//                        telling key ("product", "article") with a name that is
//                        visible on the page; arrays only under a listing key
//                        ("products", "results") whose names are mostly visible.
//   opengraph / meta     one flat page-level entity each.
//
// Nothing here reads customer fields; ranking happens in map.ts.

import type { SourceDocument, StructuredDataItem, StructuredSource } from '../types.js';
import { conceptsForName } from './concepts.js';
import { type Family, familiesOf, familyOfOgType, isContentFamily, LISTABLE } from './families.js';
import { STRUCTURED_LIMITS } from './limits.js';
import { containsWords, escapePointerToken, identifierTokens, isPlainObject, nameKey, own, typesOf, urlKey } from './text.js';
import type { PageIndex } from './visibility.js';

export interface Node {
  readonly value: unknown;
  /** StructuredDataItem id the value belongs to. */
  readonly itemId: string;
  /** JSON pointer of the value inside that item's data. */
  readonly pointer: string;
}

export function childNode(node: Node, key: string): Node {
  const v = node.value;
  return { value: isPlainObject(v) ? own(v, key) : undefined, itemId: node.itemId, pointer: `${node.pointer}/${escapePointerToken(key)}` };
}

export function indexNode(node: Node, i: number): Node {
  const v = node.value;
  return { value: Array.isArray(v) ? v[i] : undefined, itemId: node.itemId, pointer: `${node.pointer}/${i}` };
}

export type EntityRole = 'top' | 'nested' | 'member';

export interface Entity {
  /** Discovery order (document order of the structured items). */
  readonly idx: number;
  /** value is always a plain object. */
  readonly node: Node;
  readonly source: StructuredSource;
  readonly types: readonly string[];
  /** Most specific first; never empty. */
  readonly families: readonly Family[];
  readonly family: Family;
  readonly role: EntityRole;
  /** OpenGraph / meta: flat key → string maps describing the page. */
  readonly flat?: 'opengraph' | 'meta';
  /** ListItem around a list member: fallback for name/url/image/position. */
  readonly wrapper?: Node;
  /** Referenced as mainEntity of a page. */
  linkedMain: boolean;
  /** The page's subject among entities of its family (see markMain). */
  main: boolean;
}

export type ListKind = 'itemlist' | 'group' | 'faq' | 'reviews' | 'variants' | 'embedded';

export interface ListCandidate {
  readonly kind: ListKind;
  readonly members: readonly Entity[];
  readonly family: Family;
  readonly order: number;
  /** More members existed than maxRecords. */
  readonly truncated: boolean;
}

/** @id → node, for {"@id": ...} references between JSON-LD nodes (Yoast-style @graph). */
export class RefIndex {
  private readonly map = new Map<string, Node>();

  add(id: string, node: Node): void {
    if (!this.map.has(id)) this.map.set(id, node);
  }

  get(id: unknown): Node | undefined {
    return typeof id === 'string' ? this.map.get(id.trim()) : undefined;
  }
}

/** {"@id": "..."} alone (optionally with @type): a reference, not data. */
export function isRefOnly(v: unknown): v is Record<string, unknown> {
  if (!isPlainObject(v) || typeof own(v, '@id') !== 'string') return false;
  let keys = 0;
  for (const k in v) {
    if (!Object.hasOwn(v, k)) continue;
    if (k !== '@id' && k !== '@type') return false;
    if (++keys > 2) return false;
  }
  return true;
}

export interface Discovery {
  /** Every non-member entity (flat ones included), in discovery order. */
  readonly entities: readonly Entity[];
  readonly lists: readonly ListCandidate[];
  readonly refs: RefIndex;
  readonly og?: Entity;
  readonly meta?: Entity;
  /** nameKey()s of the page <title> and og:title. */
  readonly titles: readonly string[];
  /** urlKey()s of the page URL, canonical and og:url. */
  readonly pageUrls: ReadonlySet<string>;
  readonly ids: Identities;
}

// Untyped embedded objects under these keys are entities of that family.
const ENTITY_HINTS: Record<string, Family> = {
  product: 'product',
  pdp: 'product',
  article: 'article',
  post: 'article',
  story: 'article',
  blogpost: 'article',
  job: 'job',
  jobposting: 'job',
  vacancy: 'job',
  event: 'event',
  recipe: 'recipe',
  book: 'book',
  course: 'course',
};

// Arrays under these keys are listings; 'generic' infers the family from members.
const LIST_HINTS: Record<string, Family | 'generic'> = {
  products: 'product',
  listings: 'generic',
  articles: 'article',
  posts: 'article',
  stories: 'article',
  jobs: 'job',
  vacancies: 'job',
  events: 'event',
  recipes: 'recipe',
  books: 'book',
  courses: 'course',
  items: 'generic',
  results: 'generic',
  hits: 'generic',
  edges: 'generic',
  nodes: 'generic',
  entries: 'generic',
  docs: 'generic',
  records: 'generic',
};

// Container words skipped when reading a key's meaning ("productData" → product).
const KEY_FILLER = new Set(['data', 'info', 'details', 'detail', 'props', 'state', 'query', 'result', 'response', 'payload', 'entity', 'model', 'obj', 'object']);

function keyHint(key: string): string | undefined {
  const tokens = identifierTokens(key).filter((t) => !/^\d+$/.test(t) && !KEY_FILLER.has(t));
  return tokens[tokens.length - 1];
}

const DISPLAY_TYPE: Partial<Record<Family, string>> = {
  product: 'Product',
  article: 'Article',
  job: 'JobPosting',
  event: 'Event',
  recipe: 'Recipe',
  book: 'Book',
  course: 'Course',
};

/** First non-empty name-like string of an object ("name", "title", "productName", ...). */
export function entityName(data: Record<string, unknown>): string | undefined {
  let seen = 0;
  for (const key in data) {
    if (!Object.hasOwn(data, key)) continue;
    if (++seen > STRUCTURED_LIMITS.maxKeysPerObject) break;
    const v = data[key];
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (!t || t.length > 500) continue;
    if (conceptsForName(key).some((c) => c.id === 'name')) return t;
  }
  return undefined;
}

class Discoverer {
  readonly entities: Entity[] = [];
  readonly lists: ListCandidate[] = [];
  readonly refs = new RefIndex();
  og?: Entity;
  meta?: Entity;
  private readonly mainIds = new Set<string>();
  private created = 0;
  private embeddedNodes = 0;
  private embeddedEntities = 0;

  constructor(
    private readonly page: PageIndex,
    private readonly ids: Identities,
  ) {}

  run(items: readonly StructuredDataItem[]): void {
    const roots = new Map<StructuredDataItem, Node[]>();
    for (const item of items) {
      if (!item || (item.source !== 'json-ld' && item.source !== 'microdata')) continue;
      const nodes = schemaNodes({ value: item.data, itemId: String(item.id), pointer: '' });
      roots.set(item, nodes);
      // References may point forward, so index every @id first.
      for (const node of nodes) {
        const id = own(node.value as Record<string, unknown>, '@id');
        if (typeof id === 'string' && id.trim()) this.refs.add(id.trim(), node);
      }
    }
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const root: Node = { value: item.data, itemId: String(item.id), pointer: '' };
      switch (item.source) {
        case 'json-ld':
        case 'microdata': {
          const nodes = roots.get(item) ?? [];
          // item.type stands for the item's own root node only.
          for (const node of nodes) this.addStructured(item.source, node, 'top', 0, false, node.pointer === '' ? item.type : undefined);
          break;
        }
        case 'embedded-json':
          this.walkEmbedded(root);
          break;
        case 'opengraph':
        case 'meta':
          if (isPlainObject(item.data)) this.addFlat(item.source, root);
          break;
        default:
          break;
      }
    }
    for (const e of this.entities) {
      const id = isPlainObject(e.node.value) ? own(e.node.value, '@id') : undefined;
      if (typeof id === 'string' && this.mainIds.has(id.trim())) e.linkedMain = true;
    }
    this.addGroups();
  }

  private makeEntity(source: StructuredSource, node: Node, types: string[], role: EntityRole, extra?: Partial<Entity>): Entity {
    const families = extra?.families ?? familiesOf(types);
    this.created++;
    return {
      idx: this.created,
      node,
      source,
      types,
      families,
      family: families[0],
      role,
      linkedMain: false,
      main: false,
      ...extra,
    };
  }

  private addStructured(source: StructuredSource, node: Node, role: EntityRole, depth: number, linkedMain: boolean, fallbackType?: string): Entity | undefined {
    if (this.created >= STRUCTURED_LIMITS.maxEntities || !isPlainObject(node.value)) return undefined;
    const types = typesOf(node.value);
    if (types.length === 0 && typeof fallbackType === 'string' && fallbackType) types.push(fallbackType);
    const entity = this.makeEntity(source, node, types, role);
    // Breadcrumbs and menus are never the record and never a listing.
    if (entity.families.includes('navigation')) return undefined;
    entity.linkedMain = linkedMain;
    this.entities.push(entity);
    this.findLists(entity, depth);
    return entity;
  }

  private addFlat(source: 'opengraph' | 'meta', node: Node): void {
    const data = node.value as Record<string, unknown>;
    const family: Family = source === 'opengraph' ? familyOfOgType(own(data, 'og:type')) : 'page';
    const entity = this.makeEntity(source, node, [], 'top', { flat: source, families: [family] });
    this.entities.push(entity);
    if (source === 'opengraph') this.og ??= entity;
    else this.meta ??= entity;
  }

  private findLists(entity: Entity, depth: number): void {
    const data = entity.node.value as Record<string, unknown>;
    if (entity.families.includes('list')) this.addMemberList('itemlist', childNode(entity.node, 'itemListElement'), entity);
    if (entity.families.includes('faq')) {
      this.addMemberList('faq', childNode(entity.node, 'mainEntity'), entity);
    } else if (Object.hasOwn(data, 'mainEntity') && depth < STRUCTURED_LIMITS.maxMainEntityDepth) {
      this.followMainEntity(entity, childNode(entity.node, 'mainEntity'), depth);
    }
    if (isContentFamily(entity.family) && Array.isArray(own(data, 'review'))) {
      this.addMemberList('reviews', childNode(entity.node, 'review'), entity);
    }
    if (entity.types.includes('ProductGroup')) this.addMemberList('variants', childNode(entity.node, 'hasVariant'), entity);
  }

  private followMainEntity(entity: Entity, me: Node, depth: number): void {
    const v = me.value;
    if (Array.isArray(v)) {
      // SearchResultsPage / CollectionPage listing their results directly.
      const objects = v.filter(isPlainObject).length;
      if (objects >= 2) this.addMemberList('itemlist', me, entity);
      else if (objects === 1) this.followMainEntity(entity, indexNode(me, v.findIndex(isPlainObject)), depth);
      return;
    }
    if (!isPlainObject(v)) return;
    if (isRefOnly(v)) {
      this.mainIds.add(String(own(v, '@id')).trim());
      return;
    }
    this.addStructured(entity.source, me, 'nested', depth + 1, true);
  }

  /** Members of an itemListElement / mainEntity / review / hasVariant value. */
  private addMemberList(kind: ListKind, elements: Node, container: Entity): void {
    const v = elements.value;
    const list = Array.isArray(v) ? v : isPlainObject(v) ? [v] : [];
    const members: Entity[] = [];
    let truncated = false;
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (!isPlainObject(el)) continue;
      if (members.length >= STRUCTURED_LIMITS.maxRecords || this.created >= STRUCTURED_LIMITS.maxEntities) {
        truncated = true;
        break;
      }
      const elNode = Array.isArray(v) ? indexNode(elements, i) : elements;
      const member = this.memberOf(container.source, elNode);
      if (member && !member.families.includes('navigation')) members.push(member);
    }
    if (members.length === 0) return;
    this.lists.push({ kind, members: sortByPosition(members), family: majorityFamily(members), order: container.idx, truncated });
  }

  private memberOf(source: StructuredSource, elNode: Node): Entity | undefined {
    let el = elNode.value as Record<string, unknown>;
    let node = elNode;
    if (isRefOnly(el)) {
      const target = this.refs.get(own(el, '@id'));
      if (!target || !isPlainObject(target.value)) return undefined;
      node = target;
      el = target.value;
    }
    const types = typesOf(el);
    const isListItem = types.includes('ListItem') || (types.length === 0 && Object.hasOwn(el, 'item'));
    if (!isListItem) return this.makeEntity(source, node, types, 'member');
    const item = own(el, 'item');
    if (isPlainObject(item)) {
      let itemNode = childNode(node, 'item');
      if (isRefOnly(item)) {
        const target = this.refs.get(own(item, '@id'));
        if (target && isPlainObject(target.value)) itemNode = target;
      }
      return this.makeEntity(source, itemNode, typesOf(itemNode.value as Record<string, unknown>), 'member', { wrapper: node });
    }
    // A ListItem that only carries name/url/position (Google summary carousels).
    return this.makeEntity(source, node, types, 'member');
  }

  /** ≥ 2 top-level entities of one listable family from one source form a listing. */
  private addGroups(): void {
    const groups = new Map<string, Entity[]>();
    // The same thing can be described twice (inline mainEntity + top-level
    // copy). Deduplicated by signature, not pairwise: groups can be large.
    const seenValues = new Set<unknown>();
    const seenKeys = new Set<string>();
    for (const e of this.entities) {
      if (e.flat || e.role === 'member' || !LISTABLE.has(e.family)) continue;
      if (seenValues.has(e.node.value)) continue;
      seenValues.add(e.node.value);
      const groupKey = `${e.source}|${e.family}`;
      const signature = this.ids.signature(e);
      if (signature !== undefined) {
        const key = `${groupKey}|${signature}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
      }
      const group = groups.get(groupKey);
      if (group) group.push(e);
      else groups.set(groupKey, [e]);
    }
    for (const [, group] of groups) {
      if (group.length < 2) continue;
      this.lists.push({ kind: 'group', members: group.slice(0, STRUCTURED_LIMITS.maxRecords), family: group[0].family, order: group[0].idx, truncated: group.length > STRUCTURED_LIMITS.maxRecords });
    }
  }

  // ── embedded JSON ──────────────────────────────────────────

  private walkEmbedded(root: Node): void {
    interface Pending {
      node: Node;
      key: string;
      depth: number;
      inArray: boolean;
    }
    const queue: Pending[] = [{ node: root, key: '', depth: 0, inArray: false }];
    const perItem = STRUCTURED_LIMITS.maxEmbeddedNodesPerItem;
    for (let qi = 0, visited = 0; qi < queue.length; qi++) {
      if (++visited > perItem || ++this.embeddedNodes > STRUCTURED_LIMITS.maxEmbeddedNodesTotal) break;
      const { node, key, depth, inArray } = queue[qi];
      const v = node.value;
      const canPush = depth < STRUCTURED_LIMITS.maxEmbeddedDepth && queue.length < perItem * 2;
      if (Array.isArray(v)) {
        if (!inArray) this.embeddedList(node, key);
        const n = Math.min(v.length, STRUCTURED_LIMITS.maxArrayFanOut);
        for (let i = 0; i < n && canPush; i++) {
          if (v[i] !== null && typeof v[i] === 'object') queue.push({ node: indexNode(node, i), key, depth: depth + 1, inArray: true });
        }
        continue;
      }
      if (!isPlainObject(v)) continue;
      // A recognized entity's own properties are not walked for more entities.
      if (this.embeddedEntity(node, key, inArray)) continue;
      let keys = 0;
      for (const k in v) {
        if (!Object.hasOwn(v, k)) continue;
        if (++keys > STRUCTURED_LIMITS.maxKeysPerObject || !canPush) break;
        const c = v[k];
        if (c !== null && typeof c === 'object') queue.push({ node: childNode(node, k), key: k, depth: depth + 1, inArray: false });
      }
    }
  }

  /** True when the object became an entity. */
  private embeddedEntity(node: Node, key: string, inArray: boolean): boolean {
    if (this.embeddedEntities >= STRUCTURED_LIMITS.maxEmbeddedEntities) return false;
    const data = node.value as Record<string, unknown>;
    const types = typesOf(data);
    if (types.length > 0) {
      // schema.org data kept in app state (often a copy of the page's JSON-LD).
      const families = familiesOf(types);
      if (families[0] === 'other') return false;
      this.embeddedEntities++;
      return this.addStructured('embedded-json', node, 'top', 0, false) !== undefined;
    }
    if (inArray) return false;
    const hint = keyHint(key);
    const family = hint !== undefined && Object.hasOwn(ENTITY_HINTS, hint) ? ENTITY_HINTS[hint] : undefined;
    if (!family) return false;
    const name = entityName(data);
    if (!name || !this.visibleName(name)) return false;
    this.embeddedEntities++;
    this.entities.push(this.makeEntity('embedded-json', node, [DISPLAY_TYPE[family] ?? family], 'top', { families: [family] }));
    return true;
  }

  private embeddedList(node: Node, key: string): void {
    const arr = node.value as unknown[];
    if (arr.length < 2 || this.embeddedEntities >= STRUCTURED_LIMITS.maxEmbeddedEntities) return;
    const hint = keyHint(key);
    const listHint = hint !== undefined && Object.hasOwn(LIST_HINTS, hint) ? LIST_HINTS[hint] : undefined;
    if (!listHint) return;
    const nodes: Node[] = [];
    let truncated = false;
    for (let i = 0; i < arr.length; i++) {
      if (nodes.length >= STRUCTURED_LIMITS.maxRecords) {
        truncated = true;
        break;
      }
      const el = arr[i];
      if (!isPlainObject(el)) continue;
      // GraphQL connections: edges: [{ node: {...} }]
      const inner = own(el, 'node');
      const n = isPlainObject(inner) ? childNode(indexNode(node, i), 'node') : indexNode(node, i);
      if (entityName(n.value as Record<string, unknown>)) nodes.push(n);
    }
    if (nodes.length < 2) return;
    if (this.page.substantial) {
      // Only the page's own listing: app state also carries menus, carts and recommendations.
      const sample = nodes.slice(0, STRUCTURED_LIMITS.embeddedListSample);
      const visible = sample.filter((n) => this.page.hasText(entityName(n.value as Record<string, unknown>)!)).length;
      if (visible / sample.length < STRUCTURED_LIMITS.embeddedListVisibleRatio) return;
    }
    const family = listHint === 'generic' ? inferFamily(nodes[0].value as Record<string, unknown>) : listHint;
    const members = nodes.map((n) => this.makeEntity('embedded-json', n, [DISPLAY_TYPE[family] ?? family], 'member', { families: [family] }));
    this.embeddedEntities += members.length;
    this.lists.push({ kind: 'embedded', members, family, order: this.created, truncated });
  }

  private visibleName(name: string): boolean {
    // On a script shell (client-rendered page) nothing is visible yet; the
    // engine still sees every value flagged as not visible.
    return !this.page.substantial || this.page.hasText(name);
  }
}

const MAX_GRAPH_NODES = 1_000;

/**
 * The schema.org nodes of one item: the item itself, or the members of an
 * unflattened @graph / top-level array (buildSourceDocument flattens these,
 * but the mapper must not depend on it).
 */
function schemaNodes(root: Node): Node[] {
  const out: Node[] = [];
  const queue: Node[] = [root];
  for (let qi = 0; qi < queue.length && out.length < MAX_GRAPH_NODES && qi < MAX_GRAPH_NODES * 2; qi++) {
    const node = queue[qi];
    const v = node.value;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length && queue.length < MAX_GRAPH_NODES * 2; i++) queue.push(indexNode(node, i));
    } else if (isPlainObject(v)) {
      const graph = own(v, '@graph');
      if (Array.isArray(graph) || isPlainObject(graph)) {
        // A typed container keeps its own properties as a node of its own.
        if (own(v, '@type') !== undefined) out.push(node);
        queue.push(childNode(node, '@graph'));
      } else {
        out.push(node);
      }
    }
  }
  return out;
}

function inferFamily(sample: Record<string, unknown>): Family {
  const ids = new Set<string>();
  let seen = 0;
  for (const key in sample) {
    if (!Object.hasOwn(sample, key)) continue;
    if (++seen > STRUCTURED_LIMITS.maxKeysPerObject) break;
    for (const c of conceptsForName(key)) ids.add(c.id);
  }
  if (ids.has('price') || ids.has('originalPrice') || ids.has('sku')) return 'product';
  if (ids.has('salary') || ids.has('company')) return 'job';
  if (ids.has('startDate')) return 'event';
  if (ids.has('datePublished') || ids.has('author')) return 'article';
  return 'other';
}

function majorityFamily(members: readonly Entity[]): Family {
  const counts = new Map<Family, number>();
  let best: Family = members[0].family;
  for (const m of members) {
    const n = (counts.get(m.family) ?? 0) + 1;
    counts.set(m.family, n);
    if (n > (counts.get(best) ?? 0)) best = m.family;
  }
  return best;
}

function positionOf(e: Entity): number | undefined {
  const holder = (e.wrapper?.value ?? e.node.value) as Record<string, unknown>;
  const p = isPlainObject(holder) ? own(holder, 'position') : undefined;
  const n = typeof p === 'number' ? p : typeof p === 'string' && /^\s*\d{1,9}\s*$/.test(p) ? Number(p) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Explicit ListItem positions win over array order when every member has a distinct one. */
function sortByPosition(members: Entity[]): Entity[] {
  const positions = members.map(positionOf);
  if (positions.some((p) => p === undefined) || new Set(positions).size !== positions.length) return members;
  return members
    .map((m, i) => ({ m, p: positions[i]! }))
    .sort((a, b) => a.p - b.p)
    .map((x) => x.m);
}

export function discover(doc: SourceDocument, page: PageIndex): Discovery {
  const ids = new Identities(typeof doc.url === 'string' ? doc.url : undefined);
  const d = new Discoverer(page, ids);
  d.run(Array.isArray(doc.structured) ? doc.structured : []);
  const titles: string[] = [];
  const pageUrls = new Set<string>();
  const addUrl = (u: unknown) => {
    const k = typeof u === 'string' ? urlKey(u, doc.url) : undefined;
    if (k) pageUrls.add(k);
  };
  if (typeof doc.title === 'string' && doc.title.trim()) titles.push(nameKey(doc.title));
  addUrl(doc.url);
  if (d.og) {
    const og = d.og.node.value as Record<string, unknown>;
    const ogTitle = own(og, 'og:title');
    if (typeof ogTitle === 'string' && ogTitle.trim()) titles.push(nameKey(ogTitle));
    addUrl(own(og, 'og:url'));
  }
  if (d.meta) addUrl(own(d.meta.node.value as Record<string, unknown>, 'canonical'));
  const discovery: Discovery = { entities: d.entities, lists: d.lists, refs: d.refs, og: d.og, meta: d.meta, titles, pageUrls, ids };
  markMain(discovery, typeof doc.url === 'string' ? doc.url : '');
  return discovery;
}

// ─────────────────────────────────────────────────────────────
// Identity: are two entities the same real-world thing?
// ─────────────────────────────────────────────────────────────

type IdentityKey = 'id' | 'sku' | 'gtin' | 'mpn' | 'productId' | 'isbn' | 'url';

interface Identity {
  keys: Partial<Record<IdentityKey, string>>;
  /** nameKey() of the entity's name (og:title for OpenGraph). */
  name?: string;
}

function scalarString(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t && t.length <= 2048 ? t : undefined;
}

/** Identity keys per entity, resolved against one page URL and cached for one mapping run. */
export class Identities {
  private readonly cache = new WeakMap<Entity, Identity>();

  constructor(private readonly base: string | undefined) {}

  of(e: Entity): Identity {
    const cached = this.cache.get(e);
    if (cached) return cached;
    const identity = this.compute(e);
    this.cache.set(e, identity);
    return identity;
  }

  name(e: Entity): string | undefined {
    return this.of(e).name;
  }

  /**
   * Same thing described twice (JSON-LD + microdata, an inline copy of an @id
   * node). Conservative: a conflicting identifier means different, and at
   * least one identifier or the exact name must agree.
   */
  same(a: Entity, b: Entity): boolean {
    if (a === b || a.node.value === b.node.value) return true;
    if (a.flat || b.flat) return false;
    if (!a.families.some((f) => b.families.includes(f))) return false;
    const ia = this.of(a);
    const ib = this.of(b);
    let strong = false;
    let weak = false;
    for (const k of Object.keys(ia.keys) as IdentityKey[]) {
      const va = ia.keys[k];
      const vb = ib.keys[k];
      if (va === undefined || vb === undefined) continue;
      if (va !== vb) return false;
      // Lazy markup gives every product the page URL: a shared URL is weak evidence.
      if (k === 'url') weak = true;
      else strong = true;
    }
    if (ia.name && ib.name) {
      if (ia.name === ib.name) return true;
      // Different names: the same thing only under an agreeing identifier (a renamed copy).
      return strong;
    }
    return strong || weak;
  }

  /** Strongest identifier as a dedup key: @id, sku, gtin, or url + name. */
  signature(e: Entity): string | undefined {
    const { keys, name } = this.of(e);
    if (keys.id) return `id:${keys.id}`;
    if (keys.sku) return `sku:${keys.sku}`;
    if (keys.gtin) return `gtin:${keys.gtin}`;
    if (keys.url) return `url:${keys.url}|${name ?? ''}`;
    return undefined;
  }

  /** Does a page-level (OpenGraph/meta) entity describe this entity? */
  pageDescribes(page: Entity, e: Entity): boolean {
    if (e.main) return true;
    const ip = this.of(page);
    const ie = this.of(e);
    if (ip.keys.url && ie.keys.url && ip.keys.url === ie.keys.url) return true;
    if (ip.keys.sku && ie.keys.sku && ip.keys.sku === ie.keys.sku) return true;
    // og:title usually carries a site suffix: "A Light in the Attic | Books to Scrape".
    return ip.name !== undefined && ie.name !== undefined && ie.name.length >= 3 && containsWords(ip.name, ie.name);
  }

  private compute(e: Entity): Identity {
    const data = e.node.value as Record<string, unknown>;
    const keys: Identity['keys'] = {};
    const set = (k: IdentityKey, v: string | undefined) => {
      if (v) keys[k] = v;
    };
    let name: string | undefined;
    const url = (v: unknown) => {
      const s = scalarString(v);
      return s ? urlKey(s, this.base) : undefined;
    };
    if (e.flat === 'opengraph') {
      set('url', url(own(data, 'og:url')));
      set('sku', scalarString(own(data, 'product:retailer_item_id'))?.toLowerCase());
      name = scalarString(own(data, 'og:title'));
    } else if (e.flat === 'meta') {
      set('url', url(own(data, 'canonical')));
    } else {
      const id = scalarString(own(data, '@id'));
      if (id && !id.startsWith('_:')) set('id', id);
      set('sku', scalarString(own(data, 'sku'))?.toLowerCase());
      for (const g of ['gtin', 'gtin13', 'gtin12', 'gtin14', 'gtin8']) {
        // GTINs are published with and without leading zeros.
        const digits = scalarString(own(data, g))?.replace(/\D/g, '').replace(/^0+/, '');
        if (digits) {
          set('gtin', digits);
          break;
        }
      }
      set('mpn', scalarString(own(data, 'mpn'))?.toLowerCase());
      set('productId', scalarString(own(data, 'productID'))?.toLowerCase());
      set('isbn', scalarString(own(data, 'isbn'))?.replace(/[^\dXx]/g, '').toUpperCase());
      set('url', url(own(data, 'url')));
      for (const k of ['name', 'headline', 'title']) {
        name = scalarString(own(data, k));
        if (name) break;
      }
      name ??= entityName(data);
    }
    const key = name ? nameKey(name) : '';
    return key ? { keys, name: key } : { keys };
  }
}

// ─────────────────────────────────────────────────────────────
// Main entity: what the page is about, per family
// ─────────────────────────────────────────────────────────────

function mainEntityOfPageKey(e: Entity, base: string): string | undefined {
  const v = own(e.node.value as Record<string, unknown>, 'mainEntityOfPage');
  const raw = typeof v === 'string' ? v : isPlainObject(v) ? (own(v, '@id') ?? own(v, 'url')) : undefined;
  return typeof raw === 'string' && !raw.includes('#') ? urlKey(raw, base) : undefined;
}

/**
 * Marks at most one entity (plus its duplicates) per content family as the
 * page's main entity, using the strongest unambiguous signal: an explicit
 * mainEntity link, then a URL equal to the page URL, then the longest name
 * contained in the page title.
 */
function markMain(d: Discovery, base: string): void {
  const ids = d.ids;
  const byFamily = new Map<Family, Entity[]>();
  for (const e of d.entities) {
    if (e.flat || !isContentFamily(e.family)) continue;
    const list = byFamily.get(e.family);
    if (list) list.push(e);
    else byFamily.set(e.family, [e]);
  }
  for (const [, group] of byFamily) {
    const tiers: Array<(e: Entity) => boolean> = [
      (e) => e.linkedMain,
      (e) => {
        const id = ids.of(e);
        const mep = mainEntityOfPageKey(e, base);
        return (id.keys.url !== undefined && d.pageUrls.has(id.keys.url)) || (mep !== undefined && d.pageUrls.has(mep));
      },
    ];
    let chosen: Entity[] | undefined;
    for (const tier of tiers) {
      chosen = unique(group.filter(tier), ids);
      if (chosen) break;
    }
    chosen ??= byTitle(group, d.titles, ids);
    for (const e of chosen ?? []) e.main = true;
  }
}

/** All hits when they are one entity (duplicates included); undefined when none or ambiguous. */
function unique(hits: Entity[], ids: Identities): Entity[] | undefined {
  if (hits.length === 0) return undefined;
  return hits.every((h) => ids.same(h, hits[0])) ? hits : undefined;
}

function byTitle(group: Entity[], titles: readonly string[], ids: Identities): Entity[] | undefined {
  let best = 0;
  let hits: Entity[] = [];
  for (const e of group) {
    const name = ids.name(e);
    if (!name || name.length < 3 || !titles.some((t) => containsWords(t, name))) continue;
    if (name.length > best) {
      best = name.length;
      hits = [e];
    } else if (name.length === best) {
      hits.push(e);
    }
  }
  return unique(hits, ids);
}
