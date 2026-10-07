import { createHash } from 'node:crypto';

// Template signature: pages rendered from the same server template (two
// product pages of one shop) hash equal; different templates (listing vs
// product) differ. Host-independent by design: it is combined with the host
// in recipe keys.

// Tracking parameters vary per visit and say nothing about the template.
const IGNORED_QUERY_KEYS = new Set([
  'fbclid', 'gclid', 'msclkid', 'yclid', 'dclid', '_ga', 'mc_cid', 'mc_eid', 'ref', 'ref_',
  'srsltid', 'igshid', 'spm',
]);

// Short alphabetic words ("catalogue", "product", "dp", "index.html") are
// template structure; anything with digits, separators or length is an id/slug.
const STABLE_SEGMENT = /^[a-z]{1,16}(?:\.(?:html?|php|aspx?|jsp|cfm))?$/;

function segmentShape(segment: string): string {
  let s: string;
  try {
    s = decodeURIComponent(segment).toLowerCase();
  } catch {
    s = segment.toLowerCase();
  }
  if (/^\d+$/.test(s)) return ':n';
  if (STABLE_SEGMENT.test(s)) return s;
  return ':s';
}

/** Path shape, e.g. "/catalogue/:s/index.html?page". */
export function urlPathShape(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const segments = u.pathname.split('/').filter(Boolean).slice(0, 32).map(segmentShape);
  const keys = new Set<string>();
  for (const key of u.searchParams.keys()) {
    const k = key.toLowerCase();
    if (k.startsWith('utm_') || IGNORED_QUERY_KEYS.has(k)) continue;
    keys.add(/^[a-z_][a-z0-9_.-]{0,30}$/.test(k) ? k : ':k');
    if (keys.size >= 16) break;
  }
  const query = keys.size > 0 ? `?${[...keys].sort().join('&')}` : '';
  return `/${segments.join('/')}${query}`;
}

/**
 * sha256 (first 16 hex) of the URL path shape plus the coarse DOM skeleton:
 * the sorted, de-duplicated set of `tag.firstStableClass` tokens (digits
 * stripped) for visible elements down to depth 4 under <body>.
 */
export function templateSignature(url: string, skeleton: Iterable<string>): string {
  const tokens = [...new Set(skeleton)].sort();
  return createHash('sha256')
    .update(`${urlPathShape(url)}\n${tokens.join(',')}`)
    .digest('hex')
    .slice(0, 16);
}
