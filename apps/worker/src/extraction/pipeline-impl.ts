import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import * as cheerio from 'cheerio';
import type { OutputFormat } from '@scrapeforge/shared';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

turndown.addRule('skip-placeholder-images', {
  filter: (node) => {
    if (node.nodeName !== 'IMG') return false;
    const src = node.getAttribute('src') || '';
    return src.startsWith('data:image') && src.length < 200;
  },
  replacement: () => '',
});

export interface ExtractionResult {
  html?: string;
  markdown?: string;
  text?: string;
  json?: Record<string, unknown> | Array<Record<string, unknown>>;
  extractionMethod?: string;
  title?: string;
  description?: string;
}

/**
 * Multi-strategy content extraction pipeline (CPU-bound).
 *
 * This module runs inside a Piscina worker thread — see ./pipeline-worker.ts
 * and ./pipeline.ts. Keeping it free of BullMQ / Redis / DB imports is what
 * lets it ship cleanly across the thread boundary.
 */
export async function extractContent(
  rawHtml: string,
  url: string,
  formats: OutputFormat[],
): Promise<ExtractionResult> {
  const result: ExtractionResult = {};

  if (formats.includes('html')) {
    result.html = cleanHtml(rawHtml);
  }

  // Always resolve the page title + description. They're cheap to derive
  // (a few cheerio lookups) and almost every downstream consumer wants
  // them — playground UI, webhook recipients, cached-tier listings, etc.
  const meta = extractMetaTags(rawHtml);
  let chainTitle: string | undefined;

  if (formats.includes('markdown') || formats.includes('text')) {
    const extracted = runExtractionChain(rawHtml, url);
    result.extractionMethod = extracted.method;
    chainTitle = extracted.title;

    if (formats.includes('markdown')) {
      const rawMd = cleanMarkdown(
        extracted.html
          ? turndown.turndown(extracted.html)
          : extracted.text || '',
      );

      // Readability (and JSON-LD) strip the article's H1 because they treat
      // it as metadata. Downstream consumers (RAG pipelines, doc importers,
      // our own markdown-fidelity tests) expect the title as a leading H1 —
      // match the de-facto convention Firecrawl / Reader / Mercury all use.
      const titleForHeading = extracted.title || meta?.title;
      const startsWithHeading = /^\s*#\s+/.test(rawMd);
      result.markdown = titleForHeading && !startsWithHeading
        ? `# ${titleForHeading.trim()}\n\n${rawMd}`
        : rawMd;
    }
    if (formats.includes('text')) {
      result.text = extracted.text;
    }
  }

  const resolvedTitle = chainTitle || meta?.title;
  if (resolvedTitle) result.title = resolvedTitle.trim();
  if (meta?.description) result.description = meta.description.trim();

  return result;
}

interface ExtractedContent {
  title?: string;
  text: string;
  html?: string;
  method: string;
}

function runExtractionChain(rawHtml: string, url: string): ExtractedContent {
  const jsonLd = extractJsonLd(rawHtml);
  if (jsonLd && jsonLd.text.length > 200) return jsonLd;

  const meta = extractMetaTags(rawHtml);

  const readable = extractReadability(rawHtml, url);
  if (readable && readable.text.length > 200) return readable;

  const dense = extractByParagraphDensity(rawHtml);
  if (dense && dense.text.length > 200) return dense;

  const largest = extractLargestBlock(rawHtml);
  if (largest && largest.text.length > 100) return largest;

  const fallbackText = [
    meta?.title,
    meta?.description,
    extractPlainText(rawHtml),
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    text: fallbackText,
    html: cleanHtml(rawHtml),
    method: 'fallback',
  };
}

