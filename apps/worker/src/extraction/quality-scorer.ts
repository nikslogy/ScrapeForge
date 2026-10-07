export interface QualityReport {
  score: number;
  signals: string[];
}

// Cheap, regex-based approximation of visible text length. We strip the
// most noisy elements (script, style, noscript, svg, etc.) and then collapse
// the remaining markup. This avoids pulling in a full parser and stays safe
// for very large HTML inputs.
function approxTextLength(html: string): number {
  const stripped = html
    .replace(/<(script|style|noscript|svg|template|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length;
}

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

  // Raw markup length — tiny HTML payloads are almost always error pages.
  if (html.length < 1000) {
    score -= 0.2;
    signals.push('Very short content (possible block page)');
  }

  // Visible text length — catches the "cloaked 200-OK" case where the page
  // is structurally large (50 KB of nav/footer markup) but has almost no
  // real body text. This is the dominant anti-bot pattern (Walmart, Google
  // SERP interstitials, nowsecure.nl).
  //
  // We only trigger this when the *raw HTML* is non-trivial (≥ 1 KB): a
  // genuinely minimal page like `example.com` is legitimately short and
  // shouldn't be penalised twice.
  const textLen = approxTextLength(html);
  if (html.length >= 1000) {
    if (textLen < 500) {
      score -= 0.5;
      signals.push(`Very low visible text (${textLen} chars — likely stub / block page)`);
    } else if (textLen < 1500) {
      score -= 0.15;
      signals.push(`Low visible text (${textLen} chars)`);
    }
  }

  // Pages that are mostly markup and not much else are suspicious: the
  // text-to-html ratio of a normal article is usually 15–40%; cloaked block
  // pages commonly come in under 3%.
  if (html.length > 5000 && textLen / html.length < 0.03) {
    score -= 0.2;
    signals.push(
      `Very low text-to-HTML ratio (${((textLen / html.length) * 100).toFixed(1)}%)`,
    );
  }

  // Bot-wall keyword indicators. Real articles can legitimately mention
  // words like "captcha" so we only count them when the page is also small.
  const botIndicators = [
    'captcha', 'challenge', 'verify you are human',
    'access denied', 'you have been blocked', 'rate limit',
    'unusual traffic', 'please enable javascript to view',
  ];
  const lowerHtml = html.toLowerCase();
  const matched = botIndicators.filter((i) => lowerHtml.includes(i));
  const suspicious = textLen < 5000 && matched.length > 0;
  if (suspicious) {
    score -= 0.3 * matched.length;
    signals.push(`Bot detection indicators: ${matched.join(', ')}`);
  }

  const tagCount = (html.match(/<(p|h[1-6]|li|td|article|section|div)[>\s]/gi) || []).length;
  if (tagCount < 3) {
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
