// The T1 acceptance gate (router.ts assessTier = isValidContent +
// calculateQualityScore ≥ 0.55) against a hand-labelled table of small
// responses, the extraction corpus, and hostile markup.
import { describe, expect, it } from 'vitest';
import { assessTier, MIN_TIER_ACCEPT_QUALITY } from '../../src/engine/router.js';
import { blockedFromQualitySignals } from '../../src/extract/engine.js';
import { isValidContent } from '../../src/engine/tier1-http.js';
import { analyzeHtml, calculateQualityScore } from '../../src/extraction/quality-scorer.js';
import { loadFixtures } from '../../../../tests/fixtures/extraction/load.js';
import { largePage, smallPage } from '../../../../tests/latency/lib/fixtures.js';
import { GATE_SAMPLES } from './gate-samples.js';

const DEFAULT_URL = 'https://example.org/page';

function gate(html: string, status = 200, url = DEFAULT_URL) {
  return assessTier(html, status, 1, 30, url);
}

describe('labelled small-page table', () => {
  it('has at least 25 samples of each kind in total, with unique ids', () => {
    expect(GATE_SAMPLES.length).toBeGreaterThanOrEqual(25);
    expect(GATE_SAMPLES.filter((s) => s.label === 'accept').length).toBeGreaterThanOrEqual(10);
    expect(GATE_SAMPLES.filter((s) => s.label === 'reject').length).toBeGreaterThanOrEqual(15);
    expect(new Set(GATE_SAMPLES.map((s) => s.id)).size).toBe(GATE_SAMPLES.length);
  });

  it.each(GATE_SAMPLES.map((s) => [s.id, s] as const))('%s', (_id, sample) => {
    const v = gate(sample.html, sample.status, sample.url);
    const detail = v.ok ? `score ${v.score}` : v.reason;
    expect(`${v.ok ? 'accept' : 'reject'} (${detail})`).toMatch(new RegExp(`^${sample.label} `));
  });

  it('classic example.com (1,256 B) is accepted at T1 with a high score', () => {
    const html = smallPage();
    expect(html.length).toBe(1256);
    const q = calculateQualityScore(html, 200, 1, 30);
    expect(q.score).toBeGreaterThanOrEqual(0.8);
    expect(q.signals[0]).toMatch(/^Short page/);
    expect(gate(html, 200, 'https://example.com/')).toEqual({ ok: true, score: q.score });
  });

  it('the walmart stub is caught by isValidContent on walmart.com and by the scorer anywhere', () => {
    const stub = GATE_SAMPLES.find((s) => s.id === 'walmart-stub-other-url')!;
    expect(stub.html.length).toBe(423);
    expect(isValidContent(stub.html, 200, 'https://www.walmart.com/ip/1')).toBe(false);
    expect(isValidContent(stub.html, 200, DEFAULT_URL)).toBe(true);
    expect(calculateQualityScore(stub.html, 200, 1, 30).score).toBeLessThan(MIN_TIER_ACCEPT_QUALITY);
  });
});

describe('extraction corpus', () => {
  const fixtures = loadFixtures();

  it.each(fixtures.map((f) => [f.id, f] as const))('%s', (id, f) => {
    const blockPage = id === 'challenge-page';
    const q = calculateQualityScore(f.html, 200, 1, 30);
    expect(gate(f.html, 200, f.url).ok).toBe(!blockPage);
    if (blockPage) {
      expect(q.score).toBeLessThanOrEqual(0.3);
      expect(blockedFromQualitySignals(q, 200)).toEqual({ reason: 'bot_wall' });
    } else {
      expect(q.score).toBeGreaterThanOrEqual(MIN_TIER_ACCEPT_QUALITY);
      // Legitimate pages, SSR/JS-framework ones included, carry no bot signal at all.
      expect(q.signals.join('; ')).not.toMatch(/Bot detection indicators/);
      expect(blockedFromQualitySignals(q, 200)).toBeUndefined();
    }
  });

  it('next-data (a pre-hydration Next.js page) is a short page, not a bot page', () => {
    const f = fixtures.find((x) => x.id === 'next-data')!;
    const q = calculateQualityScore(f.html, 200, 1, 30);
    expect(q.score).toBeGreaterThanOrEqual(0.8);
    expect(q.signals[0]).toMatch(/^Short page/);
  });

  it('a 500 KB content page scores 1.0', () => {
    expect(calculateQualityScore(largePage(), 200, 1, 30).score).toBe(1);
  });
});

