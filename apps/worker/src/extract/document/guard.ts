// Pre-parse guard against adversarial HTML.
//
// parse5 (cheerio.load) is quadratic in element nesting depth: 10,000
// nested <div>s take ~0.9 s to parse and 20,000 take ~3 s, so one hostile
// page can pin a worker. Real pages nest a few dozen levels deep, so a
// linear tokenizer pass that drops tags beyond a generous depth keeps the
// parse linear without touching ordinary documents: when nothing exceeds
// the limit the input string is returned unchanged, so block selectors keep
// re-selecting elements in cheerio.load(rawHtml).
//
// The depth estimate approximates the HTML tree builder only where it
// matters for false positives: void elements, implied end tags (p, li, td,
// option, ...) and self-closing tags inside SVG/MathML do not count as
// nesting. Over-estimating only means flattening an already pathological
// page; text is never dropped, only tags.

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

/** Elements whose content is raw text: skip to the matching end tag. */
const RAW_TEXT = new Set([
  'script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext',
]);

/**
 * Opening tag X implicitly closes the nearest open sibling of these kinds,
 * together with everything opened inside it (a new <tr> closes the open
 * <tr> and its <td>).
 */
const IMPLIED_SIBLINGS: Record<string, readonly string[]> = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  option: ['option'],
  optgroup: ['optgroup'],
  tr: ['tr'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  thead: ['thead', 'tbody', 'tfoot'],
  tbody: ['thead', 'tbody', 'tfoot'],
  tfoot: ['thead', 'tbody', 'tfoot'],
  rb: ['rb', 'rt', 'rtc', 'rp'],
  rt: ['rb', 'rt', 'rp'],
  rp: ['rb', 'rt', 'rp'],
};

/**
 * The implied-close search for an opening tag stops at these containers
 * (a new <li> inside a nested <ul> must not close the outer list's <li>).
 */
const IMPLIED_SCOPE: Record<string, readonly string[]> = {
  li: ['ul', 'ol', 'menu'],
  dt: ['dl'],
  dd: ['dl'],
  option: ['select', 'datalist'],
  optgroup: ['select'],
  tr: ['table'],
  td: ['table', 'tr'],
  th: ['table', 'tr'],
  thead: ['table'],
  tbody: ['table'],
  tfoot: ['table'],
  rb: ['ruby'],
  rt: ['ruby'],
  rp: ['ruby'],
};

/** How far down the stack an implied close looks for its sibling. */
const MAX_IMPLIED_SEARCH = 8;

/** Block-level openers that close an open <p>. */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'ul',
]);

/** How far back an end tag searches for its opener before being ignored. */
const MAX_END_TAG_SEARCH = 64;

export interface NestingGuardResult {
  html: string;
  /** Deepest nesting seen (approximate, see module comment). */
  maxDepth: number;
  /** Tags were dropped; selectors refer to the rewritten snapshot. */
  rewritten: boolean;
  droppedTags: number;
}

interface OpenTag {
  name: string;
  dropped: boolean;
  foreign: boolean;
}

/**
 * Linear scan of `html`; when nesting exceeds `maxDepth`, opening tags past
 * the limit (and their matching end tags) are removed. Returns the input
 * unchanged when no tag had to be dropped.
 */
