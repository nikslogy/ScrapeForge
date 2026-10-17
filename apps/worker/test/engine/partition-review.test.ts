// Listings in chunks and selected inputs, after the adversarial review:
// - under a cost cap, chunks wait for siblings' reservations instead of
//   failing, and the cap (not a provider) is named for what was skipped;
// - a chunk that times out is halved at once, and the halves run side by side;
// - a page whose listing fits one call but whose page does not is sent as
//   the records alone;
// - a chunk answered with fewer records than cards is asked again for the
//   cards it left out;
// - an empty answer on a selected input, or with unprocessed chunks, is not
//   "not found".

import { describe, expect, it } from 'vitest';
import { extractStructured } from '../../src/extract/engine.js';
import { CircuitBreaker, delay, FakeProvider, fakeCaps, ModelClient, type FakeHandler } from '../../src/extract/llm/index.js';
import { billed, fakeClient, items, listing, LISTING_SCHEMA, LISTING_URL, listingModel, page, request } from './helpers.js';

const len = (data: unknown, key: string): number => ((data as Record<string, unknown[]> | null)?.[key] ?? []).length;
const cardsIn = (user: string): number => (user.match(/<record /g) ?? []).length;
type Sync = Exclude<ReturnType<FakeHandler>, Promise<unknown>>;

