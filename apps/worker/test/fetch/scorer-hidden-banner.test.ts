// Block phrases are what block pages *say*. A browser-warning banner a site
// ships hidden on every page ("You are using an unsupported browser. Please
// update your browser...") must not reject a normal article at every tier.
import { describe, expect, it } from 'vitest';
import { assessTier } from '../../src/engine/router.js';
import { analyzeHtml, calculateQualityScore } from '../../src/extraction/quality-scorer.js';
import { GATE_SAMPLES } from './gate-samples.js';

const URL_ = 'https://www.ridgeline.example/guides/rain';
const BODY =
  '<main><article><h1>How to pitch a tent in the rain</h1>' +
  Array.from(
    { length: 8 },
    (_, i) =>
      `<p>Step ${i + 1}: keep the inner tent packed inside the fly while you stake out the corners, then clip the poles and tension the guylines so water runs off the fly instead of pooling on it.</p>`,
  ).join('') +
  '</article></main>';
const HEAD =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pitching a tent in the rain</title><link rel="stylesheet" href="/site.css"></head>' +
  '<body><header><nav><a href="/">Home</a> <a href="/guides">Guides</a></nav></header>';
const FOOT = '<footer><p>© 2026 Ridgeline Outdoor Co.</p></footer></body></html>';
const WARNING = '<p>You are using an unsupported browser. Please update your browser for the best experience on our site.</p>';

const article = (banner: string) => `${HEAD}${banner}${BODY}${FOOT}`;

describe('hidden browser-warning banners', () => {
  it.each([
    ['display:none', `<div id="browser-warning" style="display:none">${WARNING}</div>`],
    ['display: none with other rules', `<div class="bw" style="color:red; DISPLAY : NONE !important">${WARNING}</div>`],
    ['visibility:hidden', `<section style="visibility:hidden"><div>${WARNING}</div></section>`],
    ['the hidden attribute', `<div class="browser-warning" hidden>${WARNING}</div>`],
    ['hidden="hidden"', `<aside hidden="hidden"><div><div>${WARNING}</div></div></aside>`],
  ])('a banner hidden by %s is not a bot indicator', (_name, banner) => {
    const html = article(banner);
    const q = calculateQualityScore(html, 200, 1, 100);
    expect(q.signals.join('; ')).not.toMatch(/Bot detection indicators/);
    expect(q.score).toBe(1);
    expect(assessTier(html, 200, 1, 100, URL_).ok).toBe(true);
  });

  it('text after the hidden element is checked again', () => {
    const html = article(`<div style="display:none"><div>${WARNING}</div></div><p>Access denied.</p>`);
    expect(calculateQualityScore(html, 200, 1, 100).signals.join('; ')).toMatch(/Bot detection indicators: access denied/);
  });

  it('hidden text still counts as text (only phrase checks skip it)', () => {
    const banner = `<div style="display:none">${WARNING}</div>`;
    expect(analyzeHtml(article(banner)).textLen).toBeGreaterThan(analyzeHtml(article('')).textLen);
    expect(analyzeHtml(article(banner)).textSample).not.toContain('unsupported browser');
  });

  it('look-alike attributes do not hide anything', () => {
    for (const attrs of ['type="hidden"', 'class="hidden-xs"', 'data-style="display:none"', 'aria-hidden="true"', 'title="display:none"']) {
      const a = analyzeHtml(`<div ${attrs}><p>Access denied</p></div>`);
      expect(a.textSample, attrs).toContain('access denied');
    }
  });

  it('a visible banner (hidden by a stylesheet the scorer cannot see) costs one indicator, not two', () => {
    const html = article(`<div class="browser-warning">${WARNING}</div>`);
    const q = calculateQualityScore(html, 200, 1, 100);
    expect(q.signals.join('; ')).toMatch(/Bot detection indicators: unsupported browser$|Bot detection indicators: unsupported browser;/);
    expect(q.score).toBeCloseTo(0.7, 5);
    expect(assessTier(html, 200, 1, 100, URL_).ok).toBe(true);
  });

  it('the unsupported-browser block page is still rejected', () => {
    const s = GATE_SAMPLES.find((x) => x.id === 'unsupported-browser')!;
    expect(assessTier(s.html, 200, 1, 30, URL_).ok).toBe(false);
    expect(calculateQualityScore(s.html, 200, 1, 30).score).toBeLessThanOrEqual(0.3);
  });
});