describe('server-rendered pages', () => {
  const skeleton = GATE_SAMPLES.find((s) => s.id === 'next-skeleton-with-data')!.html;

  it('substantial JSON page data is what accepts a skeleton page', () => {
    expect(analyzeHtml(skeleton).dataBytes).toBeGreaterThanOrEqual(1024);
    expect(gate(skeleton).ok).toBe(true);
    const withoutData = skeleton.replace(/<script id="__NEXT_DATA__"[\s\S]*?<\/script>/, '');
    expect(withoutData).not.toContain('__NEXT_DATA__');
    expect(gate(withoutData).ok).toBe(false);
    // Tiny state (a build id, empty props) is not page data.
    const tiny = skeleton.replace(/(<script id="__NEXT_DATA__" type="application\/json">)[\s\S]*?(<\/script>)/, '$1{"props":{"pageProps":{}},"page":"/"}$2');
    expect(gate(tiny).ok).toBe(false);
  });

  it('counts JSON data scripts (any */*json type) as data, not as executable scripts', () => {
    const a = analyzeHtml(
      '<script type="application/ld+json">{"a":1}</script><script type="application/json; charset=utf-8">[1,2]</script>' +
        '<script type="application/vnd.api+json">{}</script><script>var x = 1;</script><script type="module">import "/a.js"</script>',
    );
    expect(a.dataBytes).toBe('{"a":1}'.length + '[1,2]'.length + '{}'.length);
    expect(a.scriptCount).toBe(2);
  });

  it('ignores block markers inside JSON data but not in markup or inline scripts', () => {
    const page = (extra: string) =>
      `<html><body><h1>Contact us</h1><p>Write to hello@example.org and we answer within one working day.</p>${extra}</body></html>`;
    expect(gate(page('<script type="application/json">{"captchaSiteKey":"x","recaptcha":{"enabled":false}}</script>')).ok).toBe(true);
    // isValidContent's fast keyword check still sees vendor names anywhere in a small page.
    const vendorInData = page('<script type="application/json">{"antibot":"datadome"}</script>');
    expect(calculateQualityScore(vendorInData, 200, 1, 30).signals.join('; ')).not.toMatch(/Bot detection/);
    expect(gate(page('<div class="g-recaptcha" data-sitekey="x"></div>')).ok).toBe(false);
    expect(gate(page('<script>var dd={host:"geo.captcha-delivery.com"}</script>')).ok).toBe(false);
  });

  it('a JavaScript-required notice counts only when visible, and is not a bot indicator', () => {
    const body = '<main><h1>Changelog</h1><p>Version 3.2 adds dark mode, faster search and offline drafts.</p></main>';
    const inNoscript = `<html><body><noscript>Please enable JavaScript to run this app.</noscript>${body}</body></html>`;
    const visible = `<html><body><div class="warn">Please enable JavaScript to run this app.</div>${body}</body></html>`;
    expect(gate(inNoscript).ok).toBe(true);
    const q = calculateQualityScore(visible, 200, 1, 30);
    expect(gate(visible).ok).toBe(false);
    expect(q.signals[0]).toMatch(/^JavaScript required notice/);
    expect(q.signals.join('; ')).not.toMatch(/Bot detection indicators/);
    // With a blocking status the notice is the interstitial's text, and the
    // engine classifies the page by status (extract/engine.ts).
    const stub = '<html><body><h1>Please enable JavaScript to continue.</h1></body></html>';
    expect(blockedFromQualitySignals(calculateQualityScore(stub, 403, 1, 30), 403)).toEqual({ reason: 'bot_wall_http_403' });
    expect(blockedFromQualitySignals(calculateQualityScore(stub, 200, 1, 30), 200)).toBeUndefined();
    // On a page with real content the notice is harmless.
    const long = `<html><body><div class="warn">Please enable JavaScript.</div><article>${'<p>Plenty of server-rendered text about the release and what changed in it. </p>'.repeat(10)}</article></body></html>`;
    expect(calculateQualityScore(long, 200, 1, 30).score).toBeGreaterThanOrEqual(0.8);
  });
});

