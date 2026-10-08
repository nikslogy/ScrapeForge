// Seeded random HTML for the equivalence tests: markup mixes that exercise
// whitespace collapsing, flanking whitespace, markdown escapes at text-node
// starts, blank/void elements, lists, code, links, noise selectors and the
// density / largest-block candidates. Deterministic per seed.
import { seededRandom } from '../../../../tests/latency/lib/fixtures.js';

const TEXTS = [
  'word', 'two words', ' leading', 'trailing ', '  both  ', '\n', '\t', ' ', '',
  'line\nbreak', '&nbsp;', 'a&nbsp;b', '&amp;', '&gt; quote', '- dash', '+ plus', '1. one', '# hash',
  '[bracket]', '[', ']', '(javascript:x)', '*star*', '_under_', '`tick`', '~~~', '===', '\\back',
  'Long sentence with several words that keeps going for a while so density has text.',
  'caf&eacute;', '&#x1F600;', '&lt;tag&gt;', ' nbsp ', ' em-space',
];

const INLINE = ['span', 'a', 'em', 'strong', 'b', 'i', 'code', 'small'];
const BLOCK = ['div', 'p', 'section', 'article', 'main', 'blockquote', 'h2', 'h3', 'ul', 'ol', 'pre', 'table', 'nav', 'footer', 'aside', 'header'];
const VOID = ['br', 'img', 'hr', 'input', 'wbr'];
const CLASSES = ['post-content', 'entry-content', 'article-body', 'story-body', 'content-body', 'card', 'ad', 'cookie-banner', 'modal-x', 'x y', 'fallback-image'];

export function randomHtml(seed: number, opts: { depth?: number; width?: number } = {}): string {
  const rand = seededRandom(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const maxDepth = opts.depth ?? 5;
  const maxWidth = opts.width ?? 5;

  const attrs = (): string => {
    let out = '';
    if (rand() < 0.25) out += ` class="${pick(CLASSES)}"`;
    if (rand() < 0.08) out += ` id="${pick(['article-body', 'main', 'cookie-x', 'banner1', 'x'])}"`;
    if (rand() < 0.05) out += ' role="main"';
    if (rand() < 0.04) out += ' data-shadow-flattened';
    if (rand() < 0.04) out += ' aria-hidden="true"';
    if (rand() < 0.05) out += ` style="${pick(['display:none', 'display: none !important', 'DISPLAY:NONE', 'visibility:hidden', 'color:red'])}"`;
    if (rand() < 0.03) out += ' hidden';
    return out;
  };

  const node = (depth: number, inPre: boolean): string => {
    const r = rand();
    if (depth >= maxDepth || r < 0.35) return pick(TEXTS);
    if (r < 0.42) {
      const v = pick(VOID);
      if (v === 'img') {
        const src = pick(['https://e.com/a.png', 'data:image/gif;base64,R0lGOD', '', '/rel.png', 'a b.png']);
        return `<img src="${src}" alt="${pick(['alt text', '', 'a\n\nb', 'x(y)'])}"${rand() < 0.3 ? ' title="t"' : ''}>`;
      }
      return `<${v}>`;
    }
    if (r < 0.45) return '<!-- comment -->';
    const tag = r < 0.7 ? pick(INLINE) : pick(BLOCK);
    const kids = Math.floor(rand() * maxWidth);
    const body = (childTag?: string): string =>
      Array.from({ length: kids }, () => (childTag ? `<${childTag}>${node(depth + 2, inPre)}</${childTag}>` : node(depth + 1, inPre || tag === 'pre'))).join(rand() < 0.5 ? '' : pick([' ', '\n', '  \n  ']));
    let attr = attrs();
    if (tag === 'a') attr += ` href="${pick(['https://example.com/x', '/rel', '#frag', 'javascript:void(0)', 'a b'])}"${rand() < 0.3 ? ' title="Link title"' : ''}`;
    if (tag === 'ol' && rand() < 0.4) attr += ` start="${Math.floor(rand() * 5)}"`;
    if (tag === 'ul' || tag === 'ol') return `<${tag}${attr}>${body('li')}</${tag}>`;
    if (tag === 'table') return `<table${attr}><tr>${body('td')}</tr></table>`;
    if (tag === 'pre' && rand() < 0.5) return `<pre${attr}><code class="language-js">${body()}</code></pre>`;
    return `<${tag}${attr}>${body()}</${tag}>`;
  };

  return Array.from({ length: 1 + Math.floor(rand() * maxWidth) }, () => node(0, false)).join(pick(['', '\n', ' ']));
}

/** A full document around random body content, with some head metadata. */
export function randomDocument(seed: number): string {
  const rand = seededRandom(seed ^ 0x5bd1e995);
  const head = [
    '<title>Random page</title>',
    rand() < 0.5 ? '<meta name="description" content="Random description text">' : '',
    rand() < 0.3 ? '<script>var x = "<p>not content</p>";</script>' : '',
    rand() < 0.3 ? '<style>p{color:red}</style>' : '',
  ].join('');
  // Paragraph blocks inside density / largest-block candidates, with random
  // siblings, so both strategies have something to score and compare.
  const block = (): string => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 7}`).join(rand() < 0.2 ? '  \n ' : ' ');
    const paragraphs = Array.from({ length: Math.floor(rand() * 5) }, () => `<p>${words(5 + Math.floor(rand() * 25))}</p>`);
    const siblings = Array.from({ length: Math.floor(rand() * 3) }, () => randomHtml(Math.floor(rand() * 1e6), { depth: 2, width: 3 }));
    const tag = ['div', 'section', 'article', 'main', 'div class="entry-content"', 'div role="main"', 'div id="article-body"'][Math.floor(rand() * 7)]!;
    const name = tag.split(' ')[0];
    return `<${tag}>${[...paragraphs, ...siblings].sort(() => rand() - 0.5).join('')}</${name}>`;
  };
  const blocks = Array.from({ length: 1 + Math.floor(rand() * 3) }, block).join('');
  return `<!doctype html><html><head>${head}</head><body>${randomHtml(seed, { depth: 6, width: 6 })}${blocks}${randomHtml(seed + 1)}</body></html>`;
}
