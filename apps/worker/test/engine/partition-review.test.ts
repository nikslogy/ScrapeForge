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

// After the third review round.
describe('records alone against the size of the page, a stray record, a cheaper fallback', () => {
  it('a grid whose cards never name the fields, below a long intro, is sent as the records alone', async () => {
    const list = items(40);
    const cards = list
      .map((it, i) => `<div class="rounded-lg border p-4 shadow-sm"><h3 class="text-lg font-semibold"><a href="/p/${i}">${it.title}</a></h3><span class="text-gray-900 font-bold">${it.price}</span></div>`)
      .join('');
    const intro = Array.from({ length: 60 }, (_, i) => `<p>Story ${i}: ${'Our team has been building gadgets in a small workshop since 1998, and every one is tested by hand before it leaves. '.repeat(3)}</p>`).join('');
    const html = page(`<main><h1>All gadgets</h1>${intro}<div class="grid grid-cols-4 gap-4">${cards}</div></main>`, '<title>All gadgets</title>');
    const { client } = fakeClient(listingModel, { maxOutputTokens: 4_096, contextTokens: 8_000 });
    const out = await extractStructured(request(html, LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.status).toBe('complete');
    expect(len(out.data, 'items')).toBe(40);
  });

  it('a grid below a mega-menu whose columns are headed "Sale" and "Shop by price" is sent as the records alone', async () => {
    const menu = ['Sale', 'Shop by price', 'Sale picks', 'Price drops']
      .map((h, c) => `<div class="menu-col"><h4>${h}</h4><ul>${Array.from({ length: 60 }, (_, i) => `<li><a href="/c/${c}-${i}">Category ${c}-${i} under $${10 + i}</a></li>`).join('')}</ul></div>`)
      .join('');
    const html = listing(items(40), { priceClass: 'price price-item' }).replace('<header>', `<header><nav class="mega-menu">${menu}</nav>`);
    const { client } = fakeClient(listingModel, { maxOutputTokens: 4_096, contextTokens: 8_000 });
    const out = await extractStructured(request(html, LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(len(out.data, 'items')).toBe(40);
    expect(out.status).toBe('complete');
  });

  it.each(['empty', 'bare'] as const)('one stray record (%s) in a short answer does not stop the re-ask of the cards it left out', async (variant) => {
    const lazy: FakeHandler = (caps, req, i) => {
      const r = listingModel(caps, req, i) as Sync;
      if (cardsIn(req.user) < 100) return r;
      const parsed = JSON.parse(r.text) as { records: Array<Record<string, { v: unknown; b: unknown }>> };
      const kept: unknown[] = parsed.records.slice(0, Math.floor(parsed.records.length * 0.7));
      if (variant === 'empty') kept.push({ title: { v: null, b: null }, price: { v: null, b: null } });
      else {
        const last = parsed.records[kept.length - 1];
        kept[kept.length - 1] = { title: last.title.v, price: last.price.v };
      }
      return { ...r, text: JSON.stringify({ records: kept }) };
    };
    const { client } = fakeClient(lazy, { maxOutputTokens: 8_192, contextTokens: 128_000 });
    const out = await extractStructured(request(listing(items(400)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    const titles = (out.data as { items: Array<{ title: string | null }> }).items.map((r) => r.title).filter(Boolean);
    expect(new Set(titles).size).toBe(400);
    expect(out.status).toBe('complete');
  });

  it('a chunk the primary model cannot pay for, but a cheaper fallback can, is sent: the client picks the model', async () => {
    const calls = { primary: 0, cheap: 0 };
    const pricey = new FakeProvider((caps, req, i) => {
      calls.primary++;
      return billed(listingModel)(caps, req, i);
    });
    const cheap = new FakeProvider((caps, req, i) => {
      calls.cheap++;
      return billed(listingModel)(caps, req, i);
    }, 'openrouter');
    const client = new ModelClient({
      models: [
        fakeCaps({ maxOutputTokens: 8_192, contextTokens: 128_000, inputCostPerMTok: 1_000, outputCostPerMTok: 1_000 }),
        fakeCaps({ provider: 'openrouter', model: 'cheap', maxOutputTokens: 8_192, contextTokens: 128_000, inputCostPerMTok: 10, outputCostPerMTok: 10 }),
      ],
      providers: { fake: pricey, openrouter: cheap },
      breaker: new CircuitBreaker(),
      sleep: async () => undefined,
    });
    const out = await extractStructured(request(listing(items(800)), LISTING_SCHEMA, { url: LISTING_URL, maxCostUsd: 2 }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.status).toBe('complete');
    expect(len(out.data, 'items')).toBe(800);
    expect(out.llm.costUsd).toBeLessThanOrEqual(2);
    expect(calls.cheap).toBeGreaterThan(0);
  });
});

// After the fourth review round.
describe('records alone against the size of what competes, and stray records placed by their text', () => {
  const sentTo = (onUser: (user: string) => void) =>
    fakeClient((_caps, req) => {
      onUser(req.user);
      return { text: '{"records":[]}', finishReason: 'stop', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 };
    }, { maxOutputTokens: 4_096, contextTokens: 8_000 }).client;

  it('a strip of four deals above a 40-card grid does not take the grid\'s place, however well its tiles score', async () => {
    const deals = Array.from({ length: 4 }, (_, i) => `<div class="deal-tile"><h3><a href="/d/${i}">Deal Gadget ${i}</a></h3><p class="deal-price">Sale price now $${9 + i}.99, was $${19 + i}.99</p></div>`).join('');
    const grid = items(40)
      .map((it, i) => `<li class="col-span-1"><div class="rounded border p-3"><h3 class="text-base"><a href="/p/${i}">${it.title}</a></h3><p class="mt-1 font-bold">${it.price}</p></div></li>`)
      .join('');
    const intro = Array.from({ length: 80 }, (_, i) => `<p>Guide ${i}: ${'Choosing a gadget comes down to battery life, build quality and how you plan to use it every day. '.repeat(3)}</p>`).join('');
    const html = page(`<main><h1>All gadgets</h1><section class="deals"><h2>Deals of the week</h2><div class="deal-row">${deals}</div></section>${intro}<ul class="grid">${grid}</ul></main>`);
    let gridCards = 0;
    const client = sentTo((user) => (gridCards = Math.max(gridCards, items(40).filter((it) => user.includes(it.title)).length)));
    const out = await extractStructured(request(html, LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.scope.strategy).toBe('partitioned');
    expect(gridCards).toBe(40);
  });

  it('a changelog printed as headings is sent from the top, not replaced by the four blog cards beside it', async () => {
    const releases = Array.from({ length: 900 }, (_, i) =>
      `<h2>Version 3.${900 - i}.0</h2><p>Released 2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}</p><p>Fixed a crash when opening large projects from the recent list.</p>`,
    ).join('');
    const related = Array.from({ length: 4 }, (_, i) => `<div class="post-card"><h4><a href="/blog/${i}">How we ship release ${i}</a></h4><p>A look behind the scenes at our process number ${i}.</p></div>`).join('');
    const html = page(`<main><h1>Changelog</h1>${releases}<aside><h3>From the blog</h3>${related}</aside></main>`);
    let sawTop = false;
    const client = sentTo((user) => (sawTop ||= user.includes('Version 3.900.0')));
    const out = await extractStructured(request(html, { releases: [{ version: 'string — release version number', date: 'string — release date' }] }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(sawTop).toBe(true);
    expect(out.scope.strategy).not.toBe('partitioned');
  });

  it('a release table whose headers do not spell the fields is sent from the top, not replaced by three related stories', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => `<tr><td>Release ${i + 1}.0</td><td>2026-${String(i + 1).padStart(2, '0')}-10</td></tr>`).join('');
    const prose = Array.from({ length: 200 }, (_, i) => `<p>Note ${i}: ${'We keep a careful log of everything that ships each week. '.repeat(4)}</p>`).join('');
    const related = ['One', 'Two', 'Three'].map((t) => `<article class="story"><h3>Related story ${t}</h3><p>Read more about our team</p></article>`).join('');
    const html = page(`<main><h1>History</h1><table><thead><tr><th>Release</th><th>Shipped</th></tr></thead><tbody>${rows}</tbody></table>${prose}<aside>${related}</aside></main>`);
    let sawTable = false;
    const client = sentTo((user) => (sawTable ||= user.includes('Release 1.0')));
    const out = await extractStructured(request(html, { releases: [{ version: 'string', date: 'string' }] }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(sawTable).toBe(true);
    expect(out.scope.strategy).not.toBe('partitioned');
  });

  it.each(['bare', 'unknown block'] as const)('a record given with %s for a card is placed on that card by its text: the card is not asked again, nor returned twice', async (variant) => {
    const lazy: FakeHandler = (caps, req, i) => {
      const r = listingModel(caps, req, i) as Sync;
      if (cardsIn(req.user) < 100) return r;
      const parsed = JSON.parse(r.text) as { records: Array<Record<string, { v: unknown; b: unknown }>> };
      const kept: unknown[] = parsed.records.slice(0, Math.floor(parsed.records.length * 0.7));
      const last = parsed.records[kept.length - 1];
      kept[kept.length - 1] =
        variant === 'bare' ? { title: last.title.v, price: last.price.v } : { title: { v: last.title.v, b: 'b999999' }, price: { v: last.price.v, b: 'b999998' } };
      return { ...r, text: JSON.stringify({ records: kept }) };
    };
    const { client } = fakeClient(lazy, { maxOutputTokens: 8_192, contextTokens: 128_000 });
    const out = await extractStructured(request(listing(items(400)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    const titles = (out.data as { items: Array<{ title: string | null }> }).items.map((r) => r.title);
    expect(titles).toHaveLength(400);
    expect(new Set(titles).size).toBe(400);
    expect(out.status).toBe('complete');
  });

  it('exactly one record in five citing no card still re-asks the cards left out', async () => {
    let firstCards = -1;
    const handler: FakeHandler = (caps, req, i) => {
      const r = listingModel(caps, req, i) as Sync;
      const cards = cardsIn(req.user);
      if (firstCards === -1) firstCards = cards;
      if (cards < 100) return r;
      const recs: unknown[] = (JSON.parse(r.text) as { records: unknown[] }).records.slice(0, 120);
      for (let k = 0; k < 30; k++) recs.push({ title: { v: null, b: null }, price: { v: null, b: null } });
      return { ...r, text: JSON.stringify({ records: recs }) };
    };
    const { client } = fakeClient(handler, { maxOutputTokens: 8_192, contextTokens: 128_000 });
    const out = await extractStructured(request(listing(items(400)), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.warnings).toContain('partition_chunk_reasked');
    expect(len(out.data, 'items')).toBe(400);
  });
});

// After the fifth review round.
describe('records alone against chrome headings, small tables that name the fields, and strays placed by every value', () => {
  const sentTo = (onUser: (user: string) => void) =>
    fakeClient((_caps, req) => {
      onUser(req.user);
      return { text: '{"records":[]}', finishReason: 'stop', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 };
    }, { maxOutputTokens: 4_096, contextTokens: 8_000 }).client;
  const banner = Array.from({ length: 40 }, (_, i) => `Story ${i}: ${'Our team has been building gadgets in a small workshop since 1998, and every one is tested by hand. '.repeat(3)}`).join(' ');

  it('a mega-menu of 24 headed columns in the page header does not take the place of a 40-card grid', async () => {
    const heads = ['Sale', 'Shop by price', 'Sale picks', 'Price drops', 'Women', 'Men', 'Kids', 'Home', 'Outdoor', 'Kitchen', 'Garden', 'Audio', 'Cameras', 'Phones', 'Laptops', 'Gaming', 'Wearables', 'Smart home', 'Office', 'Travel', 'Fitness', 'Beauty', 'Pets', 'Toys'];
    const menu = heads.map((h, c) => `<div class="menu-col"><h4 class="mega-title">${h}</h4><ul>${Array.from({ length: 6 }, (_, i) => `<li><a href="/c/${c}-${i}">Category ${c}-${i} under $${10 + i}</a></li>`).join('')}</ul></div>`).join('');
    const html = listing(items(40), { priceClass: 'price price-item', banner }).replace('<header>', `<header><nav class="mega-menu">${menu}</nav>`);
    const { client } = fakeClient(listingModel, { maxOutputTokens: 4_096, contextTokens: 8_000 });
    const out = await extractStructured(request(html, LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(out.status).toBe('complete');
    expect(len(out.data, 'items')).toBe(40);
  });

  it("a buying guide's 48 section headings (one about the price) do not take the place of a 24-card grid", async () => {
    const guide = Array.from({ length: 48 }, (_, i) => `<h3>${i === 7 ? 'What does the price include?' : `Choosing well, part ${i}`}</h3><p>${'Pick the gadget that fits how you work, and check the warranty terms before you buy. '.repeat(2)}</p>`).join('');
    const html = listing(items(24)).replace('<h1>All gadgets</h1>', `<h1>All gadgets</h1>${guide}`);
    let cards = 0;
    const client = sentTo((user) => (cards = Math.max(cards, items(24).filter((it) => user.includes(it.title)).length)));
    const out = await extractStructured(request(html, LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(cards).toBe(24);
    expect(out.scope.strategy).toBe('partitioned');
  });

  it('a standings table that names the fields is sent, not the 40 news cards below it that name nothing', async () => {
    const teams = Array.from({ length: 18 }, (_, i) => `Club ${String.fromCharCode(65 + (i % 26))}${i}`);
    const table = `<table class="standings"><thead><tr><th>Pos</th><th>Team</th><th>Played</th><th>Points</th></tr></thead><tbody>${teams.map((t, i) => `<tr><td>${i + 1}</td><td>${t}</td><td>30</td><td>${80 - i * 3}</td></tr>`).join('')}</tbody></table>`;
    const prose = Array.from({ length: 120 }, (_, i) => `<p>Match report ${i}: ${'The visitors pressed high from the first whistle and kept the ball well in midfield all afternoon. '.repeat(3)}</p>`).join('');
    const cards = Array.from({ length: 40 }, (_, i) => `<article class="news-card"><h3><a href="/news/${i}">Weekend roundup part ${i}</a></h3><p>Published ${i + 1} hours ago by the newsroom.</p></article>`).join('');
    const html = page(`<main><h1>League table</h1>${table}${prose}<section class="latest"><h2>Latest news</h2>${cards}</section></main>`);
    let sawTable = false;
    const client = sentTo((user) => (sawTable ||= user.includes('Club A0')));
    const out = await extractStructured(request(html, { standings: [{ team: 'string — team name', points: 'number — points' }] }), { modelClient: client, recipeStore: null, learning: 'off' });
    expect(sawTable).toBe(true);
    expect(out.scope.strategy).not.toBe('partitioned');
  });

  it.each([
    ['its title also begins another card\'s title', (list: ReturnType<typeof items>) => list, 1],
    ['its title is shared by another card', (list: ReturnType<typeof items>) => list.map((it, i) => (i === 101 ? { ...it, title: list[100].title } : it)), 100],
  ])('a stray record with a numeric price whose title %s is placed by its price too: not returned twice', async (_label, edit, at) => {
    const list = edit(items(400));
    const lazy: FakeHandler = (caps, req, i) => {
      const r = listingModel(caps, req, i) as Sync;
      if (cardsIn(req.user) < 100) return r;
      const parsed = JSON.parse(r.text) as { records: Array<Record<string, { v: unknown; b: unknown }>> };
      const kept: unknown[] = parsed.records.slice(0, Math.floor(parsed.records.length * 0.7));
      const rec = parsed.records[at];
      if (rec && req.user.includes(list[at].title)) kept[at] = { title: rec.title.v, price: Number(String(rec.price.v).replace(/[^0-9.]/g, '')) };
      return { ...r, text: JSON.stringify({ records: kept }) };
    };
    const { client } = fakeClient(lazy, { maxOutputTokens: 8_192, contextTokens: 128_000 });
    const out = await extractStructured(request(listing(list), LISTING_SCHEMA, { url: LISTING_URL }), { modelClient: client, recipeStore: null, learning: 'off' });
    const keys = (out.data as { items: Array<{ title: string; price: number }> }).items.map((r) => `${r.title}|${r.price}`);
    expect(keys).toHaveLength(400);
    expect(new Set(keys).size).toBe(400);
  });
});
