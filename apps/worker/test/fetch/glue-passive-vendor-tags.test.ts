// isValidContent: an anti-bot vendor's passive tag script on a normal page is
// not a block. Only challenge markup (the DataDome captcha iframe or
// interstitial on captcha-delivery.com, PerimeterX's #px-captcha, a
// ShieldSquare captcha) or a blocking status marks a response as blocked.

import { describe, expect, it } from 'vitest';
import { assessTier } from '../../src/engine/router.js';
import { isValidContent } from '../../src/engine/tier1-http.js';

const URL_ = 'https://news.example.org/2026/10/harbour-reopens';

/** A short (< 10 KB) real article with the given extra head/body markup. */
function article(head: string, tail = ''): string {
  const paragraphs = [
    'The harbour reopened on Tuesday after three weeks of dredging work that deepened the main channel by almost two metres.',
    'Ferry operators said the first crossings ran on time, and the port authority expects freight traffic to return to normal by the end of the month.',
    'Local fishermen, who had moored their boats in the neighbouring bay during the works, welcomed the reopening but asked for clearer notice next time.',
    'The council will publish a report on the cost of the works, which ran slightly over the original budget, at its November meeting.',
  ].map((p) => `<p>${p}</p>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Harbour reopens after dredging | Coast News</title>${head}</head>` +
    `<body><header><a href="/">Coast News</a></header><main><article><h1>Harbour reopens after dredging</h1><time datetime="2026-10-06">6 October 2026</time>${paragraphs}</article></main>` +
    `<footer><p>© 2026 Coast News</p></footer>${tail}</body></html>`;
}

const DATADOME_TAG =
  `<script>window.ddjskey = '2211F522B61E269B869FA6EAFFB5E1'; window.ddoptions = { ajaxListenerPath: true };</script>` +
  `<script src="https://js.datadome.co/tags.js" async></script>`;
const RECAPTCHA_V3 =
  `<script src="https://www.google.com/recaptcha/api.js?render=6LcAbCdEfGhIjKlMnOpQrStUvWxYz"></script>` +
  `<script>grecaptcha.ready(function(){grecaptcha.execute('6LcAbCdEfGhIjKlMnOpQrStUvWxYz',{action:'homepage'})});</script>`;
const PERIMETERX_SENSOR =
  `<script>(function(){window._pxAppId='PXa1b2c3d4';var p=document.createElement('script');p.src='//client.perimeterx.net/PXa1b2c3d4/main.min.js';document.head.appendChild(p);})();</script>`;
const SHIELDSQUARE_TAG = `<script src="https://cdn.perfdrive.com/aperture/aperture.js" data-name="shieldsquare"></script>`;

describe('isValidContent: passive anti-bot tags are not blocks', () => {
  it.each([
    ['DataDome tag + reCAPTCHA v3', article(DATADOME_TAG + RECAPTCHA_V3)],
    ['PerimeterX sensor', article(PERIMETERX_SENSOR)],
    ['ShieldSquare tag', article(SHIELDSQUARE_TAG)],
  ])('%s on a short article is valid content, so no tier rejects it outright', (_name, html) => {
    expect(html.length).toBeLessThan(10_000);
    expect(isValidContent(html, 200, URL_)).toBe(true);
    // The terminal tier accepts it (before, every tier rejected it and the job
    // failed as "All tiers exhausted"). Whether T1 already accepts it is the
    // quality scorer's call (its own marker list).
    expect(assessTier(html, 200, 5, 30, URL_, true).ok).toBe(true);
  });

  it('the same article with a blocking status is still rejected', () => {
    const html = article(DATADOME_TAG + RECAPTCHA_V3);
    for (const status of [403, 429, 503]) expect(isValidContent(html, status, URL_)).toBe(false);
  });
});

describe('isValidContent: vendor challenge markup is still a block', () => {
  it.each([
    [
      'DataDome captcha iframe',
      `<html><head><title>news.example.org</title></head><body style="margin:0"><iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=AHrlqAAA&hash=2211F522&cid=abc&t=fe" title="DataDome CAPTCHA" width="100%" height="100%" style="height:100vh;" frameborder="0"></iframe></body></html>`,
    ],
    [
      'DataDome device-check interstitial',
      `<html><head><title>news.example.org</title></head><body><script>var dd={'rt':'i','cid':'AHrlqAAAAAMA','hsh':'2211F522B61E','b':1,'s':17434,'host':'geo.captcha-delivery.com'}</script><script src="https://ct.captcha-delivery.com/i.js"></script></body></html>`,
    ],
    [
      'DataDome captcha iframe without the delivery host',
      `<html><body><iframe src="/captcha/?initialCid=AHrlqAAA" title="DataDome CAPTCHA" width="100%" height="100%"></iframe></body></html>`,
    ],
    [
      'PerimeterX press-and-hold',
      `<html><head><title>Access to this page has been denied</title></head><body><div id="px-captcha"></div>${PERIMETERX_SENSOR}</body></html>`,
    ],
    [
      'ShieldSquare captcha redirect',
      `<html><head><title>ShieldSquare Captcha</title></head><body><script>window.location.href="https://validate.perfdrive.com/captcha?ssa=abc&ssb=def"</script></body></html>`,
    ],
  ])('%s', (_name, html) => {
    expect(isValidContent(html, 200, URL_)).toBe(false);
  });
});