describe('calculateQualityScore', () => {
  it('keeps its report shape and clamps to [0, 1]', () => {
    const q = calculateQualityScore('<p>x</p>', 500, 4, 20_000);
    expect(Object.keys(q).sort()).toEqual(['score', 'signals']);
    expect(q.score).toBeGreaterThanOrEqual(0);
    expect(q.score).toBeLessThanOrEqual(1);
    expect(q.signals).toEqual(expect.arrayContaining(['Non-200 status code: 500', 'High latency response']));
  });

  it('does not count block phrases in long articles', () => {
    const article = `<html><body><article><h1>Web scraping</h1>${'<p>Sites answer bots with access denied pages, a captcha, or a just a moment interstitial; this paragraph only describes them. </p>'.repeat(100)}</article></body></html>`;
    expect(article.length).toBeGreaterThan(10_000);
    expect(calculateQualityScore(article, 200, 1, 30).score).toBe(1);
    expect(gate(article).ok).toBe(true);
  });

  it('a short page stops being "short but complete" once its markup is bloated', () => {
    const body = '<h1>Title</h1><p>This is one sentence of real text on an otherwise empty page.</p>';
    const small = `<html><body>${body}</body></html>`;
    const bloated = `<html><body>${'<div class="wrapper"><span class="x"></span></div>'.repeat(400)}${body}</body></html>`;
    expect(gate(small).ok).toBe(true);
    expect(gate(bloated).ok).toBe(false);
  });

  it('treats a page that only navigates away as a stub, whatever form the navigation takes', () => {
    const text = '<h1>Welcome</h1><p>Please wait while we take you to the right regional storefront for you.</p>';
    for (const nav of [
      '<script>window.location.href = "/us/";</script>',
      '<script>location = "/us/"</script>',
      '<script>top.location.replace("/us/")</script>',
      '<script>document.location.assign("/us/")</script>',
      '<meta http-equiv="refresh" content="2;URL=\'/us/\'">',
    ]) {
      expect(gate(`<html><head>${nav}</head><body>${text}</body></html>`).ok, nav).toBe(false);
    }
    // Comparisons and slow auto-refresh are not navigation.
    for (const benign of [
      '<script>if (location.href == document.referrer) console.log(1)</script>',
      '<meta http-equiv="refresh" content="600">',
      '<script type="application/json">{"location":"=x"}</script>',
    ]) {
      expect(gate(`<html><head>${benign}</head><body>${text}</body></html>`).ok, benign).toBe(true);
    }
  });

  it('recognises empty mount points but not filled ones', () => {
    for (const shell of ['<div id="__next"></div>', '<div id="app">  <!-- app --> </div>', '<app-root></app-root>', "<main id='root'></main>"]) {
      expect(analyzeHtml(`<body>${shell}<script src="/a.js"></script></body>`).emptyMountPoint, shell).toBe(true);
    }
    expect(analyzeHtml('<body><div id="root"><h1>Server-rendered</h1></div></body>').emptyMountPoint).toBe(false);
    expect(analyzeHtml('<body><div id="modal-root"></div></body>').emptyMountPoint).toBe(false);
  });

  it('measures visible text like a browser renders it', () => {
    const a = analyzeHtml(
      '<html><head><title>T</title><style>p{color:red}</style></head><body><ul><li>a</li><li>b</li></ul>' +
        '<script>var x = "<p>not text</p>";</script><noscript>no js</noscript><p>c&amp;d&nbsp;e</p>' +
        '<!-- <p>comment</p> --><template><p>tpl</p></template><svg><text>svg</text></svg></body></html>',
    );
    expect(a.textLen).toBe('a b c_d e'.length);
    expect(analyzeHtml('<form><textarea>typed <b>text</b></textarea></form>').textLen).toBe('typed <b>text</b>'.length);
    expect(a.auxText).toContain('no js');
    expect(a.scriptCount).toBe(1);
    expect(a.isHtml).toBe(true);
    expect(analyzeHtml('a < b and c > d').isHtml).toBe(false);
  });

  it('measures link text separately', () => {
    const a = analyzeHtml('<p>Read <a href="/x">the docs</a> and <a href="/y">the FAQ</a> first.</p>');
    expect(a.textLen).toBe('Read the docs and the FAQ first.'.length);
    expect(a.linkTextLen).toBeGreaterThanOrEqual('the docs the FAQ'.length);
    expect(a.linkTextLen).toBeLessThan(a.textLen);
  });

  it.each([
    ['unclosed <script> x100k', '<script>'.repeat(100_000)],
    ['unbalanced attribute quote', `<a href="${'x'.repeat(1_000_000)}`],
    ['1 MB of "<"', '<'.repeat(1_000_000)],
    ['200k paragraphs', '<p>a</p>'.repeat(200_000)],
    ['huge noscript of "<"', `<noscript>${'<'.repeat(500_000)}</noscript>`],
    ['300k entities', '&amp;'.repeat(300_000)],
    ['spaces after location', `<script>location${' '.repeat(500_000)}x</script>`],
    ['100k mount points', '<div id="root">'.repeat(100_000)],
  ])('stays linear on hostile markup: %s', (_name, html) => {
    const t0 = performance.now();
    const q = calculateQualityScore(html, 200, 1, 30);
    const ms = performance.now() - t0;
    expect(q.score).toBeGreaterThanOrEqual(0);
    // The previous regex scanner needed ~25 s for the first case.
    expect(ms).toBeLessThan(2_000);
  });
});

