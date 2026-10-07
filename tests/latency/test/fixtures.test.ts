import { afterEach, describe, expect, it } from 'vitest';
import { compactPage, largePage, scrapeResult, seededRandom, smallPage } from '../lib/fixtures.js';
import { startFixtureServer, type FixtureServer } from '../lib/fixture-server.js';

describe('seededRandom', () => {
  it('is deterministic per seed and stays in [0, 1)', () => {
    const a = seededRandom(1);
    const b = seededRandom(1);
    const c = seededRandom(2);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(xs);
    expect(c()).not.toBe(xs[0]);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('page fixtures', () => {
  it('reproduces the classic 1,256-byte example.com page size', () => {
    expect(Buffer.byteLength(smallPage())).toBe(1256);
  });

  it('keeps the compact page under the 1 KB short-page threshold', () => {
    expect(Buffer.byteLength(compactPage())).toBeLessThan(1000);
    expect(compactPage()).toContain('<h1>Example Domain</h1>');
  });

  it('builds a large page at least as big as requested, deterministically', () => {
    const page = largePage();
    const bytes = Buffer.byteLength(page);
    expect(bytes).toBeGreaterThanOrEqual(500 * 1024);
    expect(bytes).toBeLessThan(500 * 1024 + 5_000);
    expect(largePage()).toBe(page);
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page.endsWith('</html>')).toBe(true);
    expect(page).toContain('window.__STATE__=');
  });

  it('honours other sizes and seeds', () => {
    expect(Buffer.byteLength(largePage(20_000))).toBeGreaterThanOrEqual(20_000);
    expect(largePage(20_000, 1)).not.toBe(largePage(20_000, 2));
    expect(Buffer.byteLength(largePage(1))).toBeGreaterThan(1);
  });

  it('rejects invalid sizes', () => {
    expect(() => largePage(0)).toThrow(RangeError);
    expect(() => largePage(1.5)).toThrow(RangeError);
    expect(() => largePage(Number.NaN)).toThrow(RangeError);
  });
});

describe('scrapeResult', () => {
  it('produces a ScrapeResult close to the requested JSON size', () => {
    const result = scrapeResult('job_1', 'https://example.com/');
    const size = Buffer.byteLength(JSON.stringify(result));
    expect(size).toBeGreaterThanOrEqual(50 * 1024);
    expect(size).toBeLessThan(50 * 1024 * 1.05);
    expect(result).toMatchObject({ jobId: 'job_1', url: 'https://example.com/', status: 'completed' });
  });

  it('handles a target smaller than the envelope and rejects bad sizes', () => {
    const tiny = scrapeResult('j', 'u', 0) as { content: { markdown: string } };
    expect(tiny.content.markdown).toBe('# Quarterly Market Report');
    expect(() => scrapeResult('j', 'u', -1)).toThrow(RangeError);
    expect(() => scrapeResult('j', 'u', 2.5)).toThrow(RangeError);
  });
});

describe('startFixtureServer', () => {
  let fixture: FixtureServer | undefined;
  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it('serves pages on loopback with exact length and type', async () => {
    fixture = await startFixtureServer({ '/a': '<p>é</p>' });
    expect(fixture.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${fixture.baseUrl}/a?cache=bust`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength('<p>é</p>')));
    expect(await res.text()).toBe('<p>é</p>');
  });

  it('answers HEAD without a body, unknown paths with 404 and other methods with 405', async () => {
    fixture = await startFixtureServer({ '/a': 'hello' });
    const head = await fetch(`${fixture.baseUrl}/a`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await fetch(`${fixture.baseUrl}/missing`)).status).toBe(404);
    expect((await fetch(`${fixture.baseUrl}/../a`)).status).toBe(200); // URL normalisation by the client
    const post = await fetch(`${fixture.baseUrl}/a`, { method: 'POST', body: 'x' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('rejects page paths that could never match a request', async () => {
    await expect(startFixtureServer({ a: 'x' })).rejects.toThrow(/must start with/);
  });

  it('closes even with keep-alive connections open', async () => {
    fixture = await startFixtureServer({ '/a': 'x' });
    await (await fetch(`${fixture.baseUrl}/a`)).text();
    const t0 = performance.now();
    await fixture.close();
    fixture = undefined;
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
