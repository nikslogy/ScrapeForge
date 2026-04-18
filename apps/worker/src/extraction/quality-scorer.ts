export interface QualityReport {
  score: number;
  signals: string[];
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

  if (html.length < 1000) {
    score -= 0.2;
    signals.push('Very short content (possible block page)');
  }

  // Bot-wall indicators only count when the page also looks small
  // (real articles often legitimately mention words like "captcha" or
  // "blocked"). This avoids penalizing Wikipedia-style long-form content.
  const botIndicators = [
    'captcha', 'challenge', 'verify you are human',
    'access denied', 'you have been blocked', 'rate limit',
    'unusual traffic', 'please enable javascript to view',
  ];
  const lowerHtml = html.toLowerCase();
  const matched = botIndicators.filter((i) => lowerHtml.includes(i));
  const suspicious = html.length < 5000 && matched.length > 0;
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
