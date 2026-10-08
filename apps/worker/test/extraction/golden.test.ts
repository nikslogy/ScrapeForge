// Current content extraction vs the golden outputs captured from the
// JSDOM-based implementation (commit a15ea6c) before the linkedom rewrite:
// every corpus page, the latency fixtures, degenerate inputs and the
// synthetic pages in golden/synthetic.ts, for all three formats and for an
// html-only request. Outputs must be identical except for the reviewed
// differences in ALLOWED_DIFFERENCES, each of which pins the exact change.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractContent, type ExtractionResult } from '../../src/extraction/pipeline-impl.js';
import { goldenCases, goldenFile, readGolden, type GoldenCase, type GoldenRecord } from './golden/cases.js';

const FIELDS = ['extractionMethod', 'title', 'description', 'markdown', 'text', 'html'] as const;
type Field = (typeof FIELDS)[number];

interface AllowedDifference {
  /** Fields that may differ; every other field must still be identical. */
  fields: Field[];
  why: string;
  /** Pins the new values of `fields`. */
  check(golden: GoldenRecord['all'], actual: ExtractionResult, c: GoldenCase): Promise<void> | void;
}

const ALLOWED_DIFFERENCES: Record<string, AllowedDifference> = {
  'synthetic-hidden-styles': {
    fields: ['markdown', 'text'],
    why:
      'An element styled "DISPLAY: NONE" is now hidden. JSDOM stored the value as "NONE" and ' +
      "Readability's `display != \"none\"` kept the text; browsers treat CSS keywords " +
      'case-insensitively and do not show it (hidden text is a prompt-injection vector).',
    check(golden, actual) {
      expect(actual.markdown).toBe(golden.markdown!.replace('UPPERCASE-HIDDEN text\n\n', ''));
      expect(actual.text).toBe(golden.text!.replace('UPPERCASE-HIDDEN text', ''));
    },
  },
  'synthetic-plaintext-tail': {
    fields: ['markdown'],
    why:
      'A <plaintext> element turns the rest of the page into text. The old pipeline serialized ' +
      "Readability's article and turndown re-parsed that string, so the article's own closing tags " +
      'and turndown\'s wrapper became part of that text ("</plaintext></article></div></x-turndown>"). ' +
      'Markdown is now built from the article node: the same text without the markup leftovers.',
    check(golden, actual) {
      const junk = '</plaintext></article></div></x-turndown>';
      expect(golden.markdown!.endsWith(`<b>PLAIN</b> &amp; <i>text${junk}`)).toBe(true);
      expect(actual.markdown).toBe(golden.markdown!.slice(0, -junk.length));
    },
  },
  'synthetic-invalid-url': {
    fields: ['extractionMethod', 'markdown', 'text'],
    why:
      "The page URL does not parse. `new JSDOM(html, { url })` threw, so the old chain skipped " +
      'Readability and fell back to paragraph density. Readability now runs; relative links ' +
      'stay relative because there is no base to resolve them against.',
    async check(golden, actual, c) {
      expect(golden.extractionMethod).toBe('paragraph-density');
      expect(actual.extractionMethod).toBe('readability');
      // Same as the page at a valid URL, minus link resolution.
      const valid = await extractContent(c.html, 'https://valid.example/', ['markdown', 'text']);
      expect(actual.markdown).toBe(valid.markdown!.replace('(https://valid.example/x)', '(/x)'));
      expect(actual.text).toBe(valid.text);
    },
  },
};

const cases = goldenCases();

describe('golden outputs', () => {
  it('cover every corpus page, latency fixture, degenerate and synthetic case', () => {
    const missing = cases.filter((c) => !existsSync(goldenFile(c.id))).map((c) => c.id);
    expect(missing).toEqual([]);
    const sources = new Set(cases.map((c) => c.source));
    expect([...sources].sort()).toEqual(['corpus', 'degenerate', 'latency', 'synthetic']);
    expect(cases.filter((c) => c.source === 'corpus')).toHaveLength(15);
    for (const id of Object.keys(ALLOWED_DIFFERENCES)) expect(cases.map((c) => c.id)).toContain(id);
  });

  it.each(cases.map((c) => [c.id, c] as const))('%s', async (id, c) => {
    const golden = readGolden(id);
    expect(golden.inputBytes).toBe(Buffer.byteLength(c.html));

    const all = await extractContent(c.html, c.url, ['markdown', 'text', 'html']);
    const allowed = ALLOWED_DIFFERENCES[id];
    for (const field of FIELDS) {
      if (allowed?.fields.includes(field)) continue;
      expect(all[field], `${id}: ${field}`).toBe(golden.all[field]);
    }
    if (allowed) {
      // A listed difference must still be a difference, or the entry is stale.
      expect(allowed.fields.some((f) => all[f] !== golden.all[f]), `${id}: allow-list entry is stale`).toBe(true);
      await allowed.check(golden.all, all, c);
    }

    const htmlOnly = await extractContent(c.html, c.url, ['html']);
    expect({
      extractionMethod: htmlOnly.extractionMethod,
      title: htmlOnly.title,
      description: htmlOnly.description,
    }).toEqual(golden.htmlOnly);
  });
});
