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
// state lists) and every member becomes a record, in order.
//
// Every value is reported raw, with the structured item id and JSON pointer it
// came from and whether it is visible in the page text. Fields with no
// confident mapping are simply absent: later stages fill them.

import type { NormalizedSchema, SourceDocument, StructuredSource } from '../types.js';
import { CONCEPT_BY_ID, type FieldPlan, type SchemaPlan, planSchema } from './concepts.js';
import { type Discovery, type Entity, type ListCandidate, discover } from './entities.js';
import { FAMILY_PRIOR, isContentFamily } from './families.js';
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
  /** The value (or every member of an array value) appears on the rendered page. */
  visibleInPage: boolean;
}

export type StructuredRecord = Record<string, StructuredFieldValue>;

export interface StructuredMapResult {
  /** null when nothing was mapped. */
  shape: 'object' | 'array' | null;
  records: StructuredRecord[];
  /** Fields filled in every record, in schema order. */
  filledFields: string[];
  warnings: string[];
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
  private page!: PageIndex;
  private d!: Discovery;
  private r!: Resolver;

  constructor(
    private readonly doc: SourceDocument,
    private readonly schema: NormalizedSchema,
  ) {
    this.plan = planSchema(schema);
  }

  run(): StructuredMapResult {
    const structured = Array.isArray(this.doc.structured) ? this.doc.structured : [];
    if (this.plan.fields.length === 0 || structured.length === 0) return this.empty();
    this.page = new PageIndex(this.doc);
    this.d = discover(this.doc, this.page);
    this.r = new Resolver(this.d.refs, this.page);

    const candidates = this.rankCandidates();
    const primary = candidates[0];
    const standalone = candidates.find((c) => c.entity.role !== 'member');
    const list = this.bestList();
    const shape = this.schema.shape;

    if (shape === 'object') return primary ? this.objectResult(primary, candidates) : this.empty();
    if (shape === 'array') {
      if (list && (!standalone || this.listWins(list, standalone, 'array'))) return this.arrayResult(list);
      return standalone ? this.arrayOfOne(standalone, candidates) : this.empty();
    }
    // auto: an array only when the page clearly lists ≥ 2 items.
    if (!list || list.records.length < 2) return primary ? this.objectResult(primary, candidates) : this.empty();
    if (!standalone || this.listWins(list, standalone, 'auto')) return this.arrayResult(list);
    return this.objectResult(standalone, candidates);
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
    return this.finish('object', [hits]);
  }

  private arrayOfOne(primary: Scored, candidates: readonly Scored[]): StructuredMapResult {
    const hits = this.recordHits(primary.entity);
    this.warnAmbiguous(primary, candidates);
    return this.finish('array', [hits]);
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

  private finish(shape: 'object' | 'array', rows: ReadonlyArray<ReadonlyArray<Hit | undefined>>): StructuredMapResult {
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
    return { shape, records, filledFields, warnings: [...this.warnings] };
  }

  private value(f: FieldPlan, h: Hit): StructuredFieldValue {
    const visibleInPage = this.page.visible(h.raw, h.kind);
    if (!visibleInPage) this.warnings.add(`structured_value_not_visible:${f.field.name}`);
    for (const note of h.notes) this.warnings.add(note === 'multiple_offers' ? note : `${note}:${f.field.name}`);
    return { raw: h.raw, structuredId: h.itemId, pointer: h.pointer, visibleInPage };
  }
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