describe('isValidContent', () => {
  it.each([
    ['empty', '', 200, false],
    ['whitespace only', ' \n\t ', 200, false],
    ['403', '<p>fine</p>', 403, false],
    ['429', '<p>fine</p>', 429, false],
    ['5xx', '<p>fine</p>', 502, false],
    ['404 page', '<h1>Not Found</h1>', 404, true],
    ['tiny legit page', '<h1>Hi</h1>', 200, true],
    ['incapsula marker', '<script src="/_Incapsula_Resource?x=1"></script>', 200, false],
    ['cloudflare challenge options', '<script>window._cf_chl_opt={}</script>', 200, false],
  ] as const)('%s', (_name, html, status, expected) => {
    expect(isValidContent(html, status)).toBe(expected);
  });

  it('only checks structural markers in the head of large pages', () => {
    const prose = `<html><body>${'<p>An article about access denied errors and DataDome. </p>'.repeat(300)}</body></html>`;
    expect(prose.length).toBeGreaterThan(10_000);
    expect(isValidContent(prose, 200)).toBe(true);
    expect(isValidContent(`<html><head><script src="https://ct.captcha-delivery.com/c.js"></script></head>${prose}`, 200)).toBe(false);
  });

  it('matches content-heavy domains and their subdomains only', () => {
    const stub = '<html><body></body></html>';
    expect(isValidContent(stub, 200, 'https://www.amazon.com/dp/1')).toBe(false);
    expect(isValidContent(stub, 200, 'https://smile.amazon.com./x')).toBe(false);
    expect(isValidContent(stub, 200, 'https://notamazon.com/x')).toBe(true);
    expect(isValidContent(stub, 200, 'not a url')).toBe(true);
  });
});
