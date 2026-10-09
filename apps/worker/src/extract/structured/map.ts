// Deterministic structured-data mapper: fills customer fields from JSON-LD,
// microdata, embedded JSON, OpenGraph and meta before any model is involved.
//
// Object shape: one primary entity is chosen (type fit for the requested
// fields → content over scaffolding → source quality → page's main entity →
// fields filled → document order). Its record is completed only from
// descriptions of the *same* entity (an agreeing identifier or name, or a
// page-level OpenGraph/meta item that describes it); two different entities
// are never merged.
//
// Array shape: one list is chosen (ItemList / OfferCatalog / search results,
// FAQ questions, reviews, variants, repeated top-level entities, embedded app
// state lists) and every member becomes a record, in order. Without a list,
// only a content entity of a type the requested fields belong to (the
// product of a product page) is a one-record array. Page-level OpenGraph and
// meta never make array records: "Mystery | Books to Scrape" is the title of
// a listing page, not a book. For 'auto' they decide nothing either unless
// they describe the kind of thing the fields ask for (og:type article for an
// author field), or the fields are generic page facts (title, description).
//
// Every value is reported raw, with the structured item id and JSON pointer it
// came from and whether it is visible in the page text. Fields with no
// confident mapping are simply absent: later stages fill them.

import type { NormalizedSchema, SourceDocument, StructuredSource } from '../types.js';
import { isUrlField } from '../validate/normalize.js';
import { CONCEPT_BY_ID, type FieldPlan, type SchemaPlan, planSchema } from './concepts.js';
import { type Discovery, type Entity, type ListCandidate, discover } from './entities.js';
import { type Family, FAMILY_PRIOR, isContentFamily } from './families.js';
import { STRUCTURED_LIMITS } from './limits.js';
import { type Hit, Resolver } from './resolve.js';
import { PageIndex } from './visibility.js';

export interface StructuredFieldValue {
  /** Value exactly as published (the engine normalizes). */
  raw: unknown;
  /** StructuredDataItem id ("sd3"). */
  structuredId: string;
  /** JSON pointer of the value inside that item's data. */
  pointer: string;
  /**
   * The value (or every member of an array value) appears on the rendered
   * page. A schema.org enumeration URL ("https://schema.org/InStock") read
   * into a text field is never visible: the page shows a label, not the URL.
   */
  visibleInPage: boolean;
  /**
   * Enumeration member named by a schema.org URL ("InStock"), for consumers
   * that map enumerations (a boolean "in stock" field).
   */
  enumLabel?: string;
  /** The value was composed from several properties (address parts); their pointers. */
  composedFrom?: string[];
}

export type StructuredRecord = Record<string, StructuredFieldValue>;

export interface StructuredMapResult {
  /** null when nothing was mapped. */
  shape: 'object' | 'array' | null;
  records: StructuredRecord[];
  /** Fields filled in every record, in schema order. */
  filledFields: string[];
  warnings: string[];
  /**
   * The entity a single record (object, or array of one) was read from.
   * `content`: a content family (product, article, job, ...), not page
   * metadata or site scaffolding. `fits`: its type fits the requested fields,
   * or the fields are generic page facts. `listSize`: the entity is one
   * member of a list of this many (an object requested on a listing page).
   * Absent for lists and empty results.
   */
  primary?: { family: Family; content: boolean; fits: boolean; flat: boolean; listSize?: number };
}

const SOURCE_RANK: Readonly<Record<StructuredSource, number>> = {
  'json-ld': 3,
  microdata: 3,
  'embedded-json': 2,
  opengraph: 1,
  meta: 0,
};

export function extractFromStructuredData(doc: SourceDocument, schema: NormalizedSchema): StructuredMapResult {
  try {
    return new Mapper(doc, schema).run();
  } catch (err) {
    // Page data must never fail the extraction; later stages still run. Only
    // the error class is reported: messages can echo page content.
    const kind = err instanceof Error ? err.name : typeof err;
    return { shape: null, records: [], filledFields: [], warnings: [`structured_mapping_failed:${kind}`] };
  }
}

interface Scored {
  readonly entity: Entity;
  /** Requested fields characteristic of the entity's family. */
  readonly fit: number;
  readonly prior: number;
  readonly standalone: number;
  readonly source: number;
  readonly main: number;
  readonly fills: number;
}