function extractJsonLd(html: string): ExtractedContent | null {
  const $ = cheerio.load(html);
  const blocks: unknown[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html();
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else blocks.push(parsed);
    } catch { /* skip malformed */ }
  });

  for (const block of [...blocks]) {
    if (block && typeof block === 'object' && '@graph' in (block as any)) {
      blocks.push(...(block as any)['@graph']);
    }
  }

  // "WebPage" is deliberately excluded: homepages use it with a tiny
  // description that tricks the extractor into returning boilerplate.
  const ARTICLE_TYPES = [
    'NewsArticle',
    'Article',
    'BlogPosting',
    'Report',
    'TechArticle',
    'SocialMediaPosting',
    'AnalysisNewsArticle',
    'BackgroundNewsArticle',
    'OpinionNewsArticle',
    'ReportageNewsArticle',
    'ReviewNewsArticle',
  ];

  let best: { body: string; title: string } | null = null;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const obj = block as Record<string, unknown>;

    const type = String(obj['@type'] || '');
    if (!ARTICLE_TYPES.some((t) => type.includes(t))) continue;

    const body =
      (obj.articleBody as string) ||
      (obj.text as string) ||
      (obj.description as string) ||
      '';

    if (body.length < 200) continue;
    if (!best || body.length > best.body.length) {
      best = {
        body,
        title: (obj.headline as string) || (obj.name as string) || '',
      };
    }
  }

  if (!best) return null;

  const fullText = best.title ? `${best.title}\n\n${best.body}` : best.body;
  const fullHtml = best.title
    ? `<h1>${escapeHtml(best.title)}</h1>${bodyToHtml(best.body)}`
    : bodyToHtml(best.body);

  return {
    title: best.title,
    text: fullText,
    html: fullHtml,
    method: 'json-ld',
  };
}

function bodyToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim())}</p>`)
    .join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function extractMetaTags(html: string) {
  const $ = cheerio.load(html);

  const get = (selectors: string[]): string => {
    for (const sel of selectors) {
      const val = $(sel).attr('content')?.trim();
      if (val && val.length > 5) return val;
    }
    return '';
  };

  const title =
    get(['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
    $('title').text().trim();

  const description = get([
    'meta[property="og:description"]',
    'meta[name="description"]',
    'meta[name="twitter:description"]',
  ]);

  if (!title && !description) return null;
  return { title, description };
}

function extractReadability(
  html: string,
  url: string,
): ExtractedContent | null {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article) return null;
    return {
      title: article.title,
      text: article.textContent.trim(),
      html: article.content,
      method: 'readability',
    };
  } catch {
    return null;
  }
}

function extractByParagraphDensity(html: string): ExtractedContent | null {
  const $ = cheerio.load(html);
  removeNoise($);

  let bestHtml = '';
  let bestText = '';
  let bestScore = 0;

  $('div, section, article, main, [role="main"]').each((_, el) => {
    const $el = $(el);
    const paragraphs = $el.find('p');
    if (paragraphs.length < 2) return;

    let pTextLen = 0;
    paragraphs.each((__, p) => {
      pTextLen += $(p).text().trim().length;
    });

    const childCount = $el.children().length || 1;
    const density = pTextLen / childCount;
    const score = density * Math.log2(paragraphs.length + 1);

    if (score > bestScore) {
      bestScore = score;
      bestHtml = $el.html() || '';
      bestText = $el.text().replace(/\s+/g, ' ').trim();
    }
  });

  if (bestScore < 50) return null;

  return { text: bestText, html: bestHtml, method: 'paragraph-density' };
}

function extractLargestBlock(html: string): ExtractedContent | null {
  const $ = cheerio.load(html);
  removeNoise($);

  let bestHtml = '';
  let bestLen = 0;

  const selectors = [
    'article', '[role="main"]', 'main',
    '.post-content', '.article-body', '.entry-content',
    '.story-body', '#article-body', '.content-body',
    '[data-shadow-flattened]',
  ];

  $(selectors.join(', ')).each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length > bestLen) {
      bestLen = text.length;
      bestHtml = $(el).html() || '';
    }
  });

  if (bestLen < 100) {
    $('div, section').each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length > bestLen) {
        bestLen = text.length;
        bestHtml = $(el).html() || '';
      }
    });
  }

  if (bestLen < 100) return null;
  return {
    text: cheerio.load(bestHtml).text().replace(/\s+/g, ' ').trim(),
    html: bestHtml,
    method: 'largest-block',
  };
}

function removeNoise($: cheerio.CheerioAPI): void {
  $(
    'script, style, noscript, iframe, svg, nav, footer, header, aside, ' +
    '.ad, .ads, .advertisement, [class*="cookie"], [class*="banner"], ' +
    '[class*="popup"], [class*="modal"], [id*="cookie"], [id*="banner"], ' +
    '[id*="popup"], [id*="modal"], [aria-hidden="true"]',
  ).remove();
}

function cleanHtml(html: string): string {
  const $ = cheerio.load(html);
  removeNoise($);
  return $.html();
}

function extractPlainText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

function cleanMarkdown(md: string): string {
  return md
    .replace(/!\[\]\(data:image[^)]{0,200}\)/g, '')
    .replace(/\[([^\]]*)\]\(javascript:[^)]*\)/g, '$1')
    .replace(/^[\s;]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
