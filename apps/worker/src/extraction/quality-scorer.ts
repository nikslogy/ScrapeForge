export interface QualityReport {
  score: number;
  signals: string[];
}

// ─────────────────────────────────────────────────────────────
// One linear pass over the markup
// ─────────────────────────────────────────────────────────────

/** What the scorer knows about a document after one pass. */
export interface HtmlAnalysis {
  /** True when at least one element tag was seen (JSON or plain text is not HTML). */
  isHtml: boolean;
  /** Visible body text, whitespace-collapsed (no script/style/noscript/template/svg/iframe/title). */
  textLen: number;
  /** The part of textLen inside <a> elements. */
  linkTextLen: number;
  /** Lower-cased visible text, cut at TEXT_SAMPLE_CHARS, for phrase checks. */
  textSample: string;
  /** Lower-cased <title> and <noscript> text (bounded), also checked for block phrases. */
  auxText: string;
  /** Longest whitespace-collapsed text run between block-level boundaries. */
  longestRun: number;
  /** Bytes of tags and attributes: html minus text and raw-text element contents. */
  markupBytes: number;
  /** Opening p/h1-6/li/td/article/section/div tags (the legacy diversity count). */
  contentTags: number;
  /** Opening headings, paragraphs, list items, cells, pre, blockquote... */
  textBlocks: number;
  /** Executable <script> elements (JSON/LD data scripts excluded). */
  scriptCount: number;
  /**
   * Bytes inside JSON data scripts (JSON-LD, __NEXT_DATA__, __NUXT_DATA__...):
   * server-rendered page data that extraction reads without running scripts.
   */
  dataBytes: number;
  /** Meta refresh to another URL, a fast reload, or an inline script that navigates. */
  clientRedirect: boolean;
  /** An SPA mount point (#root, #app, #__next, <app-root>...) with nothing inside. */
  emptyMountPoint: boolean;
}

const TEXT_SAMPLE_CHARS = 20_000;
const AUX_TEXT_CHARS = 2_000;
// Inline scripts are checked for navigation only up to this many chars each.
const SCRIPT_SCAN_CHARS = 50_000;

// Elements whose content is skipped up to the matching close tag, as an HTML
// parser does for raw-text elements. Only textarea/xmp content is visible.
const RAW_CONTENT = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'textarea', 'title', 'xmp']);
const VISIBLE_RAW_CONTENT = new Set(['textarea', 'xmp']);

// Tags that do not interrupt a run of text (everything else ends a run).
const INLINE = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'img',
  'ins', 'kbd', 'label', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u',
  'var', 'wbr',
]);

const LEGACY_CONTENT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'article', 'section', 'div']);
const TEXT_BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'dd', 'dt', 'pre', 'blockquote', 'figcaption',
  'article', 'main', 'address', 'summary', 'caption',
]);

const MOUNT_IDS = new Set([
  'root', 'app', '__next', '__nuxt', '___gatsby', 'svelte', 'react-root', 'app-root', 'main-app', 'application',
  'q-app', 'ember-app', 'appmount', 'mount',
]);
const MOUNT_TAGS = new Set(['app-root']);