interface ScoredList {
  readonly list: ListCandidate;
  readonly records: ReadonlyArray<{ entity: Entity; hits: ReadonlyArray<Hit | undefined> }>;
  readonly fit: number;
  readonly avgFills: number;
}

class Mapper {
  private readonly plan: SchemaPlan;
  private readonly warnings = new Set<string>();
  /** Most requested fields characteristic of any one family (0: generic fields only). */
  private readonly bestFamilyFit: number;
  private page!: PageIndex;
  private d!: Discovery;
  private r!: Resolver;

  constructor(
    private readonly doc: SourceDocument,
    private readonly schema: NormalizedSchema,
  ) {
    this.plan = planSchema(schema);
    const perFamily = new Map<Family, number>();
    for (const f of this.plan.fields) for (const fam of f.fit) perFamily.set(fam, (perFamily.get(fam) ?? 0) + 1);
    this.bestFamilyFit = Math.max(0, ...perFamily.values());
  }

  run(): StructuredMapResult {
    const structured = Array.isArray(this.doc.structured) ? this.doc.structured : [];
    if (this.plan.fields.length === 0 || structured.length === 0) return this.empty();
    this.page = new PageIndex(this.doc);
    this.d = discover(this.doc, this.page);
    this.r = new Resolver(this.d.refs, this.page);

    const all = this.rankCandidates();
    const list = this.bestList();
    const shape = this.schema.shape;

    if (shape === 'array') {
      // A listing of one is a content entity the fields describe; never page-level metadata.
      const single = all.find((c) => c.entity.role !== 'member' && !c.entity.flat && isContentFamily(c.entity.family) && c.fit > 0);
      if (list && (!single || this.listWins(list, single, 'array'))) return this.arrayResult(list);
      return single ? this.arrayOfOne(single, all) : this.empty();
    }
    if (shape === 'object') {
      // OpenGraph/meta stay the fallback record of an explicit object (unverified unless visible).
      const eligible = all.filter((c) => c.entity.flat !== undefined || this.mayBeRecord(c));
      return eligible[0] ? this.objectResult(eligible[0], eligible) : this.empty();
    }
    const candidates = all.filter((c) => this.mayBeRecord(c));
    const primary = candidates[0];
    const standalone = candidates.find((c) => c.entity.role !== 'member');
    // auto: an array only when the page clearly lists ≥ 2 items.
    if (!list || list.records.length < 2) return primary ? this.objectResult(primary, candidates) : this.empty();
    if (!standalone || this.listWins(list, standalone, 'auto')) return this.arrayResult(list);
    return this.objectResult(standalone, candidates);
  }

  /**
   * May a page-level (OpenGraph/meta) entity be the record when the schema
   * does not say object or list? Only when the fields are generic page facts
   * (title, description, image) or the entity is of a type some field is
   * characteristic of (og:type article and an author field). A listing
   * page's og:title next to price/rating fields describes the page, not an
   * item, and would otherwise commit the extraction to one object.
   */
  private flatDescribesRecord(c: Scored): boolean {
    return c.fit > 0 || this.bestFamilyFit === 0;
  }

  /**
   * May this entity be the record of an object / auto schema? Content
   * entities (and unknown types) may. Site scaffolding (Organization,
   * Person, WebSite, WebPage/CollectionPage, lists, navigation) is usually
   * site-wide: the shop's Organization on a product page, a WebSite on a
   * listing. It is the record only when it is the kind of thing the fields
   * describe best (an Organization for name + telephone), or, for a page
   * entity, when the fields are generic page facts, like OpenGraph.
   */
  private mayBeRecord(c: Scored): boolean {
    const e = c.entity;
    if (e.flat) return this.flatDescribesRecord(c);
    if (isContentFamily(e.family) || e.family === 'other') return true;
    if (c.fit > 0) return c.fit >= this.bestFamilyFit;
    return e.family === 'page' && this.bestFamilyFit === 0;
  }

  private primaryInfo(c: Scored): NonNullable<StructuredMapResult['primary']> {
    const family = c.entity.family;
    const info: NonNullable<StructuredMapResult['primary']> = {
      family,
      content: isContentFamily(family),
      fits: c.fit > 0 || this.bestFamilyFit === 0,
      flat: c.entity.flat !== undefined,
    };
    if (c.entity.role === 'member') {
      const list = this.d.lists.find((l) => l.members.includes(c.entity));
      if (list) info.listSize = list.members.length;
    }
    return info;
  }

