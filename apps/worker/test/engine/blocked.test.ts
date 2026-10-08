import { describe, expect, it } from 'vitest';
import { buildSourceDocument } from '../../src/extract/document/index.js';
import { blockedFromQualitySignals, decimalSeparatorFromHtml, detectBlockedPage } from '../../src/extract/engine.js';
import { calculateQualityScore } from '../../src/extraction/quality-scorer.js';
import { loadFixtures } from '../../../../tests/fixtures/extraction/load.js';
import { page } from './helpers.js';

function detect(html: string): ReturnType<typeof detectBlockedPage> {
  return detectBlockedPage(buildSourceDocument(html, 'https://shop.example.com/p/1'), html);
}

const ARTICLE = Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i}: the shop sells sturdy outdoor gear for hiking, camping and climbing trips.</p>`).join('');

describe('detectBlockedPage', () => {
  it('classifies the corpus challenge page as blocked and no other fixture', () => {
    const blocked = loadFixtures()
      .filter((f) => detectBlockedPage(buildSourceDocument(f.html, f.url), f.html) !== null)
      .map((f) => f.id);
    expect(blocked).toEqual(['challenge-page']);
    const f = loadFixtures({ ids: ['challenge-page'] })[0];
    expect(detectBlockedPage(buildSourceDocument(f.html, f.url), f.html)).toEqual({ reason: 'challenge_page', signals: ['title', 'text', 'markup'] });
  });

  it.each([
    ['Cloudflare block page', page('<h1>Sorry, you have been blocked</h1><p>You are unable to access example.com</p>', '<title>Attention Required! | Cloudflare</title>')],
    ['Akamai access denied', page("<h1>Access Denied</h1><p>You don't have permission to access this resource on this server.</p>", '<title>Access Denied</title>')],
    ['DataDome interstitial', page('<p>Please enable JS and disable any ad blocker</p><iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=x"></iframe>')],
    ['PerimeterX', page('<h1>Access to this page has been denied</h1><div id="px-captcha"></div><p>Press &amp; Hold to confirm you are a human (and not a bot).</p>')],
    ['Cloudflare JS challenge in another language', page('<noscript>Enable JavaScript and cookies to continue</noscript><div id="challenge-body-text"></div><script>window._cf_chl_opt={cvId:"3"}</script>', '<title>Un instant…</title>')],
  ])('classifies a %s', (_label, html) => {
    expect(detect(html)?.reason).toBe('challenge_page');
  });

  it.each([
    ['a product page with a captcha widget in a review form', page(`<h1>Trail Tent</h1><p>$199.00</p>${ARTICLE}<form><div class="cf-turnstile"></div><button>Post review</button></form>`)],
    ['an article about bot detection', page(`<h1>Just a moment: how sites check your browser</h1>${ARTICLE}<p>Pages say "Checking your browser" and "Verify you are human".</p>`)],
    ['a short legitimate page', page('<h1>Example Domain</h1><p>This domain is for use in illustrative examples in documents.</p>', '<title>Example Domain</title>')],
    ['a short page with only one weak signal', page(`<h1>Contact us</h1><p>${'Write to us any time and we will answer within a day. '.repeat(12)}</p><div class="cf-turnstile"></div>`)],
    ['an empty page', ''],
  ])('does not classify %s', (_label, html) => {
    expect(detect(html)).toBeNull();
  });
});

describe('blockedFromQualitySignals', () => {
  it('needs bot-wall keywords plus a blocking status or a near-zero score', () => {
    const challenge = loadFixtures({ ids: ['challenge-page'] })[0].html;
    expect(blockedFromQualitySignals(calculateQualityScore(challenge, 200, 1, 500), 200)).toEqual({ reason: 'bot_wall' });
    expect(blockedFromQualitySignals(calculateQualityScore(challenge, 403, 1, 500), 403)).toEqual({ reason: 'bot_wall_http_403' });
    expect(blockedFromQualitySignals({ score: 0.7, signals: ['Bot detection indicators: captcha'] }, 200)).toBeUndefined();
    expect(blockedFromQualitySignals({ score: 0.1, signals: ['Very short content (possible block page)'] }, 200)).toBeUndefined();
    // An SPA shell's "enable JavaScript" notice is not a challenge (next-data scores 0 for that reason).
    expect(blockedFromQualitySignals({ score: 0, signals: ['Bot detection indicators: enable javascript to run'] }, 200)).toBeUndefined();
    expect(blockedFromQualitySignals({ score: 0.2, signals: ['Bot detection indicators: captcha, verify you are human'] }, 200)).toEqual({ reason: 'bot_wall' });
    expect(blockedFromQualitySignals({ score: 0.5, signals: ['Bot detection indicators: rate limit'] }, 429)).toEqual({ reason: 'bot_wall_http_429' });
    for (const f of loadFixtures()) {
      if (f.id === 'challenge-page') continue;
      expect(blockedFromQualitySignals(calculateQualityScore(f.html, 200, 1, 500), 200), f.id).toBeUndefined();
    }
  });
});

describe('decimalSeparatorFromHtml', () => {
  it.each([
    ['<html lang="de">', ','],
    ['<html lang="de-DE">', ','],
    ['<html class="x" lang=fr_FR>', ','],
    ['<html lang="de-CH">', '.'],
    ['<html lang="es-MX">', '.'],
    ['<html lang="en-US">', '.'],
    ['<html lang="en-ZA">', ','],
    ['<html lang="xx">', undefined],
    ['<html>', undefined],
    ['<!doctype html><HTML LANG="pt-BR">', ','],
    ['', undefined],
  ])('%s → %s', (html, expected) => {
    expect(decimalSeparatorFromHtml(html)).toBe(expected);
  });

  it('only looks at the start of the document', () => {
    expect(decimalSeparatorFromHtml(`${' '.repeat(20_000)}<html lang="de">`)).toBeUndefined();
  });
});
