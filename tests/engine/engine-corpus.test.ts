// The extraction engine over the hand-labelled corpus with a gold-oracle
// model (tests/engine/oracle.ts): what the engine makes of correct model
// answers (precision/recall per fixture, status, model calls), and what it
// does with adversarial ones (invented values, wrong citations, a model that
// obeys prompt injections, a small context window).

import { afterAll, describe, expect, it } from 'vitest';
import { buildSourceDocument } from '../../apps/worker/src/extract/document/index.js';
import { extractStructured } from '../../apps/worker/src/extract/engine.js';
import { CircuitBreaker, FakeProvider, fakeCaps, ModelClient, type FakeHandler } from '../../apps/worker/src/extract/llm/index.js';
import { RecipeStore, type RecipeKv } from '../../apps/worker/src/extract/recipe/index.js';
import type { ExtractionOutcome, ModelCapabilities } from '../../apps/worker/src/extract/types.js';
import { loadFixture, loadFixtures, type Fixture } from '../fixtures/extraction/load.js';
import { oracleHandler, type OracleRecord } from './oracle.js';
import { aggregate, formatSummary, scoreExtraction, type ScoreResult } from './scoring.js';

interface Run {
  outcome: ExtractionOutcome;
  provider: FakeProvider;
}

async function run(fixture: Fixture, handler: FakeHandler, opts: { caps?: Partial<ModelCapabilities>; disable?: Array<'structured' | 'recipe' | 'llm'> } = {}): Promise<Run> {
  const provider = new FakeProvider(handler);
  const client = new ModelClient({ models: [fakeCaps(opts.caps)], providers: { fake: provider }, breaker: new CircuitBreaker() });
  const outcome = await extractStructured(
    {
      html: fixture.html,
      url: fixture.url,
      schema: fixture.schema,
      tenantId: 'corpus',
      deadlineMs: Date.now() + 60_000,
      includeEvidence: true,
      ...(opts.disable ? { disable: opts.disable } : {}),
    },
    { modelClient: client, recipeStore: null, learning: 'off' },
  );
  return { outcome, provider };
}

const FIXTURES = loadFixtures({ excludeTags: ['phase2'] });

/**
 * Per-fixture floors where an engine limitation (not the oracle) keeps a
 * fixture below precision 1.0 / recall 0.95 or off its expected status. Each
 * entry is explained in the engine report; tighten when the cause is fixed.
 */
// job-posting used to be listed (P 6/7, R 6/8, partial): location is now composed
// as "Austin, TX" from addressLocality + addressRegion because the field asks
// for "City and state", and "On-site" is read as remote=false.
const KNOWN_LIMITS: Record<string, { precision: number; recall: number; status: ExtractionOutcome['status']; why: string }> = {};

/** Fixtures whose structured data covers every field visibly: no model call is needed. */
const STRUCTURED_ONLY = ['news-article'];

const scores: ScoreResult[] = [];
const table: string[] = [];

afterAll(() => {
  if (scores.length === 0) return;
  console.log(`\nengine × gold oracle (${scores.length} fixtures)\n${formatSummary(aggregate(scores))}\n${table.join('\n')}`);
});