  /**
   * Listing or standalone entity? The better type fit for the requested
   * fields decides first (reviews vs. their product). Then the page's main
   * entity wins unless it is itself one of the listed items (a detail page
   * with a "related products" list is not a listing). For 'auto', any other
   * content entity also wins (object unless the listing is clear); for an
   * explicit array, ties go to the listing.
   */
  private listWins(list: ScoredList, s: Scored, mode: 'auto' | 'array'): boolean {
    if (mode === 'array' && list.records.length < 2) return list.fit > s.fit;
    if (list.fit !== s.fit) return list.fit > s.fit;
    const ids = this.d.ids;
    if (list.list.members.some((m) => ids.same(m, s.entity))) return !s.entity.main;
    if (s.entity.main) return false;
    if (mode === 'array') return true;
    return !(isContentFamily(s.entity.family) && !s.entity.flat);
  }

  // ── ranking ────────────────────────────────────────────────

  private fitOf(e: Entity): number {
    let fit = 0;
    for (const f of this.plan.fields) if (e.families.some((fam) => f.fit.has(fam))) fit++;
    return fit;
  }

  private fillsOf(e: Entity): number {
    let fills = 0;
    for (const f of this.plan.fields) if (this.r.field(e, f)) fills++;
    return fills;
  }

  private rankCandidates(): Scored[] {
    const out: Scored[] = [];
    const add = (e: Entity) => {
      const fills = this.fillsOf(e);
      if (fills === 0) return;
      out.push({
        entity: e,
        fit: this.fitOf(e),
        prior: Math.max(...e.families.map((f) => FAMILY_PRIOR[f])),
        standalone: e.role === 'member' ? 0 : 1,
        source: SOURCE_RANK[e.source] ?? 0,
        main: e.main ? 1 : 0,
        fills,
      });
    };
    for (const e of this.d.entities) add(e);
    // List members compete too (an object requested on a listing page gets
    // its best item), but rank after standalone entities of equal type fit.
    for (const l of this.d.lists) for (const m of l.members) if (m.role === 'member') add(m);
    return out.sort(
      (a, b) =>
        b.fit - a.fit ||
        b.prior - a.prior ||
        b.standalone - a.standalone ||
        b.source - a.source ||
        b.main - a.main ||
        b.fills - a.fills ||
        a.entity.idx - b.entity.idx,
    );
  }

  private bestList(): ScoredList | undefined {
    let best: ScoredList | undefined;
    for (const list of this.d.lists) {
      const records: Array<{ entity: Entity; hits: Array<Hit | undefined> }> = [];
      let filled = 0;
      for (const m of list.members) {
        const hits = this.plan.fields.map((f) => this.r.field(m, f));
        const n = hits.filter(Boolean).length;
        if (n === 0) continue;
        filled += n;
        records.push({ entity: m, hits });
      }
      if (records.length === 0) continue;
      let fit = 0;
      for (const f of this.plan.fields) if (f.fit.has(list.family)) fit++;
      const scored: ScoredList = { list, records, fit, avgFills: filled / records.length };
      if (!best || compareLists(scored, best) < 0) best = scored;
    }
    return best;
  }

  // ── results ────────────────────────────────────────────────

  private objectResult(primary: Scored, candidates: readonly Scored[]): StructuredMapResult {
    const hits = this.recordHits(primary.entity);
    this.warnAmbiguous(primary, candidates);
    return this.finish('object', [hits], this.primaryInfo(primary));
  }

  private arrayOfOne(primary: Scored, candidates: readonly Scored[]): StructuredMapResult {
    const hits = this.recordHits(primary.entity);
    this.warnAmbiguous(primary, candidates);
    return this.finish('array', [hits], this.primaryInfo(primary));
  }

  private arrayResult(list: ScoredList): StructuredMapResult {
    const max = STRUCTURED_LIMITS.maxRecords;
    if (list.list.truncated || list.records.length > max) this.warnings.add(`structured_records_capped:${max}`);
    return this.finish(
      'array',
      list.records.slice(0, max).map((r) => r.hits),
    );
  }

  private empty(): StructuredMapResult {
    return { shape: null, records: [], filledFields: [], warnings: [...this.warnings] };
  }

