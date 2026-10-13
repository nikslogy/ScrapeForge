// Engine behaviour fixed after the first live benchmark (tests/eval/README.md),
// replayed on the same fixtures with the answers the models actually gave.

import { describe, expect, it } from 'vitest';
import { loadFixture, type Fixture } from '../../../../tests/fixtures/extraction/load.js';
import { scoreExtraction } from '../../../../tests/engine/scoring.js';
import { buildSourceDocument } from '../../src/extract/document/index.js';
import { extractStructured } from '../../src/extract/engine.js';
import { CircuitBreaker, FakeProvider, fakeCaps, ModelClient } from '../../src/extract/llm/index.js';
import type { ExtractionOutcome, SourceDocument } from '../../src/extract/types.js';

type Answer = Record<string, { v: unknown; b: string | null }>;

async function run(fx: Fixture, records: Answer[]): Promise<ExtractionOutcome> {
  const provider = new FakeProvider(() => ({ text: JSON.stringify({ records }), finishReason: 'stop', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 }));
  const client = new ModelClient({ models: [fakeCaps()], providers: { fake: provider }, breaker: new CircuitBreaker() });
  return extractStructured(
    { html: fx.html, url: fx.url, schema: fx.schema, tenantId: 't', deadlineMs: Date.now() + 60_000, includeEvidence: true, disable: ['structured', 'recipe'] },
    { modelClient: client, recipeStore: null, learning: 'off' },
  );
}

function block(doc: SourceDocument, text: string, from = 0): string {
  const hit = doc.blocks.slice(from).find((b) => b.text === text) ?? doc.blocks.slice(from).find((b) => b.text.includes(text));
  if (!hit) throw new Error(`no block with ${JSON.stringify(text)}`);
  return hit.id;
}

/** Gold answer for an object fixture, every value cited at the block holding `cite[field]`. */
function goldAnswer(fx: Fixture, doc: SourceDocument, cite: Record<string, string>, override: Answer = {}): Answer {
  const out: Answer = {};
  for (const [k, v] of Object.entries(fx.gold as Record<string, unknown>)) {
    out[k] = { v, b: cite[k] ? block(doc, cite[k]) : null };
  }
  return { ...out, ...override };
}

describe('"Contact sales", "TBA": the page says there is no value', () => {
  it('saas-pricing: the Enterprise tier is complete with null prices', async () => {
    const fx = loadFixture('saas-pricing');
    const doc = buildSourceDocument(fx.html, fx.url);
    const gold = fx.gold as Array<Record<string, unknown>>;
    const enterprise = block(doc, 'Custom pricing');
    const records: Answer[] = gold.map((g) => {
      const name = block(doc, String(g.plan));
      const r: Answer = {};
      for (const [k, v] of Object.entries(g)) r[k] = { v, b: name };
      return r;
    });
    // What Gemini 2.5 Flash-Lite answered for the Enterprise tier.
    const last = records[records.length - 1];
    last.monthlyPrice = { v: 'Custom pricing', b: enterprise };
    last.annualPricePerMonth = { v: 'Contact sales', b: block(doc, 'Contact sales') };
    last.seatsIncluded = { v: 'Unlimited seats', b: block(doc, 'Unlimited seats') };
    const outcome = await run(fx, records);
    const score = scoreExtraction(fx, outcome.data);
    expect(score.valuePrecision).toBe(1);
    expect(outcome.status).toBe('complete');
    const missing = outcome.missing.filter((m) => m.path.startsWith('/3/'));
    expect(missing.map((m) => m.reason)).toEqual(['not_found', 'not_found', 'not_found']);
    expect(missing[0].detail).toMatch(/states no value/);
  });

  it('a placeholder the model made up ("N/A") is not found, not rejected', async () => {
    const fx = loadFixture('missing-fields');
    const doc = buildSourceDocument(fx.html, fx.url);
    const title = doc.blocks.find((b) => b.kind === 'heading')!.id;
    const gold = fx.gold as Record<string, unknown>;
    const answer: Answer = {};
    for (const [k, v] of Object.entries(gold)) answer[k] = { v, b: title };
    answer.price = { v: 'N/A', b: null };
    answer.rating = { v: 'Not specified', b: title };
    const outcome = await run(fx, [answer]);
    expect(outcome.missing.filter((m) => m.reason === 'rejected_ungrounded')).toEqual([]);
    expect(outcome.data).toMatchObject({ price: null, rating: null });
  });
});