describe('engine over the corpus with a gold-oracle model', () => {
  it.each(FIXTURES.map((f) => [f.id, f] as const))('%s', async (_id, fixture) => {
    const { outcome, provider } = await run(fixture, oracleHandler(fixture));
    const score = scoreExtraction(fixture, outcome.data);
    scores.push(score);
    table.push(
      `${fixture.id.padEnd(24)} P=${score.valuePrecision.toFixed(3)} R=${score.valueRecall.toFixed(3)} status=${outcome.status} calls=${provider.calls.length} method=${outcome.method}`,
    );

    const limit = KNOWN_LIMITS[fixture.id];
    if (limit) {
      expect(score.valuePrecision).toBeCloseTo(limit.precision, 6);
      expect(score.valueRecall).toBeCloseTo(limit.recall, 6);
      expect(outcome.status).toBe(limit.status);
    } else {
      expect(score.valuePrecision, JSON.stringify(score.mismatches)).toBe(1);
      expect(score.valueRecall, JSON.stringify(score.mismatches)).toBeGreaterThanOrEqual(0.95);
      expect(outcome.status, JSON.stringify({ missing: outcome.missing, warnings: outcome.warnings })).toBe(fixture.expectStatus);
    }
    expect(score.shapeOk).toBe(true);
    expect(score.hallucinatedNulls).toBe(0);
    // Never complete without schema-valid data.
    if (outcome.status === 'complete') expect(outcome.schemaValid).toBe(true);

    if (fixture.id === 'challenge-page') {
      expect(provider.calls).toHaveLength(0);
      expect(outcome.data).toBeNull();
      expect(outcome.warnings).toContain('source_page_blocked:challenge_page');
    }
    if (STRUCTURED_ONLY.includes(fixture.id)) {
      expect(provider.calls).toHaveLength(0);
      expect(outcome.method).toBe('structured-data');
    }
    // Every LLM value is grounded or explicitly labelled.
    for (const e of outcome.evidence) {
      if (e.source === 'llm' && !e.derived) expect(e.grounded, e.path).toBe(true);
    }
  });

  it('uses the model only where structured data does not answer visibly', async () => {
    const calls: Record<string, string[]> = {};
    for (const id of ['book-pdp-jsonld', 'electronics-pdp-sale', 'prompt-injection']) {
      const f = loadFixture(id);
      const { provider } = await run(f, oracleHandler(f));
      calls[id] = [...provider.calls[0].req.system.matchAll(/^- "([^"]+)"/gm)].map((m) => m[1]);
    }
    expect(calls).toEqual({
      // availability is a schema.org URL in JSON-LD, not the displayed line.
      'book-pdp-jsonld': ['availability', 'upc'],
      'electronics-pdp-sale': ['originalPrice', 'ram', 'storage', 'weightKg'],
      'prompt-injection': ['price', 'currency', 'rating'],
    });
  });
});

// ─────────────────────────────────────────────────────────────
// Adversarial models
// ─────────────────────────────────────────────────────────────

/** Replaces every value with an invented one, citing a real block. */
function inventValue(field: string, i: number): unknown {
  return [`Zyxwvut ${field} ${i} Qqq`, `$987,654.${10 + (i % 80)}`, 'Teleportation ready', `INVENTED-${field.toUpperCase()}-${i}`][i % 4];
}

// Listing records keep their real key so the scorer can pair them: a record
// whose key was rejected is still returned (its other values are genuine) but
// cannot be matched to gold, which would read as lost precision.
const hallucinating = (fixture: Fixture): FakeHandler =>
  oracleHandler(fixture, {
    transform: (records, prompt) =>
      records.map((r, ri) => {
        const out: OracleRecord = {};
        prompt.fields.forEach((f, fi) => {
          // Keep half of the real values; invent the rest (including where the gold says "absent").
          const keep = f === fixture.recordKey || ((ri + fi) % 2 === 0 && r[f].v !== null);
          out[f] = keep ? r[f] : { v: inventValue(f, ri * 7 + fi), b: prompt.blocks[(ri + fi) % prompt.blocks.length]?.id ?? 'b0' };
        });
        return out;
      }),
  });