describe('a cost cap with chunks in flight', () => {
  it('chunks the cap can pay for one after another all run: no chunk fails on a sibling\'s reservation', async () => {
    // Billed by tokens at $1,000/M, the 800 cards cost about $61; each chunk reserves about $25.
    const { client } = fakeClient(billed(listingModel), { maxOutputTokens: 8_192, contextTokens: 128_000, inputCostPerMTok: 1_000, outputCostPerMTok: 1_000 });
    const out = await extractStructured(request(listing(items(800)), LISTING_SCHEMA, { url: LISTING_URL, maxCostUsd: 70 }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.status).toBe('complete');
    expect(len(out.data, 'items')).toBe(800);
    expect(out.llm.costUsd).toBeLessThanOrEqual(70);
    expect(out.scope.partitions).toMatchObject({ failed: 0, skipped: 0 });
  });

  it('what the cap stops is skipped, not a provider failure', async () => {
    const { client } = fakeClient(billed(listingModel), { maxOutputTokens: 8_192, contextTokens: 128_000, inputCostPerMTok: 1_000, outputCostPerMTok: 1_000 });
    const out = await extractStructured(request(listing(items(800)), LISTING_SCHEMA, { url: LISTING_URL, maxCostUsd: 10 }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.status).toBe('partial');
    expect(out.scope.partitions?.failed).toBe(0);
    expect(out.missing.find((m) => m.path === '/items')).toMatchObject({ reason: 'not_processed', detail: expect.stringMatching(/cost_cap/) });
    // One gap for the rest of the list, not one per piece.
    expect(out.missing.find((m) => m.path === '/items')!.detail).not.toMatch(/more\)?$/);
  });
});

describe('a chunk that times out', () => {
  it('is halved at its first timeout, and the halves run side by side', async () => {
    let inflight = 0;
    let maxHalvesInFlight = 0;
    const big: number[] = [];
    const provider = new FakeProvider(async (caps, req, i) => {
      const cards = cardsIn(req.user);
      if (cards > 120) {
        big.push(cards);
        await delay(10_000, req.signal); // never answers in time
      }
      inflight++;
      maxHalvesInFlight = Math.max(maxHalvesInFlight, inflight);
      try {
        await delay(100);
        return listingModel(caps, req, i) as Sync;
      } finally {
        inflight--;
      }
    });
    const client = new ModelClient({
      models: [fakeCaps({ maxOutputTokens: 65_536, contextTokens: 1_000_000 })],
      providers: { fake: provider },
      breaker: new CircuitBreaker(),
      sleep: async () => undefined,
      perCallTimeoutMs: 400,
    });
    const out = await extractStructured(request(listing(items(400)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.status).toBe('complete');
    expect(len(out.data, 'items')).toBe(400);
    // Each whole chunk was sent once: no retry of the same size before halving.
    expect(big).toHaveLength(2);
    // Two chunks, four halves: all four in flight together.
    expect(maxHalvesInFlight).toBe(4);
  }, 30_000);
});

describe('a page over the input budget whose listing fits one call', () => {
  it('is sent as the records alone, not cut from the top', async () => {
    const prose = Array.from({ length: 220 }, (_, i) => `<p>Paragraph ${i}: ${'Our story began in a small workshop where every gadget was tested by hand. '.repeat(6)}</p>`).join('');
    const html = listing(items(30), { banner: prose });
    const { client, provider } = fakeClient(listingModel, { maxOutputTokens: 8_192, contextTokens: 32_000 });
    const out = await extractStructured(request(html, LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.status).toBe('complete');
    expect(len(out.data, 'items')).toBe(30);
    expect(out.scope.strategy).toBe('partitioned');
    expect(provider.calls).toHaveLength(1);
  });
});

describe('a chunk answered with fewer records than cards', () => {
  it('is asked again for the cards it left out', async () => {
    // A lazy first answer: on a large chunk, the model stops two thirds of the way.
    const lazy: FakeHandler = (caps, req, i) => {
      const r = listingModel(caps, req, i) as Sync;
      if (cardsIn(req.user) < 150) return r;
      const parsed = JSON.parse(r.text) as { records: unknown[] };
      return { ...r, text: JSON.stringify({ records: parsed.records.slice(0, Math.floor((parsed.records.length * 2) / 3)) }) };
    };
    const { client } = fakeClient(lazy, { maxOutputTokens: 8_192, contextTokens: 128_000 });
    const out = await extractStructured(request(listing(items(800)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.warnings).toContain('partition_chunk_reasked');
    expect(len(out.data, 'items')).toBe(800);
    expect(out.status).toBe('complete');
  });

  it('a second short answer is reported, not passed off as complete', async () => {
    const halfOfIt: FakeHandler = (caps, req, i) => {
      const r = listingModel(caps, req, i) as Sync;
      const parsed = JSON.parse(r.text) as { records: unknown[] };
      return { ...r, text: JSON.stringify({ records: parsed.records.slice(0, Math.ceil(parsed.records.length / 2)) }) };
    };
    const { client } = fakeClient(halfOfIt, { maxOutputTokens: 8_192, contextTokens: 128_000 });
    const out = await extractStructured(request(listing(items(800)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.status).toBe('partial');
    expect(out.scope.truncated).toBe(true);
    expect(out.missing.find((m) => m.path === '/items')).toMatchObject({ reason: 'not_processed', detail: expect.stringMatching(/returned \d+ of \d+/) });
  });
});

describe('an empty answer', () => {
  it('next to chunks that failed: the list gap says why, not "no records found"', async () => {
    const first = items(800)[0].title;
    const handler: FakeHandler = (caps, req, i) => {
      if (req.user.includes(first)) return { ...(listingModel(caps, req, i) as Sync), text: '{"records":[]}' };
      throw Object.assign(new Error('upstream 500'), { status: 500 });
    };
    const { client } = fakeClient(handler, { maxOutputTokens: 8_192, contextTokens: 128_000 });
    const out = await extractStructured(request(listing(items(800)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    const gap = out.missing.find((m) => m.path === '/items');
    expect(gap?.reason).toBe('provider_failure');
    expect(gap?.detail).toMatch(/of 800 records were not processed/);
  });

  it('on a selected input: not processed, never "not found"', async () => {
    const filler = Array.from({ length: 300 }, (_, i) => `<p>Review ${i}: ${'Solid build, ships fast, would buy again. '.repeat(5)}</p>`).join('');
    const html = page(`<main><h1>Desk lamp</h1>${filler}<p>Warranty: 24 months</p></main>`);
    const { client } = fakeClient(() => ({ text: '{"records":[]}', finishReason: 'stop', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 }), { maxOutputTokens: 1_024, contextTokens: 4_000 });
    const out = await extractStructured(request(html, { type: 'object', properties: { warrantyMonths: { type: 'number' } } }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.scope.strategy).toBe('selected');
    expect(out.missing.find((m) => m.path === '/warrantyMonths')?.reason).toBe('not_processed');
    expect(out.scope.truncated).toBe(true);
    expect(out.status).not.toBe('complete');
  });
});

describe('selection on a page in another script', () => {
  it('a Cyrillic page: the relevant block far down the page is sent', async () => {
    const reviews = Array.from({ length: 160 }, (_, i) => `<p>Отзыв ${i}: ${'Отличная лампа, яркий свет и удобная подставка. '.repeat(4)}</p>`).join('');
    const html = page(`<main><h1>Настольная лампа</h1>${reviews}<p class="price">Цена: 12 800 руб.</p></main>`);
    let sawPrice = false;
    const { client } = fakeClient((_caps, req) => {
      const line = /\[(b\d+)\][^\n]*12 800/.exec(req.user);
      sawPrice ||= line !== null;
      const records = [{ price: line ? { v: '12 800 руб.', b: line[1] } : { v: null, b: null } }];
      return { text: JSON.stringify({ records }), finishReason: 'stop', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 };
    }, { maxOutputTokens: 1_024, contextTokens: 6_000 });
    const out = await extractStructured(request(html, { type: 'object', properties: { price: { type: 'number' } } }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.scope.strategy).toBe('selected');
    expect(sawPrice).toBe(true);
    expect(out.data).toMatchObject({ price: 12800 });
  });
});

// After the second review round.
describe('records alone, re-asks, fallbacks and the cost gate', () => {
  it('a small side group on an over-budget page does not replace the top of the page', async () => {
    const releases = Array.from({ length: 12 }, (_, i) => `<tr><td>1.${i}.0</td><td>Fixes and improvements</td></tr>`).join('');
    const prose = Array.from({ length: 200 }, (_, i) => `<p>Note ${i}: ${'We keep a careful changelog of everything that ships each week. '.repeat(4)}</p>`).join('');
    const related = ['One', 'Two', 'Three'].map((t) => `<article class="story"><h3>Related story ${t}</h3><p>Read more about our team</p></article>`).join('');
    const html = page(`<main><h1>Changelog</h1><table><thead><tr><th>Version</th><th>Notes</th></tr></thead><tbody>${releases}</tbody></table>${prose}<aside>${related}</aside></main>`);
    let sawTable = false;
    const { client } = fakeClient((_caps, req) => {
      sawTable ||= req.user.includes('1.0.0');
      return { text: '{"records":[]}', finishReason: 'stop', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 };
    }, { maxOutputTokens: 2_048, contextTokens: 8_000 });
    const out = await extractStructured(request(html, { releases: [{ version: 'string' }] }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(sawTable).toBe(true);
    expect(out.scope.strategy).not.toBe('partitioned');
    expect(out.missing.find((m) => m.path === '/releases')?.reason).not.toBe('not_found');
  });

  it('a re-ask sends only the cards no record cites, and a card with one value is never returned twice', async () => {
    const list = items(400).map((it, i) => (i % 12 === 5 ? { ...it, price: 'Price on request' } : it));
    let firstCalls = 0;
    const sizes: number[] = [];
    const lazy: FakeHandler = (caps, req, i) => {
      const r = listingModel(caps, req, i) as Sync;
      const cards = cardsIn(req.user);
      sizes.push(cards);
      if (cards < 100) return r;
      firstCalls++;
      const parsed = JSON.parse(r.text) as { records: unknown[] };
      return { ...r, text: JSON.stringify({ records: parsed.records.slice(0, Math.floor(parsed.records.length * 0.7)) }) };
    };
    const { client } = fakeClient(lazy, { maxOutputTokens: 8_192, contextTokens: 128_000 });
    const out = await extractStructured(request(listing(list), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    const titles = (out.data as { items: Array<{ title: string }> }).items.map((r) => r.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles).toHaveLength(400);
    expect(out.status).toBe('complete');
    // The re-asks hold the ~30% left out, not the whole chunk again.
    expect(sizes.filter((n) => n < 100).every((n) => n <= 70)).toBe(true);
    expect(firstCalls).toBeGreaterThan(0);
  });

  it('a hung primary model: a chunk goes to the fallback at its first timeout instead of being halved on the hung model', async () => {
    const calls = { primary: 0, fallback: 0 };
    const hung = new FakeProvider(async (_caps, req) => {
      calls.primary++;
      await delay(10_000, req.signal);
      throw new Error('unreachable');
    });
    const healthy = new FakeProvider((caps, req, i) => {
      calls.fallback++;
      return listingModel(caps, req, i);
    }, 'openrouter');
    const client = new ModelClient({
      models: [fakeCaps({ maxOutputTokens: 8_192, contextTokens: 128_000 }), fakeCaps({ provider: 'openrouter', model: 'backup', maxOutputTokens: 8_192, contextTokens: 128_000 })],
      providers: { fake: hung, openrouter: healthy },
      breaker: new CircuitBreaker(),
      sleep: async () => undefined,
      perCallTimeoutMs: 300,
    });
    const out = await extractStructured(request(listing(items(400)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.status).toBe('complete');
    expect(calls.primary).toBe(out.scope.partitions!.chunks);
    expect(out.warnings.some((w) => w.startsWith('partition_chunk_split:timeout'))).toBe(false);
  }, 30_000);

  it('more budget never returns fewer records, and no answer is cut off by the cap and billed', async () => {
    const got: number[] = [];
    for (const cap of [10, 14, 15, 16, 17, 30]) {
      const { client, provider } = fakeClient(billed(listingModel), { maxOutputTokens: 8_192, contextTokens: 128_000, inputCostPerMTok: 1_000, outputCostPerMTok: 1_000 });
      const out = await extractStructured(request(listing(items(800)), LISTING_SCHEMA, { url: LISTING_URL, maxCostUsd: cap }), { modelClient: client, recipeStore: null, learning: 'off' });
      got.push(len(out.data, 'items'));
      expect(out.llm.costUsd).toBeLessThanOrEqual(cap);
      expect(out.llm.attempts.filter((a) => a.errorCategory === 'output_truncated')).toEqual([]);
      expect(provider.calls.length).toBeGreaterThan(0);
    }
    expect(got).toEqual([...got].sort((a, b) => a - b));
  });
});