describe('electronics-pdp-sale: numbers in the unit the field asks for', () => {
  const fx = loadFixture('electronics-pdp-sale');
  const doc = buildSourceDocument(fx.html, fx.url);
  const specs = block(doc, '512 GB PCIe 4.0 NVMe SSD');

  it.each([
    ['the verbatim cell (GPT-5 Nano: was "ambiguous")', '512 GB PCIe 4.0 NVMe SSD', specs],
    ['a shortened cell (was rejected)', '512 GB SSD', specs],
    ['glued unit, no citation (Gemini 3.8 Flash: was rejected)', '512GB', null],
  ])('storage from %s', async (_label, v, b) => {
    const outcome = await run(fx, [{ name: { v: (fx.gold as Record<string, unknown>).name, b: block(doc, 'AeroBook 14') }, storage: { v, b } }]);
    expect((outcome.data as Record<string, unknown>).storage).toBe(512);
    expect(outcome.missing.find((m) => m.path === '/storage')).toBeUndefined();
  });

  it('ram "16 GB LPDDR5X-8533" is 16, weight "1.4 kg (3.09 lb)" is 1.4, "3.09 lb" converts', async () => {
    const outcome = await run(fx, [{ ram: { v: '16 GB LPDDR5X-8533', b: specs }, weightKg: { v: '3.09 lb', b: specs } }]);
    expect(outcome.data).toMatchObject({ ram: 16, weightKg: 1.4 });
    const again = await run(fx, [{ weightKg: { v: '1.4 kg (3.09 lb)', b: specs } }]);
    expect(again.data).toMatchObject({ weightKg: 1.4 });
  });

  it('a number that is not on the page is still rejected', async () => {
    const outcome = await run(fx, [{ storage: { v: '256 GB SSD', b: specs } }]);
    expect(outcome.missing.find((m) => m.path === '/storage')?.reason).toBe('rejected_ungrounded');
  });
});

describe('job-posting: a yes/no answer read from one sentence of a long block', () => {
  const fx = loadFixture('job-posting');
  const doc = buildSourceDocument(fx.html, fx.url);
  const cite = { title: 'Senior Data Engineer', company: 'Brightloom Analytics', location: 'Austin, TX', employmentType: 'Full-time' };

  it.each([[false], ['false'], ['No']])('remote %j citing "…It is not eligible for fully remote work." is grounded', async (v) => {
    const sentence = block(doc, 'not eligible for fully remote work');
    expect(doc.blocks.find((b) => b.id === sentence)!.text.length).toBeGreaterThan(100);
    const outcome = await run(fx, [goldAnswer(fx, doc, cite, { remote: { v, b: sentence } })]);
    expect((outcome.data as Record<string, unknown>).remote).toBe(false);
    expect(outcome.missing.find((m) => m.path === '/remote')).toBeUndefined();
    // Matched in the cited block: not a citation mismatch.
    expect(outcome.warnings).not.toContain('citation_mismatch:/remote');
    expect(outcome.evidence.find((e) => e.path === '/remote')?.note).toMatch(/matched by meaning/);
  });

  it('remote true citing the same block is rejected', async () => {
    const sentence = block(doc, 'not eligible for fully remote work');
    const outcome = await run(fx, [goldAnswer(fx, doc, cite, { remote: { v: true, b: sentence } })]);
    expect(outcome.missing.find((m) => m.path === '/remote')?.reason).toBe('rejected_ungrounded');
  });

  it('a block that says both is no confirmation', async () => {
    const html = fx.html.replace('It is not eligible for fully remote work.', 'It is not eligible for fully remote work. Fully remote candidates welcome.');
    const doc2 = buildSourceDocument(html, fx.url);
    const sentence = block(doc2, 'not eligible for fully remote work');
    const outcome = await run({ ...fx, html }, [goldAnswer({ ...fx, html }, doc2, cite, { remote: { v: false, b: sentence } })]);
    expect(outcome.missing.find((m) => m.path === '/remote')?.reason).toBe('rejected_ungrounded');
  });
});

describe('books-listing: a miscited value is checked in the card the rest of the answer cites', () => {
  const fx = loadFixture('books-listing');
  const doc = buildSourceDocument(fx.html, fx.url);
  const gold = fx.gold as Array<{ title: string; price: number; rating: number; inStock: boolean; url: string }>;
  const group = doc.recordGroups[0];
  const card = (i: number) => {
    const inside = doc.blocks.filter((b) => b.parentId === group.recordIds[i]);
    return {
      title: inside.find((b) => b.kind === 'heading')!.id,
      price: inside.find((b) => /^£/.test(b.text))!.id,
      stock: inside.find((b) => /stock/i.test(b.text))!.id,
    };
  };
  const WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five'];

  function answer(i: number, cites: { rating: string | null; inStock: string | null }, rating: unknown = WORDS[gold[i].rating]): Answer {
    const c = card(i);
    return {
      title: { v: gold[i].title, b: c.title },
      price: { v: `£${gold[i].price.toFixed(2)}`, b: c.price },
      rating: { v: rating, b: cites.rating },
      inStock: { v: gold[i].inStock, b: cites.inStock },
      url: { v: gold[i].url, b: c.title },
    };
  }

  it('ratings and stock citing the next card, or nothing, are found in their own card', async () => {
    const records = gold.map((_, i) => answer(i, i % 2 === 0 ? { rating: card((i + 1) % gold.length).price, inStock: card((i + 1) % gold.length).stock } : { rating: null, inStock: null }));
    const outcome = await run(fx, records);
    const score = scoreExtraction(fx, outcome.data);
    expect(score.valuePrecision).toBe(1);
    expect(score.valueRecall).toBe(1);
    expect(outcome.warnings).toContain('citation_mismatch:/books/0/rating');
    expect(outcome.evidence.find((e) => e.path === '/books/0/rating')?.note).toMatch(/found in its record/);
  });

  it("another card's rating is not accepted for this card", async () => {
    const records = gold.map((_, i) => answer(i, { rating: card(i).price, inStock: card(i).stock }, WORDS[gold[(i + 1) % gold.length].rating]));
    const outcome = await run(fx, records);
    const ratings = (outcome.data as { books: Array<{ rating: number | null }> }).books.map((r) => r.rating);
    ratings.forEach((r, i) => {
      if (r !== null) expect(r).toBe(gold[i].rating);
    });
  });
});

