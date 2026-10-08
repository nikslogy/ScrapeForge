// Captures golden outputs of the content-extraction pipeline (pipeline-impl's
// extractContent) for every page of the offline corpus
// (tests/fixtures/extraction/*/page.html), the latency fixtures
// (tests/latency/lib/fixtures.ts) and a few degenerate inputs.
//
// The committed golden files were captured from the pre-linkedom
// implementation (JSDOM + Readability, commit a15ea6c) before it was
// rewritten; golden.test.ts compares the current implementation against them
// with an explicit allow-list of intentional differences. Re-capturing from the
// current implementation would erase that baseline, so this script refuses to
// overwrite an existing golden file unless --force is given.
//
//   npx tsx apps/worker/test/extraction/golden/capture.ts [--impl <path>] [--force]
//
// --impl points at another copy of pipeline-impl.ts (e.g. the old version
// restored with `git show a15ea6c:apps/worker/src/extraction/pipeline-impl.ts`
// into a file inside apps/worker so its imports resolve).

import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GOLDEN_DIR, goldenCases, goldenFile, type GoldenRecord } from './cases.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const implIdx = args.indexOf('--impl');
const implPath = implIdx >= 0 ? resolve(args[implIdx + 1]!) : resolve(GOLDEN_DIR, '../../../src/extraction/pipeline-impl.ts');

const impl = (await import(pathToFileURL(implPath).href)) as typeof import('../../../src/extraction/pipeline-impl.js');

let written = 0;
for (const c of goldenCases()) {
  const file = goldenFile(c.id);
  if (existsSync(file) && !force) {
    console.log(`skip ${c.id} (exists; --force to overwrite)`);
    continue;
  }
  const all = await impl.extractContent(c.html, c.url, ['markdown', 'text', 'html']);
  const htmlOnly = await impl.extractContent(c.html, c.url, ['html']);
  const record: GoldenRecord = {
    id: c.id,
    source: c.source,
    url: c.url,
    inputBytes: Buffer.byteLength(c.html),
    all: {
      extractionMethod: all.extractionMethod,
      title: all.title,
      description: all.description,
      markdown: all.markdown,
      text: all.text,
      html: all.html,
    },
    htmlOnly: {
      extractionMethod: htmlOnly.extractionMethod,
      title: htmlOnly.title,
      description: htmlOnly.description,
    },
  };
  writeFileSync(file, `${JSON.stringify(record, null, 1)}\n`);
  written++;
  console.log(`wrote ${c.id}: method=${all.extractionMethod} md=${all.markdown?.length} text=${all.text?.length} html=${all.html?.length}`);
}
console.log(`${written} golden file(s) written to ${GOLDEN_DIR} from ${implPath}`);