const NON_EXECUTABLE_SCRIPT_TYPE = /^\s*(application\/(ld\+)?json|application\/json|text\/template|text\/x-template|importmap|speculationrules)\b/i;
// Same rule as the extraction engine (extract/document/structured.ts): a
// "type/subtype" MIME type ending in json is a data block.
const JSON_DATA_TYPE = /^\s*[a-z0-9.+-]+\/[a-z0-9.+-]*json\s*(?:;|$)/i;
// Assignments to location (not comparisons), or calls that navigate.
const SCRIPT_NAVIGATION =
  /(?:^|[^\w$.])(?:(?:window|document|top|self|parent)\s*\.\s*)?location(?:\s*\.\s*href)?\s*=(?!=)|\blocation\s*\.\s*(?:replace|assign|reload)\s*\(/;
const META_REFRESH = /^\s*(\d+(?:\.\d+)?)\s*(?:[;,]\s*(?:url\s*=\s*)?['"]?\s*(\S[^'"]*))?/i;

function isAsciiAlpha(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
}

function isTagNameChar(c: number): boolean {
  return isAsciiAlpha(c) || (c >= 48 && c <= 57) || c === 45 /* - */ || c === 58 /* : */ || c === 95 /* _ */;
}

/** Index of the '>' that ends the tag whose attributes start at `from` (quotes respected), or html.length. */
function findTagEnd(html: string, from: number): number {
  let quote = 0;
  for (let i = from; i < html.length; i++) {
    const c = html.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 /* " */ || c === 39 /* ' */) {
      // Quotes only open an attribute value right after "=" (possibly spaced).
      let k = i - 1;
      while (k >= from && (html.charCodeAt(k) === 32 || html.charCodeAt(k) === 9 || html.charCodeAt(k) === 10)) k--;
      if (k >= from && html.charCodeAt(k) === 61 /* = */) quote = c;
    } else if (c === 62 /* > */) {
      return i;
    }
  }
  return html.length;
}

const ATTR_PATTERNS: Record<'id' | 'type' | 'content', RegExp> = {
  id: /(?:^|[\s/])id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
  type: /(?:^|[\s/])type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
  content: /(?:^|[\s/])content\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
};

function attr(attrs: string, name: keyof typeof ATTR_PATTERNS): string | undefined {
  const m = ATTR_PATTERNS[name].exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : undefined;
}

const ENTITY = /&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi;
const NBSP = /&(?:nbsp|#160|#xa0);/gi;

function collapse(raw: string): string {
  return raw.replace(NBSP, ' ').replace(ENTITY, '_').replace(/\s+/g, ' ').trim();
}

interface Scan {
  analysis: HtmlAnalysis;
  /** Lower-cased html. */
  lower: string;
  /** [start, end) of JSON data script contents, in document order. */
  dataRanges: Array<[number, number]>;
}

/**
 * Single linear scan: no backtracking regex runs over the whole document, so
 * hostile markup (thousands of unclosed <script> tags, unbalanced quotes)
 * costs O(n).
 */
function scan(html: string): Scan {
  const lower = html.toLowerCase();
  const n = html.length;
  const textParts: string[] = [];
  const linkParts: string[] = [];
  const dataRanges: Array<[number, number]> = [];
  let linkDepth = 0;
  let runParts: string[] = [];
  let longestRun = 0;
  let rawBytes = 0;
  let textBytes = 0;
  let dataBytes = 0;
  let isHtml = false;
  let contentTags = 0;
  let textBlocks = 0;
  let scriptCount = 0;
  let clientRedirect = false;
  let emptyMountPoint = false;
  let aux = '';
  // An opened mount point waiting to see whether its next tag closes it.
  let mount: { name: string; textMark: number } | null = null;

  const endRun = () => {
    if (runParts.length === 0) return;
    const len = collapse(runParts.join('')).length;
    if (len > longestRun) longestRun = len;
    runParts = [];
  };
  const addText = (s: string) => {
    textBytes += s.length;
    textParts.push(s);
    runParts.push(s);
    if (linkDepth > 0) linkParts.push(s);
  };
  const addAux = (s: string) => {
    if (aux.length < AUX_TEXT_CHARS) aux += ` ${collapse(s).slice(0, AUX_TEXT_CHARS)}`.toLowerCase();
  };

  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) addText(html.slice(i, textEnd));
    if (lt === -1) break;

    const next = html.charCodeAt(lt + 1);
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      rawBytes += (close === -1 ? n : close + 3) - lt;
      i = close === -1 ? n : close + 3;
      continue;
    }
    if (next === 33 /* ! */ || next === 63 /* ? */) {
      const close = html.indexOf('>', lt + 2);
      i = close === -1 ? n : close + 1;
      continue;
    }
    const closing = next === 47; /* / */
    const nameStart = lt + (closing ? 2 : 1);
    if (!isAsciiAlpha(html.charCodeAt(nameStart))) {
      // A literal "<" in text (e.g. "a < b").
      addText('<');
      i = lt + 1;
      continue;
    }
    let j = nameStart;
    while (j < n && isTagNameChar(html.charCodeAt(j))) j++;
    const name = lower.slice(nameStart, j);
    const tagEnd = findTagEnd(html, j);
    i = tagEnd + 1;
    isHtml = true;

    if (mount) {
      if (closing && name === mount.name && textBytesSince(textParts, mount.textMark)) emptyMountPoint = true;
      mount = null;
    }
    if (!INLINE.has(name)) {
      endRun();
      // Block boundaries separate words, as rendered ("<li>a</li><li>b</li>" is "a b").
      textParts.push(' ');
    }
    if (name === 'a') {
      if (closing) {
        if (linkDepth > 0) linkParts.push(' ');
        linkDepth = 0;
      } else if (!html.slice(j, tagEnd).trimEnd().endsWith('/')) {
        // Links do not nest: a new <a> closes an open one.
        linkDepth = 1;
      }
    } else if (closing && !INLINE.has(name) && linkDepth > 0) {
      // A block end tag also ends a link left open inside it, so one
      // unclosed <a> cannot turn the rest of the page into "link text".
      linkParts.push(' ');
      linkDepth = 0;
    }
    if (closing) continue;

    const attrs = html.slice(j, tagEnd);
    if (LEGACY_CONTENT_TAGS.has(name)) contentTags++;
    if (TEXT_BLOCK_TAGS.has(name)) textBlocks++;
    if (MOUNT_TAGS.has(name) || ((name === 'div' || name === 'main' || name === 'section') && MOUNT_IDS.has((attr(attrs, 'id') ?? '').toLowerCase()))) {
      mount = { name, textMark: textParts.length };
    }
    if (name === 'meta' && /http-equiv\s*=\s*["']?\s*refresh/i.test(attrs)) {
      const m = META_REFRESH.exec(attr(attrs, 'content') ?? '');
      if (m) {
        const delay = Number(m[1]);
        // A redirect elsewhere soon, or a fast reload loop (cookie-setting
        // challenges). Slow auto-refresh of a news page is neither.
        if ((m[2] && delay <= 30) || (!m[2] && delay <= 5)) clientRedirect = true;
      }
    }

    if (RAW_CONTENT.has(name) && !attrs.trimEnd().endsWith('/')) {
      const close = lower.indexOf(`</${name}`, i);
      const contentEnd = close === -1 ? n : close;
      const content = html.slice(i, contentEnd);
      rawBytes += content.length;
      if (name === 'script') {
        const type = attr(attrs, 'type') ?? '';
        if (JSON_DATA_TYPE.test(type)) {
          dataBytes += content.trim().length;
          dataRanges.push([i, contentEnd]);
        } else if (!NON_EXECUTABLE_SCRIPT_TYPE.test(type)) {
          scriptCount++;
          if (!clientRedirect && SCRIPT_NAVIGATION.test(content.slice(0, SCRIPT_SCAN_CHARS))) clientRedirect = true;
        }
      } else if (VISIBLE_RAW_CONTENT.has(name)) {
        rawBytes -= content.length;
        addText(content);
      } else if (name === 'title' || name === 'noscript') {
        const head = content.slice(0, AUX_TEXT_CHARS * 4);
        addAux(name === 'noscript' ? head.replace(/<[^>]{0,500}>/g, ' ') : head);
      }
      if (close === -1) {
        i = n;
      } else {
        const gt = html.indexOf('>', close);
        i = gt === -1 ? n : gt + 1;
      }
      if (name !== 'title' && !INLINE.has(name)) endRun();
    }
  }
  endRun();

  const text = collapse(textParts.join(''));
  return {
    lower,
    dataRanges,
    analysis: {
      isHtml,
      textLen: text.length,
      linkTextLen: Math.min(text.length, collapse(linkParts.join('')).length),
      textSample: text.slice(0, TEXT_SAMPLE_CHARS).toLowerCase(),
      auxText: aux,
      longestRun,
      markupBytes: Math.max(0, n - rawBytes - textBytes),
      contentTags,
      textBlocks,
      scriptCount,
      dataBytes,
      clientRedirect,
      emptyMountPoint,
    },
  };
}

export function analyzeHtml(html: string): HtmlAnalysis {
  return scan(html).analysis;
}

/** True when nothing but whitespace was added to `parts` after index `mark`. */
function textBytesSince(parts: string[], mark: number): boolean {
  for (let k = mark; k < parts.length; k++) if (/\S/.test(parts[k])) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────
// Block markers
// ─────────────────────────────────────────────────────────────

// Matched anywhere in the markup and inline scripts (not in JSON data, where
// config keys such as "recaptchaSiteKey" are common): script sources, ids and
// class names that anti-bot vendors put on their interstitials.
const STRUCTURAL_MARKERS = [
  'captcha', // recaptcha, hcaptcha, px-captcha, captcha-delivery, validateCaptcha
  'challenge-platform',
  '_cf_chl_opt',
  'cf-browser-verification',
  'challenge-form',
  'challenge-running',
  '_incapsula_resource',
  'perimeterx',
  'datadome',
  'shieldsquare',
  'sec-if-cpt',
  'bm-verify',
  'awswaf',
  'ddos-guard',
  'sucuri_cloudproxy',
];

// Matched in visible text, <title> and <noscript>: what block pages say.
// Everything here is reported as a bot detection indicator.
const BLOCK_PHRASES = [
  'verify you are human',
  'verifying you are human',
  'are you a robot',
  'robot or human',
  'not a robot',
  'access denied',
  'access to this page has been denied',
  'you have been blocked',
  'request blocked',
  'request unsuccessful',
  'just a moment',
  'checking your browser',
  'attention required',
  'pardon our interruption',
  'unusual traffic',
  'automated access',
  'automated queries',
  'too many requests',
  'enable javascript and cookies',
  'press & hold',
  'press and hold',
  'unsupported browser',
  'browser is not supported',
  'please update your browser',
];

// "This page needs JavaScript": every create-react-app page says so inside
// <noscript>, so these count only in visible text, and only make a thin page
// look unfinished. They are not bot indicators: a rendered page replaces them.
const JS_REQUIRED_PHRASES = [
  'please enable javascript',
  'please enable js',
  'enable javascript to run',
  'you need to enable javascript',
  'javascript is required',
  'javascript is disabled',
  'requires javascript',
  'turn on javascript',
];

// Real block pages are small; long articles may legitimately mention
// "captcha" or "access denied", so markers only count below this much text.
const MARKER_TEXT_LIMIT = 5_000;

// Statuses anti-bot vendors answer with: there, a JavaScript-required notice
// is the interstitial's text and is reported as an indicator.
const BLOCKING_STATUSES = new Set([403, 429, 503]);

/** `lower` without the contents of JSON data scripts. */
function withoutData(lower: string, ranges: ReadonlyArray<[number, number]>): string {
  if (ranges.length === 0) return lower;
  const parts: string[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    parts.push(lower.slice(at, start));
    at = end;
  }
  parts.push(lower.slice(at));
  return parts.join(' ');
}

function findBlockMarkers(s: Scan): string[] {
  const a = s.analysis;
  if (a.textLen >= MARKER_TEXT_LIMIT) return [];
  const markup = withoutData(s.lower, s.dataRanges);
  const found = STRUCTURAL_MARKERS.filter((m) => markup.includes(m));
  const haystack = `${a.textSample} ${a.auxText}`;
  for (const p of BLOCK_PHRASES) if (haystack.includes(p)) found.push(p);
  return found;
}

function findJsRequiredNotice(a: HtmlAnalysis): string | undefined {
  return JS_REQUIRED_PHRASES.find((p) => a.textSample.includes(p));
}

// ─────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────

// Thin-page thresholds. A "short page" is a small, well-formed document that
// says something (example.com: ~190 chars in one 150-char paragraph). Shells
// and bot stubs either say nothing, only say block phrases, navigate away, or
// wrap a few words in a lot of markup.
const THIN_TEXT = 500;
const LOW_TEXT = 1500;
// Below LOW_TEXT, a page whose text is mostly link labels (a navigation menu
// around an empty main) is judged by its non-link text.
const LINK_HEAVY_SHARE = 0.5;
const MIN_MEANINGFUL_TEXT = 40;
const MIN_SENTENCE_RUN = 24;
// Text as a share of text + markup; skeleton screens and cloaked pages wrap a
// few words in kilobytes of empty elements.
const SHORT_PAGE_MIN_TEXT_SHARE = 0.03;
// Server-rendered page data (Next.js __NEXT_DATA__, JSON-LD) of this size is
// content: extraction reads it, and it is what a browser would render.
const SUBSTANTIAL_DATA_BYTES = 1024;

function judgedText(a: HtmlAnalysis): number {
  return isLinkHeavy(a) ? a.textLen - a.linkTextLen : a.textLen;
}

function isLinkHeavy(a: HtmlAnalysis): boolean {
  return a.textLen < LOW_TEXT && a.linkTextLen > LINK_HEAVY_SHARE * a.textLen;
}

interface ThinVerdict {
  penalty: number;
  signal: string;
  shortPage: boolean;
}

/** A page with under THIN_TEXT chars of (non-navigation) text: complete, or a stub? */
function judgeThinPage(a: HtmlAnalysis, markers: readonly string[], jsNotice: string | undefined): ThinVerdict {
  const judged = judgedText(a);
  if (judged < MIN_MEANINGFUL_TEXT || a.longestRun < MIN_SENTENCE_RUN) {
    return {
      penalty: 0.6,
      signal: `No meaningful visible text (${judged} chars — empty shell or stub page)`,
      shortPage: false,
    };
  }
  const textShare = judged / Math.max(1, a.markupBytes + a.textLen);
  const hasData = a.dataBytes >= SUBSTANTIAL_DATA_BYTES && !isLinkHeavy(a);
  const complete =
    markers.length === 0 &&
    jsNotice === undefined &&
    !a.clientRedirect &&
    !a.emptyMountPoint &&
    (a.textBlocks > 0 || a.longestRun >= 2 * MIN_SENTENCE_RUN) &&
    (textShare >= SHORT_PAGE_MIN_TEXT_SHARE || hasData);
  if (complete) {
    // Small but complete: a browser cannot make static text longer.
    return {
      penalty: 0.1,
      signal: hasData && textShare < SHORT_PAGE_MIN_TEXT_SHARE
        ? `Short page with server-rendered data (${judged} chars of visible text, ${a.dataBytes} B of JSON)`
        : `Short page (${judged} chars of visible text)`,
      shortPage: true,
    };
  }
  let signal: string;
  if (judged < a.textLen) {
    signal = `Mostly navigation links (${judged} of ${a.textLen} chars outside links — likely cloaked page)`;
  } else if (jsNotice !== undefined && markers.length === 0) {
    signal = `JavaScript required notice ("${jsNotice}") on a thin page — content rendered client-side`;
  } else {
    signal = `Very low visible text (${a.textLen} chars — likely stub / block page)`;
  }
  return { penalty: 0.5, signal, shortPage: false };
}

/**
 * How much real content a response carries, from 0 (block page, empty shell)
 * to 1. The router accepts a tier's response at ≥ 0.55 (engine/router.ts);
 * "Bot detection indicators: ..." lists challenge/block markers only
 * (extract/engine.ts blockedFromQualitySignals reads it).
 */
export function calculateQualityScore(
  html: string,
  statusCode: number,
  tierUsed: number,
  latencyMs: number,
): QualityReport {
  const signals: string[] = [];
  let score = 1.0;

  if (statusCode !== 200) {
    score -= 0.3;
    signals.push(`Non-200 status code: ${statusCode}`);
  }

  const s = scan(html);
  const a = s.analysis;
  const markers = findBlockMarkers(s);
  const jsNotice = findJsRequiredNotice(a);
  if (jsNotice !== undefined && BLOCKING_STATUSES.has(statusCode) && a.textLen < MARKER_TEXT_LIMIT) {
    markers.push(jsNotice);
  }
  let shortPage = false;

  if (!a.isHtml) {
    // JSON, plain text, CSV...: no markup to judge, only whether there is a body.
    if (a.textLen === 0) {
      score -= 0.6;
      signals.push('Empty response body');
    } else {
      score -= 0.1;
      signals.push('Not an HTML document');
    }
  } else if (judgedText(a) < THIN_TEXT) {
    const v = judgeThinPage(a, markers, jsNotice);
    score -= v.penalty;
    shortPage = v.shortPage;
    signals.push(v.signal);
    if (a.clientRedirect) signals.push('Client-side redirect or reload');
    if (a.emptyMountPoint) signals.push('Empty app mount point (content rendered client-side)');
  } else if (a.textLen < LOW_TEXT && html.length >= 1000) {
    score -= 0.15;
    signals.push(`Low visible text (${a.textLen} chars)`);
  }

  // Pages that are mostly markup and not much else are suspicious: the
  // text-to-html ratio of a normal article is usually 15–40%; cloaked block
  // pages commonly come in under 3%. Embedded page data counts as content.
  const contentShare = (a.textLen + a.dataBytes) / Math.max(1, html.length);
  if (html.length > 5000 && contentShare < 0.03) {
    score -= 0.2;
    signals.push(`Very low text-to-HTML ratio (${(contentShare * 100).toFixed(1)}%)`);
  }

  if (markers.length > 0) {
    score -= 0.3 * markers.length;
    signals.push(`Bot detection indicators: ${markers.join(', ')}`);
  }

  // A complete short page was already judged on its structure.
  if (a.isHtml && !shortPage && a.contentTags < 3) {
    score -= 0.1;
    signals.push('Low content diversity (few semantic HTML tags)');
  }

  if (latencyMs > 15_000) {
    score -= 0.1;
    signals.push('High latency response');
  }

  score = Math.max(0, Math.min(1, score));
  if (score >= 0.8) signals.push('Content appears valid');

  return { score: Math.round(score * 100) / 100, signals };
}