describe('block ids with a row suffix', () => {
  it('"b22-r3" is read as b22 and the value is verified there', async () => {
    const fx = loadFixture('specs-comparison-table');
    const doc = buildSourceDocument(fx.html, fx.url);
    const table = doc.blocks.find((b) => b.kind === 'table')!.id;
    const phones = fx.gold as Array<Record<string, unknown>>;
    const records = phones.map((p, i) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { v, b: `${table}-r${i + 1}` }])));
    const outcome = await run(fx, records);
    expect(outcome.warnings.some((w) => w.startsWith('llm_response:block id suffix ignored'))).toBe(true);
    expect(outcome.missing.filter((m) => m.reason === 'rejected_ungrounded'), JSON.stringify(outcome.missing)).toEqual([]);
    expect(outcome.warnings.some((w) => w.startsWith('citation_mismatch'))).toBe(false);
    expect(scoreExtraction(fx, outcome.data).valueRecall).toBe(1);
  });
});

describe('a yes/no value citing a whole table is checked in its own row and column', () => {
  const fx = loadFixture('specs-comparison-table');
  const doc = buildSourceDocument(fx.html, fx.url);
  const table = doc.blocks.find((b) => b.kind === 'table')!.id;

  async function has5g(model: string, v: unknown) {
    const outcome = await run(fx, [{ model: { v: model, b: table }, has5g: { v, b: table } }]);
    return { value: (outcome.data as { phones: Array<{ has5g?: boolean | null }> }).phones[0]?.has5g ?? null, outcome };
  }

  it('Orbis A16 ("No" under 5G): false is grounded, true is not', async () => {
    expect((await has5g('Orbis A16', false)).value).toBe(false);
    const wrong = await has5g('Orbis A16', true);
    expect(wrong.value).toBeNull();
    expect(wrong.outcome.missing.find((m) => m.path === '/phones/0/has5g')?.reason).toBe('rejected_ungrounded');
  });

  it('Nova X1 ("Yes"), not confused with "Nova X1 Pro": true is grounded, false is not', async () => {
    expect((await has5g('Nova X1', true)).value).toBe(true);
    expect((await has5g('Nova X1', false)).value).toBeNull();
  });

  it('without a row to go by, a JSON boolean is not confirmed by some other row', async () => {
    const outcome = await run(fx, [{ model: { v: null, b: null }, price: { v: '$199', b: table }, has5g: { v: false, b: table } }]);
    expect(outcome.missing.find((m) => m.path === '/phones/0/has5g')?.reason).toBe('rejected_ungrounded');
  });
});

describe('a number found elsewhere on a listing page', () => {
  it('specs-comparison-table: values cited at the "Our pick" card but printed in the table are kept (GPT-5 Nano)', async () => {
    const fx = loadFixture('specs-comparison-table');
    const doc = buildSourceDocument(fx.html, fx.url);
    const pick = doc.recordGroups[0].recordIds[0];
    const phone = (fx.gold as Array<Record<string, unknown>>)[0];
    const outcome = await run(fx, [{
      model: { v: phone.model, b: pick },
      price: { v: '$999', b: pick },
      screenInches: { v: '6.7"', b: pick },
      batteryMah: { v: '5,000', b: pick },
      weightG: { v: '221', b: pick },
    }]);
    expect(outcome.data).toMatchObject({ phones: [{ model: 'Nova X1 Pro', price: 999, screenInches: 6.7, batteryMah: 5000, weightG: 221 }] });
    expect(outcome.missing.filter((m) => m.reason === 'rejected_ungrounded')).toEqual([]);
  });

  it("books-listing: another card's price, cited at this card, is rejected", async () => {
    const fx = loadFixture('books-listing');
    const doc = buildSourceDocument(fx.html, fx.url);
    const gold = fx.gold as Array<{ title: string; price: number }>;
    const inside = (i: number) => doc.blocks.filter((b) => b.parentId === doc.recordGroups[0].recordIds[i]);
    const title0 = inside(0).find((b) => b.kind === 'heading')!.id;
    const price0 = inside(0).find((b) => /^£/.test(b.text))!.id;
    const outcome = await run(fx, [{ title: { v: gold[0].title, b: title0 }, price: { v: `£${gold[1].price.toFixed(2)}`, b: price0 } }]);
    expect(outcome.missing.find((m) => m.path === '/books/0/price')?.reason).toBe('rejected_ungrounded');
  });
});