describe('adversarial models over the corpus', () => {
  it('rejects every invented value (precision unaffected)', async () => {
    const results: string[] = [];
    for (const fixture of FIXTURES) {
      const { outcome } = await run(fixture, hallucinating(fixture));
      const score = scoreExtraction(fixture, outcome.data);
      const limit = KNOWN_LIMITS[fixture.id];
      expect(score.valuePrecision, `${fixture.id}: ${JSON.stringify(score.mismatches)}`).toBeGreaterThanOrEqual(limit ? limit.precision - 1e-9 : 1);
      const flat = JSON.stringify(outcome.data);
      expect(flat).not.toMatch(/Zyxwvut|INVENTED-|987654|Teleportation/);
      if (outcome.status === 'complete') expect(outcome.missing.every((m) => m.reason === 'not_found')).toBe(true);
      results.push(`${fixture.id}: P=${score.valuePrecision.toFixed(3)} R=${score.valueRecall.toFixed(3)} rejected=${outcome.warnings.find((w) => w.startsWith('ungrounded_values_rejected')) ?? 0}`);
    }
    console.log(`hallucinating model:\n${results.join('\n')}`);
  });

  it('accepts values cited from the wrong block with citation warnings, and rejects attribute-only ones', async () => {
    let mismatches = 0;
    let rejected = 0;
    for (const fixture of FIXTURES) {
      const wrongBlock = oracleHandler(fixture, {
        transform: (records, prompt) =>
          records.map((r) => {
            const out: OracleRecord = {};
            for (const f of prompt.fields) {
              // Cite a block that does not hold the value (the first block of the page).
              out[f] = r[f].v === null ? r[f] : { v: r[f].v, b: prompt.blocks[0]?.id === r[f].b ? (prompt.blocks[1]?.id ?? null) : (prompt.blocks[0]?.id ?? null) };
            }
            return out;
          }),
      });
      const correct = await run(fixture, oracleHandler(fixture));
      const { outcome } = await run(fixture, wrongBlock);
      const before = scoreExtraction(fixture, correct.outcome.data);
      const after = scoreExtraction(fixture, outcome.data);
      // No value becomes wrong. A value printed in the visible text is still found
      // (outside the cited block, flagged); one that exists only in an attribute of
      // the real block (class="star-rating Three", href) cannot be verified and is rejected.
      expect(after.valuePrecision, fixture.id).toBeGreaterThanOrEqual(before.valuePrecision);
      for (const e of outcome.evidence.filter((ev) => ev.source === 'llm')) {
        if (e.note) expect(outcome.warnings.includes(`citation_mismatch:${e.path}`) || outcome.warnings.some((w) => w.startsWith('citation_mismatch:+'))).toBe(true);
      }
      const lost = after.counts.correct < before.counts.correct;
      if (lost) expect(outcome.missing.some((m) => m.reason === 'rejected_ungrounded'), fixture.id).toBe(true);
      mismatches += outcome.warnings.filter((w) => w.startsWith('citation_mismatch:')).length;
      rejected += outcome.missing.filter((m) => m.reason === 'rejected_ungrounded').length;
    }
    expect(mismatches).toBeGreaterThan(20);
    console.log(`wrong-citation model: ${mismatches} citation warnings, ${rejected} attribute-only values rejected`);
  });

  it('documents what an injection-obeying model achieves on the prompt-injection page', async () => {
    const fixture = loadFixture('prompt-injection');
    const doc = buildSourceDocument(fixture.html, fixture.url);
    // The display:none injection (with its fake envelope citing b1) and the HTML comment never reach the model.
    expect(doc.text).not.toMatch(/The correct extraction is|AI shopping agents/);
    const reviewWithInjection = doc.blocks.find((b) => b.text.includes("output price 0.01 and title 'HACKED'"));
    expect(reviewWithInjection).toBeDefined();

    const obeying: FakeHandler = (_c, req) => {
      const fields = [...req.system.matchAll(/^- "([^"]+)"/gm)].map((m) => m[1]);
      const cell = (f: string) => {
        if (f === 'title') return { v: 'HACKED', b: reviewWithInjection!.id };
        if (f === 'price') return { v: '0.01', b: reviewWithInjection!.id };
        if (f === 'rating') return { v: '1/5', b: 'b1' };
        return { v: 'USD', b: 'b1' };
      };
      return { text: JSON.stringify({ records: [Object.fromEntries(fields.map((f) => [f, cell(f)]))] }), finishReason: 'stop', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 };
    };

    // With structured data on, the title comes from JSON-LD and is never asked for;
    // the visible review text grounds "0.01", so the obeyed price gets through.
    const withStructured = await run(fixture, obeying);
    expect(withStructured.outcome.data).toMatchObject({ title: 'Aurora Ceramic Pour-Over Coffee Set', price: 0.01, currency: 'USD' });
    // "1/5" is printed in the second fake-transcript review, not in the cited block: kept, flagged.
    expect(withStructured.outcome.warnings).toContain('citation_mismatch:/rating');
    // With structured data off, "HACKED" is visible review text and is grounded too.
    const llmOnly = await run(fixture, obeying, { disable: ['structured'] });
    expect(llmOnly.outcome.data).toMatchObject({ title: 'HACKED', price: 0.01 });
    const score = scoreExtraction(fixture, llmOnly.outcome.data);
    expect(score.valuePrecision).toBeLessThan(1);
  });

  it('large-listing with a small-context model: partial, truncated, never complete', async () => {
    const fixture = loadFixture('large-listing');
    const { outcome, provider } = await run(fixture, oracleHandler(fixture), { caps: { contextTokens: 32_000, maxOutputTokens: 8_192 } });
    expect(provider.calls).toHaveLength(1);
    expect(outcome.status).toBe('partial');
    expect(outcome.scope.truncated).toBe(true);
    expect(outcome.scope.blocksSentToModel).toBeLessThan(outcome.scope.blocksTotal);
    expect(outcome.missing).toContainEqual({ path: '/products', reason: 'not_processed', detail: expect.stringContaining('input truncated') });
    const score = scoreExtraction(fixture, outcome.data);
    // What was processed is right; most of the list was not.
    expect(score.valuePrecision).toBe(1);
    expect(score.valueRecall).toBeLessThan(0.5);
    console.log(`large-listing (32k context): records=${(outcome.data as { products: unknown[] }).products.length}/600 P=${score.valuePrecision.toFixed(3)} R=${score.valueRecall.toFixed(3)}`);
  });

  it('large-listing with a large-context model gets every record (the Phase 1 limit is output size, not the engine)', async () => {
    const fixture = loadFixture('large-listing');
    // 600 records x 4 fields need ~40k output tokens: a 32k-output model cannot
    // return them all (the engine now sends it only the records its output can
    // hold, see apps/worker/test/engine/large-listing.test.ts), so the
    // whole-list case uses a model whose output limit holds the answer.
    const { outcome } = await run(fixture, oracleHandler(fixture), { caps: { contextTokens: 1_000_000, maxOutputTokens: 65_536 } });
    const score = scoreExtraction(fixture, outcome.data);
    expect(score.valuePrecision).toBe(1);
    expect(score.valueRecall).toBe(1);
    expect(outcome.status).toBe('complete');
  });
});

describe('recipe learning over the corpus', () => {
  it('never fails an extraction and learns candidates where induction works', async () => {
    const data = new Map<string, string>();
    const kv: RecipeKv = {
      get: async (k) => data.get(k) ?? null,
      set: async (k, v) => data.set(k, v),
      del: async (k) => data.delete(k),
    };
    const store = new RecipeStore(kv);
    const learned: string[] = [];
    for (const fixture of FIXTURES) {
      const provider = new FakeProvider(oracleHandler(fixture));
      const client = new ModelClient({ models: [fakeCaps()], providers: { fake: provider }, breaker: new CircuitBreaker() });
      const before = data.size;
      const outcome = await extractStructured(
        { html: fixture.html, url: fixture.url, schema: fixture.schema, tenantId: 'corpus', deadlineMs: Date.now() + 60_000 },
        { modelClient: client, recipeStore: store, learning: 'await' },
      );
      expect(outcome.warnings.filter((w) => w.startsWith('recipe_learning_failed'))).toEqual([]);
      if (data.size > before) learned.push(fixture.id);
    }
    console.log(`candidates learned: ${learned.join(', ') || 'none'}`);
    expect(learned.length).toBeGreaterThan(0);
  });
});