export function guardHtmlNesting(html: string, maxDepth: number): NestingGuardResult {
  const stack: OpenTag[] = [];
  let depth = 0; // open, non-dropped entries on the stack
  let deepest = 0;
  let dropped = 0;
  // Output is assembled lazily: only once the first tag is dropped.
  let out: string[] | null = null;
  let copiedUpTo = 0;
  const n = html.length;
  let i = 0;

  const drop = (from: number, to: number) => {
    if (!out) out = [];
    out.push(html.slice(copiedUpTo, from));
    copiedUpTo = to;
    dropped++;
  };

  const popTo = (index: number) => {
    for (let k = stack.length - 1; k >= index; k--) {
      if (!stack[k].dropped) depth--;
    }
    stack.length = index;
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1 || lt + 1 >= n) break;
    const next = html.charCodeAt(lt + 1);

    // Comments, doctype, CDATA, processing instructions.
    if (next === 33 /* ! */ || next === 63 /* ? */) {
      i = html.startsWith('<!--', lt) ? commentEnd(html, lt) : bogusCommentEnd(html, lt);
      continue;
    }

    const isEnd = next === 47; /* / */
    const nameStart = isEnd ? lt + 2 : lt + 1;
    let j = nameStart;
    while (j < n && isNameChar(html.charCodeAt(j))) j++;
    if (j === nameStart) {
      // "<" not followed by a tag name is text.
      i = lt + 1;
      continue;
    }
    const name = html.slice(nameStart, j).toLowerCase();
    const gt = findTagEnd(html, j);
    if (gt === -1) break;
    const tagEnd = gt + 1;
    const selfClosing = html.charCodeAt(gt - 1) === 47;

    if (isEnd) {
      let found = -1;
      const stop = Math.max(0, stack.length - MAX_END_TAG_SEARCH);
      for (let k = stack.length - 1; k >= stop; k--) {
        if (stack[k].name === name) { found = k; break; }
      }
      if (found !== -1) {
        if (stack[found].dropped) drop(lt, tagEnd);
        popTo(found);
      }
      i = tagEnd;
      continue;
    }

    const parentForeign = stack.length > 0 && stack[stack.length - 1].foreign;
    const foreign = parentForeign || name === 'svg' || name === 'math';

    if (!foreign) {
      const top = stack[stack.length - 1];
      if (top && top.name === 'p' && CLOSES_P.has(name)) popTo(stack.length - 1);
      const siblings = IMPLIED_SIBLINGS[name];
      if (siblings) {
        // Close the nearest open sibling (e.g. <tr> closes the open <td> and
        // its <tr>), without crossing the enclosing list/table/select.
        const scope = IMPLIED_SCOPE[name] ?? [];
        const stop = Math.max(0, stack.length - MAX_IMPLIED_SEARCH);
        for (let k = stack.length - 1; k >= stop; k--) {
          const open = stack[k].name;
          if (scope.includes(open)) break;
          if (siblings.includes(open)) { popTo(k); break; }
        }
      }
    }

    if (VOID.has(name) || (foreign && selfClosing)) {
      i = tagEnd;
      continue;
    }

    const tooDeep = depth >= maxDepth;
    if (tooDeep) drop(lt, tagEnd);
    stack.push({ name, dropped: tooDeep, foreign });
    if (!tooDeep) {
      depth++;
      if (depth > deepest) deepest = depth;
    } else if (depth + 1 > deepest) {
      deepest = depth + 1;
    }

    if (!foreign && RAW_TEXT.has(name)) {
      // Raw text runs to the matching end tag (case-insensitive).
      const endAt = indexOfEndTag(html, name, tagEnd);
      if (endAt === -1) { i = n; break; }
      i = endAt;
      continue;
    }
    i = tagEnd;
  }

  if (!out) return { html, maxDepth: deepest, rewritten: false, droppedTags: 0 };
  (out as string[]).push(html.slice(copiedUpTo));
  return { html: (out as string[]).join(''), maxDepth: deepest, rewritten: true, droppedTags: dropped };
}

/**
 * Index just past a comment starting at `lt` ("<!--"), as the HTML tokenizer
 * reads it: "<!-->" and "<!--->" are complete empty comments, "-->" and
 * "--!>" both end a comment, and an unterminated comment runs to the end.
 */
function commentEnd(html: string, lt: number): number {
  if (html.startsWith('<!-->', lt)) return lt + 5;
  if (html.startsWith('<!--->', lt)) return lt + 6;
  const a = html.indexOf('-->', lt + 4);
  const b = html.indexOf('--!>', lt + 4);
  if (a === -1 && b === -1) return html.length;
  if (b === -1 || (a !== -1 && a < b)) return a + 3;
  return b + 4;
}

/** "<!DOCTYPE ...>", "<![CDATA[...]]>" outside foreign content and "<?...>" end at the first ">". */
function bogusCommentEnd(html: string, lt: number): number {
  const gt = html.indexOf('>', lt + 2);
  return gt === -1 ? html.length : gt + 1;
}

function isNameChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;
}

/** Index of the '>' ending a tag, skipping quoted attribute values. */
function findTagEnd(html: string, from: number): number {
  let quote = 0;
  for (let k = from; k < html.length; k++) {
    const c = html.charCodeAt(k);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62) {
      return k;
    }
  }
  return -1;
}

function indexOfEndTag(html: string, name: string, from: number): number {
  const needle = '</' + name;
  let k = from;
  for (;;) {
    const at = indexOfIgnoreCase(html, needle, k);
    if (at === -1) return -1;
    const after = html.charCodeAt(at + needle.length);
    if (Number.isNaN(after) || !isNameChar(after)) return at;
    k = at + needle.length;
  }
}

function indexOfIgnoreCase(html: string, needle: string, from: number): number {
  // Scan for the exact '</' prefix and compare the short tag name
  // case-insensitively, instead of lower-casing the whole document.
  let k = from;
  for (;;) {
    const at = html.indexOf('</', k);
    if (at === -1) return -1;
    if (html.slice(at, at + needle.length).toLowerCase() === needle) return at;
    k = at + 2;
  }
}
