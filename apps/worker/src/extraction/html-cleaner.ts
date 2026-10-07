import * as cheerio from 'cheerio';

/**
 * Aggressively prunes HTML to minimise LLM token usage.
 * Typically achieves 85-95% token reduction while preserving
 * the semantic structure the model needs for extraction.
 */
// Convert common "rating encoded as class" patterns into explicit numeric
// text so a small LLM can't hallucinate. Triggered on classes matching
// `<prefix> <One|Two|…|Five>` which is the de-facto convention (Amazon,
// books.toscrape, many review sites, Bootstrap-style rating widgets).
const WORD_TO_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
};

function decodeRatingClasses($: cheerio.CheerioAPI): void {
  $('[class*="rating" i], [class*="stars" i]').each((_, el) => {
    if (el.type !== 'tag') return;
    const node = $(el);
    const cls = node.attr('class') || '';
    const words = cls.toLowerCase().split(/\s+/);
    for (const w of words) {
      const num = WORD_TO_NUM[w];
      if (num && !node.attr('data-rating-decoded')) {
        node.attr('data-rating-decoded', String(num));
        // Inject visible text so downstream markdown + LLM both see it.
        if (!node.text().trim()) node.text(`Rating: ${num}/5`);
        break;
      }
    }
  });
}

export function pruneForLlm(html: string, maxChars = 60_000): string {
  const $ = cheerio.load(html);

  decodeRatingClasses($);

  // 1. Remove non-content elements
  $(
    'script, style, noscript, iframe, svg, link, meta, head, ' +
    'nav, footer, header, aside, form, input, button, select, textarea, ' +
    '.ad, .ads, .advertisement, .sidebar, .menu, .nav, ' +
    '[class*="cookie"], [class*="banner"], [class*="popup"], [class*="modal"], ' +
    '[id*="cookie"], [id*="banner"], [id*="popup"], [id*="modal"], ' +
    '[role="navigation"], [role="banner"], [role="complementary"], ' +
    '[aria-hidden="true"], [hidden]',
  ).remove();

  // 2. Strip attributes except ones that encode semantic data.
  //
  // We keep:
  //   - `href`/`src`/`alt` (links and media)
  //   - `colspan`/`rowspan` (table structure)
  //   - `class` (often encodes ratings, status, product type —
  //     e.g. books.toscrape uses `class="star-rating Three"`)
  //   - `data-*` (arbitrary structured metadata, e.g. data-price, data-sku)
  //   - `aria-label`, `title` (often hold the only human-readable version
  //     of a badge/icon)
  //   - `itemtype`/`itemprop` (microdata)
  //
  // Utility-class bloat (Tailwind / Bootstrap) is filtered below so we don't
  // blow the token budget on non-semantic noise.
  const UTILITY_CLASS_RE =
    /^(?:[a-z]+:)?(?:p|m|px|py|mx|my|pt|pb|pl|pr|mt|mb|ml|mr|w|h|min-w|max-w|min-h|max-h|text|bg|border|rounded|flex|grid|gap|space|items|justify|self|content|order|col|row|inline|block|hidden|visible|opacity|shadow|ring|outline|cursor|pointer|select|overflow|whitespace|truncate|font|leading|tracking|align|float|clear|sticky|fixed|absolute|relative|static|top|bottom|left|right|z|transform|translate|rotate|scale|transition|duration|ease|delay|animate|hover|focus|active|disabled|group|peer|dark|sm|md|lg|xl|2xl)[-:].+$/;

  function compactClass(value: string): string {
    const parts = value.split(/\s+/).filter(Boolean);
    const semantic = parts.filter((c) => !UTILITY_CLASS_RE.test(c));
    return semantic.slice(0, 6).join(' ');
  }

  $('*').each((_, el) => {
    if (el.type !== 'tag') return;
    const node = $(el);
    const tag = el.tagName;
    const keep = new Set<string>(['class', 'aria-label', 'title', 'itemtype', 'itemprop']);

    if (tag === 'a') keep.add('href');
    if (tag === 'img') { keep.add('src'); keep.add('alt'); }
    if (tag === 'td' || tag === 'th') { keep.add('colspan'); keep.add('rowspan'); }
    const attrs = el.attribs || {};
    for (const attr of Object.keys(attrs)) {
      if (attr.startsWith('data-')) continue;
      if (keep.has(attr)) continue;
      node.removeAttr(attr);
    }
    const classAttr = node.attr('class');
    if (classAttr) {
      const compact = compactClass(classAttr);
      if (compact) node.attr('class', compact);
      else node.removeAttr('class');
    }
  });

  // 3. Remove empty elements (except structural, or ones that carry semantic
  // metadata on themselves — an empty `<p class="star-rating Three">` is still
  // meaningful to an extractor even though it has no text content).
  const structural = new Set(['table', 'tr', 'ul', 'ol', 'dl', 'tbody', 'thead']);
  function hasSemanticAttrs(el: { attribs?: Record<string, string> }): boolean {
    const a = el.attribs || {};
    if (a.class || a['aria-label'] || a.title || a.itemtype || a.itemprop) return true;
    for (const k of Object.keys(a)) if (k.startsWith('data-')) return true;
    return false;
  }
  $('*').each((_, el) => {
    if (el.type !== 'tag') return;
    const node = $(el);
    if (structural.has(el.tagName)) return;
    if (node.text().trim()) return;
    if (node.find('img').length) return;
    if (hasSemanticAttrs(el)) return;
    node.remove();
  });

  // 4. Unwrap meaningless wrapper divs (no attributes whatsoever).
  $('div, span').each((_, el) => {
    if (el.type !== 'tag') return;
    const node = $(el);
    if (Object.keys(el.attribs || {}).length === 0) {
      node.replaceWith(node.html() || '');
    }
  });

  // 5. Collapse whitespace
  let result = $.html()
    .replace(/\s{2,}/g, ' ')
    .replace(/>\s+</g, '><')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // 6. Truncate if still too large
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + '\n<!-- truncated -->';
  }

  return result;
}
