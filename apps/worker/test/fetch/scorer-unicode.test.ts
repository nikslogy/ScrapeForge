// The scorer's scanner keeps one coordinate system: characters whose
// lower-case form is longer ('İ' → 'i̇') must not shift tag names, raw-text
// element ends or data-script ranges.
import { describe, expect, it } from 'vitest';
import { assessTier } from '../../src/engine/router.js';
import { analyzeHtml, calculateQualityScore } from '../../src/extraction/quality-scorer.js';

const CONFIG =
  'window.__APP_CONFIG__ = ' +
  JSON.stringify({
    api: 'https://api.magaza.example/v2',
    locale: 'tr-TR',
    features: Array.from({ length: 40 }, (_, i) => `feature_flag_number_${i}`),
  }) +
  ';';

const shell = (title: string) =>
  `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${title}</title><script>${CONFIG}</script>` +
  `<script src="/static/js/main.js" defer></script></head><body><noscript>Bu uygulamayı çalıştırmak için JavaScript'i etkinleştirmeniz gerekir.</noscript>` +
  '<div id="root"></div></body></html>';

describe('scanner offsets with length-changing lower-case characters', () => {
  it('"İ" before the scripts does not turn a CSR shell into visible text', () => {
    expect('İ'.toLowerCase().length).toBe(2);
    const ascii = analyzeHtml(shell('Istanbul Magaza'));
    const turkish = analyzeHtml(shell('İstanbul Mağaza'));
    expect(turkish).toEqual({ ...ascii, auxText: turkish.auxText });
    expect(turkish).toMatchObject({ textLen: 0, scriptCount: 2, emptyMountPoint: true });
    const v = assessTier(shell('İstanbul Mağaza'), 200, 1, 100, 'https://www.magaza.example/urun/1');
    expect(v.ok).toBe(false);
  });

  it('many expanding characters and upper-case tag names', () => {
    const prefix = 'İ'.repeat(200);
    const html = `<HTML><HEAD><TITLE>${prefix}</TITLE><SCRIPT>var s = "<p>${'x'.repeat(300)}</p>";</SCRIPT></HEAD><BODY><DIV ID="APP"></DIV></BODY></HTML>`;
    const a = analyzeHtml(html);
    expect(a).toMatchObject({ textLen: 0, scriptCount: 1, emptyMountPoint: true });
  });

  it('JSON data after "İ" stays excluded from the marker search', () => {
    const page = `<!doctype html><html><head><title>İletişim — İzmir</title></head><body><main><h1>İletişim</h1>` +
      '<p>Bize hello@example.org adresinden yazın, bir iş günü içinde yanıt veriyoruz.</p></main>' +
      `<script type="application/json">{"recaptchaSiteKey":"6Lc_x","captchaEnabled":false,"pad":"${'z'.repeat(50)}"}</script></body></html>`;
    const q = calculateQualityScore(page, 200, 1, 30);
    expect(q.signals.join('; ')).not.toMatch(/Bot detection indicators/);
    expect(q.score).toBeGreaterThanOrEqual(0.8);
  });

  it('text after expanding characters is still measured', () => {
    const a = analyzeHtml('<p>İİİ</p><script>var hidden = 1;</script><p>after</p>');
    expect(a.textLen).toBe('İİİ after'.length);
    expect(a.scriptCount).toBe(1);
    // A byte-order mark and a lone surrogate keep their places too.
    const b = analyzeHtml('﻿<p>İ\ud800</p><SCRIPT>var hidden = 1;</SCRIPT><p>after</p>');
    expect(b.textLen).toBe('İ\ud800 after'.length); // the BOM itself is whitespace
    expect(b.scriptCount).toBe(1);
  });
});