  /** The primary entity's own values, completed from other descriptions of the same entity. */
  private recordHits(primary: Entity): Array<Hit | undefined> {
    const hits = this.plan.fields.map((f) => this.r.field(primary, f));
    if (hits.every(Boolean)) return hits;
    const others = this.d.entities.filter((e) => e !== primary && this.describesSame(e, primary));
    for (const f of this.plan.fields) {
      if (hits[f.index]) continue;
      for (const other of others) {
        const h = this.r.field(other, f);
        if (h && this.mayFillFrom(other, primary, h)) {
          hits[f.index] = h;
          break;
        }
      }
    }
    return hits;
  }

  private describesSame(other: Entity, primary: Entity): boolean {
    const ids = this.d.ids;
    if (!other.flat) return !primary.flat && ids.same(other, primary);
    if (primary.flat) return true;
    // og:type article on a product page describes something else.
    if (other.family !== 'page' && !primary.families.includes(other.family)) return false;
    return ids.pageDescribes(other, primary);
  }

  /** Page-level items fill only page-level facts, and only those typical of the primary's family. */
  private mayFillFrom(other: Entity, primary: Entity, hit: Hit): boolean {
    if (!other.flat || primary.flat) return true;
    const concept = CONCEPT_BY_ID.get(hit.concept);
    if (!concept?.pageLevel) return false;
    return !concept.fit || concept.fit.some((f) => primary.families.includes(f));
  }

  private warnAmbiguous(primary: Scored, candidates: readonly Scored[]): void {
    const p = primary.entity;
    if (p.main || p.flat) return;
    const ids = this.d.ids;
    const rival = candidates.some(
      (c) => c !== primary && !c.entity.flat && c.entity.family === p.family && c.fit === primary.fit && !ids.same(c.entity, p),
    );
    if (rival) this.warnings.add(`multiple_entities:${p.types[0] ?? p.family}`);
  }

  private finish(
    shape: 'object' | 'array',
    rows: ReadonlyArray<ReadonlyArray<Hit | undefined>>,
    primary?: StructuredMapResult['primary'],
  ): StructuredMapResult {
    const records: StructuredRecord[] = [];
    for (const hits of rows) {
      const entries: Array<[string, StructuredFieldValue]> = [];
      for (const f of this.plan.fields) {
        const h = hits[f.index];
        if (h) entries.push([f.field.name, this.value(f, h)]);
      }
      // fromEntries defines own properties: a field named "__proto__" stays data.
      if (entries.length > 0) records.push(Object.fromEntries(entries));
    }
    if (records.length === 0) return this.empty();
    const filledFields = this.plan.fields.map((f) => f.field.name).filter((name) => records.every((r) => Object.hasOwn(r, name)));
    const result: StructuredMapResult = { shape, records, filledFields, warnings: [...this.warnings] };
    if (primary) result.primary = primary;
    return result;
  }

  private value(f: FieldPlan, h: Hit): StructuredFieldValue {
    const enumLabel = typeof h.raw === 'string' ? schemaOrgEnumLabel(h.raw) : undefined;
    const field = f.field;
    // A text field would receive the URL itself, which the page never shows
    // (the label "In stock" being visible says nothing about the URL).
    const urlAsText = enumLabel !== undefined && (field.type === 'string' || field.type === 'unknown') && !isUrlField(field);
    const visibleInPage = !urlAsText && this.page.visible(h.raw, h.kind);
    if (!visibleInPage) this.warnings.add(`structured_value_not_visible:${field.name}`);
    for (const note of h.notes) this.warnings.add(note === 'multiple_offers' ? note : `${note}:${field.name}`);
    const out: StructuredFieldValue = { raw: h.raw, structuredId: h.itemId, pointer: h.pointer, visibleInPage };
    if (enumLabel !== undefined) out.enumLabel = enumLabel;
    if (h.composedFrom) out.composedFrom = [...h.composedFrom];
    return out;
  }
}

const SCHEMA_ORG_ENUM = /^https?:\/\/(?:www\.)?schema\.org\/([A-Za-z][A-Za-z0-9]{0,63})$/;

/** "https://schema.org/InStock" → "InStock". */
function schemaOrgEnumLabel(raw: string): string | undefined {
  return SCHEMA_ORG_ENUM.exec(raw.trim())?.[1];
}

function compareLists(a: ScoredList, b: ScoredList): number {
  return (
    b.fit - a.fit ||
    // Fill rates within 5% are a tie: count decides between a 20-item and a 2-item list.
    (Math.abs(b.avgFills - a.avgFills) > 0.05 ? b.avgFills - a.avgFills : 0) ||
    b.records.length - a.records.length ||
    a.list.order - b.list.order
  );
}
