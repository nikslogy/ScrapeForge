// Reading yes/no values printed on a page.
//
// Two lexicons, chosen by what the field is about:
//   availability  (any boolean field): "In stock", "Auf Lager", "En rupture
//                 de stock", "Agotado", "Op voorraad", schema.org
//                 availability URLs, yes/no words.
//   workplace     (a field about remote work, e.g. "remote", "isRemote",
//                 "True only when the role can be done fully remotely"):
//                 "Remote" → true; "On-site", "In office", "not eligible for
//                 remote work" → false; "Hybrid" is ambiguous unless the
//                 description says how to treat it ("fully remote" → false).
//                 A field about being on site ("onsite", "inOffice") reads
//                 the same phrases with the opposite polarity.
// Negative phrases are removed before positive ones are looked for, so "not
// available", "nicht auf Lager" and "not eligible for remote work" never
// read as true; when both remain, the value is ambiguous. Text that matches
// neither lexicon is unparseable: nothing is guessed.

import type { FieldSpec } from '../types.js';

export type BooleanReading = boolean | 'ambiguous' | null;

/** Whole-value yes/no words (any language the lexicons cover). */
const YES = new Set(['true', 'yes', 'y', '1', 'on', 'checked', 'enabled', '✓', '✔', '✅', 'ja', 'oui', 'sí', 'si', 'sì', 'sim']);
const NO = new Set(['false', 'no', 'n', '0', 'off', 'unchecked', 'disabled', '✗', '✘', '❌', 'nein', 'non', 'não', 'nao', 'nee']);

// ─────────────────────────────────────────────────────────────
// Availability
// ─────────────────────────────────────────────────────────────

const AVAILABLE_WORDS = new Set(['available', 'in stock', 'instock']);
const UNAVAILABLE_WORDS = new Set(['unavailable']);

const SCHEMA_ORG_AVAILABILITY = new Map([
  ['instock', true],
  ['instoreonly', true],
  ['onlineonly', true],
  ['limitedavailability', true],
  ['preorder', true],
  ['presale', true],
  ['backorder', true],
  ['madetoorder', true],
  ['outofstock', false],
  ['soldout', false],
  ['discontinued', false],
]);

/** A phrase bounded by non-letters (\b is ASCII-only and fails next to "é", "ä"). */
function phrases(...alternatives: string[]): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'gu');
}

const UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  // English
  phrases('out[ -]?of[ -]?stock', 'outofstock'),
  phrases("not (?:currently |yet )?(?:in[ -]?stock|available)"),
  phrases('(?:currently |temporarily )?unavailable'),
  phrases('sold[ -]?out', 'no longer (?:available|in stock|sold)', 'no stock', 'discontinued'),
  phrases('available soon', 'coming soon', 'not for sale'),
  phrases("(?:e-?mail|alert|notify) me(?: when (?:it'?s )?(?:back )?(?:in stock|available))?"),
  // German
  phrases('(?:derzeit |zurzeit |momentan |aktuell |leider )?nicht (?:mehr )?(?:auf lager|vorrätig|lieferbar|verfügbar|erhältlich)'),
  phrases('ausverkauft', 'vergriffen', 'nicht am lager', '(?:bald|demnächst) (?:wieder )?(?:verfügbar|lieferbar|erhältlich)', 'wieder (?:verfügbar|lieferbar) ab'),
  // French
  phrases('(?:en )?rupture de stock', 'hors stock', '(?:stock )?épuisé(?:e|s|es)?', '(?:temporairement )?indisponible', 'non disponible'),
  phrases("pas (?:en stock|disponible)", "(?:n'est )?plus disponible", 'bientôt disponible', 'prochainement disponible'),
  // Spanish
  phrases('agotad[oa]s?', 'sin (?:stock|existencias)', 'fuera de stock', 'no (?:hay existencias|disponible|está disponible)', 'próximamente'),
  // Italian
  phrases('esaurit[oaie]', 'non (?:più )?disponibile', 'fuori stock', 'non in magazzino', 'prossimamente(?: disponibile)?', 'terminat[oa]'),
  // Portuguese
  phrases('esgotad[oa]s?', 'indisponível', 'fora de estoque', 'sem estoque', 'não (?:está )?disponível', 'em breve'),
  // Dutch
  phrases('niet (?:meer )?(?:op voorraad|leverbaar|beschikbaar)', '(?:tijdelijk )?uitverkocht', 'binnenkort (?:beschikbaar|leverbaar)'),
];

const AVAILABLE_PATTERNS: readonly RegExp[] = [
  // English
  phrases('in[ -]?stock', 'available', 'add(?:ed)? to (?:cart|basket|bag|trolley)', 'buy (?:it )?now', 'pre[ -]?order'),
  phrases('limited (?:stock|availability|quantities)', 'only \\d+ (?:left|remaining)', 'few left', 'low stock', 'ready to ship', 'ships (?:today|tomorrow|in|within)'),
  // German
  phrases('auf lager', 'lagernd', 'vorrätig', '(?:sofort )?lieferbar', '(?:sofort )?verfügbar', 'in den warenkorb', 'vorbestellbar'),
  // French
  phrases('en stock', 'disponibles?', 'ajouter au panier', '(?:en )?précommande'),
  // Spanish
  phrases('en existencias?', 'hay existencias', 'añadir al carrito', 'preventa'),
  // Italian
  phrases('disponibil[ei]', 'in magazzino', 'disponibilità immediata', 'aggiungi al carrello', 'preordine'),
  // Portuguese
  phrases('em (?:estoque|stock)', 'disponíve(?:l|is)', 'adicionar ao carrinho', 'pré[ -]?venda'),
  // Dutch
  phrases('op voorraad', '(?:direct )?leverbaar', 'beschikbaar', 'in winkelwagen'),
];

/** "In stock", "Auf Lager", "https://schema.org/InStock", "Yes" → true; text is lower-cased and cleaned. */
export function readAvailability(text: string): BooleanReading {
  const bare = text.replace(/[.!]+$/, '').trim();
  if (YES.has(bare) || AVAILABLE_WORDS.has(bare)) return true;
  if (NO.has(bare) || UNAVAILABLE_WORDS.has(bare)) return false;
  const schemaOrg = /^(?:https?:\/\/)?(?:www\.)?schema\.org\/([a-z]+)$/.exec(bare);
  const availability = schemaOrg ? SCHEMA_ORG_AVAILABILITY.get(schemaOrg[1]) : undefined;
  if (availability !== undefined) return availability;
  return weigh(bare, UNAVAILABLE_PATTERNS, AVAILABLE_PATTERNS);
}

/** Strips every negative phrase, then looks for a positive one in what is left. */
function weigh(text: string, negatives: readonly RegExp[], positives: readonly RegExp[]): BooleanReading {
  let rest = text;
  let negative = false;
  for (const pattern of negatives) {
    const stripped = rest.replace(pattern, ' ');
    if (stripped !== rest) {
      negative = true;
      rest = stripped;
    }
  }
  const positive = positives.some((p) => {
    p.lastIndex = 0;
    return p.test(rest);
  });
  if (negative && positive) return 'ambiguous';
  if (negative) return false;
  return positive ? true : null;
}

// ─────────────────────────────────────────────────────────────
// Workplace (remote / on-site)
// ─────────────────────────────────────────────────────────────

/**
 * `polarity`: what true means for the field. `hybrid`: the field's value
 * for a hybrid role, when its description says.
 */
export type WorkplaceTopic = { polarity: 'remote' | 'onsite'; hybrid?: boolean };

const NOT_REMOTE_PATTERNS: readonly RegExp[] = [
  phrases(
    'not (?:eligible for |available (?:for|as) |open to |offered as |possible as |suitable for )?(?:an? )?(?:fully |100 ?% |completely |entirely )?remote(?:ly)?(?: work| working| role| position| job| option| basis)?',
    'no (?:fully )?remote(?: work| working| option| possible)?',
    'remote (?:work |working )?(?:is )?not (?:possible|available|allowed|offered|an option|supported)',
    'non[ -]?remote',
    'on[ -]?site',
    'in[ -]?office',
    'office[ -]?based',
    'in[ -]?person',
    'on[ -]?premises?',
    // German, French, Spanish, Italian, Portuguese, Dutch
    'vor ort',
    'kein(?:e)? (?:home[ -]?office|remote)',
    'sur site',
    'en présentiel',
    'presencial',
    'in sede',
    'in presenza',
    'op locatie',
    'op kantoor',
  ),
];

const HYBRID_PATTERNS: readonly RegExp[] = [
  phrases('hybrid(?:e)?(?: remote| work| working| role)?', 'hybride', 'híbrido', 'ibrido', 'partially remote', 'partly remote', 'part[ -]?remote', 'remote[ -]?hybrid'),
];

const REMOTE_PATTERNS: readonly RegExp[] = [
  phrases(
    '(?:fully |100 ?% |completely |entirely )?remote(?:ly)?(?:[ -]first| ok| friendly)?',
    'work(?:ing)? from (?:home|anywhere)',
    'wfh',
    'tele(?:commut|work)\\p{L}*',
    'home[ -]?based',
    'home[ -]?office',
    'télétravail',
    'teletrabajo',
    'remoto',
    'thuiswerk\\p{L}*',
  ),
];

/** "Remote control" is not remote work. */
const NOT_WORKPLACE = /remote[ -]?control/;

const WORKPLACE_LABEL =
  /^(?:(remote(?:[ -]?(?:work|working|option|eligible|ok|allowed|friendly))?|work from home|wfh|home[ -]?office)|workplace(?: type)?|location type|work (?:location|arrangement|model|type|setting)|arrangement)(?:\s*:|\s+[-–—])\s*/;

/**
 * Reads a workplace phrase as "is remote" (true) / "is on site" (false),
 * then applies the field's polarity. `hybrid` says how the field treats a
 * hybrid role; undefined leaves it ambiguous.
 */
export function readWorkplace(text: string, topic: WorkplaceTopic): BooleanReading {
  let bare = text.replace(/[.!]+$/, '').trim();
  const label = WORKPLACE_LABEL.exec(bare);
  if (label) {
    const rest = bare.slice(label[0].length).trim();
    // "Remote: no" answers the question the label asks.
    if (label[1] && (YES.has(rest) || NO.has(rest))) return orient(YES.has(rest), topic);
    bare = rest;
  }
  // A bare yes/no answers the field's own question.
  if (YES.has(bare)) return true;
  if (NO.has(bare)) return false;
  bare = bare.replace(NOT_WORKPLACE, ' ');

  let rest = bare;
  let onsite = false;
  for (const pattern of NOT_REMOTE_PATTERNS) {
    const stripped = rest.replace(pattern, ' ');
    if (stripped !== rest) {
      onsite = true;
      rest = stripped;
    }
  }
  let hybrid = false;
  for (const pattern of HYBRID_PATTERNS) {
    const stripped = rest.replace(pattern, ' ');
    if (stripped !== rest) {
      hybrid = true;
      rest = stripped;
    }
  }
  const remote = REMOTE_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(rest);
  });
  if (hybrid) {
    // "Hybrid" next to "on-site" or "remote" says no more than hybrid alone.
    return topic.hybrid ?? 'ambiguous';
  }
  if (onsite && remote) return 'ambiguous';
  if (onsite) return orient(false, topic);
  if (remote) return orient(true, topic);
  return null;
}

function orient(isRemote: boolean, topic: WorkplaceTopic): boolean {
  return topic.polarity === 'remote' ? isRemote : !isRemote;
}

const REMOTE_WORDS = /(?<![\p{L}\p{N}])(?:remote(?:ly)?|telecommut\p{L}*|telework\p{L}*|wfh|work(?:ing)? from home|home[ -]?office|distributed team)(?![\p{L}\p{N}])/u;
const ONSITE_WORDS = /(?<![\p{L}\p{N}])(?:on[ -]?site|in[ -]?office|office[ -]?based|in[ -]?person|on[ -]?premises?)(?![\p{L}\p{N}])/u;
const TRUE_WHEN = /(?<![\p{L}\p{N}])true(?![\p{L}\p{N}])[^.;]{0,60}?(?<![\p{L}\p{N}])(remote(?:ly)?|on[ -]?site|in[ -]?office|in[ -]?person|office[ -]?based)(?![\p{L}\p{N}])/u;

/**
 * Is the boolean field about remote work, and which way round? Decided by
 * the field name first ("remote", "isRemote", "workFromHome" / "onsite",
 * "inOffice"), else by the description when it names only one side or says
 * which side is true ("true when the job is on-site"). A remote control is
 * not remote work.
 */
export function workplaceTopic(field: Pick<FieldSpec, 'name' | 'description'>): WorkplaceTopic | undefined {
  const name = splitName(typeof field.name === 'string' ? field.name : '');
  const description = typeof field.description === 'string' ? field.description.slice(0, 500).toLowerCase() : '';
  if (NOT_WORKPLACE.test(name) || NOT_WORKPLACE.test(description)) return undefined;
  const nameRemote = REMOTE_WORDS.test(name);
  const nameOnsite = ONSITE_WORDS.test(name);
  let polarity: WorkplaceTopic['polarity'] | undefined;
  if (nameRemote !== nameOnsite) {
    polarity = nameRemote ? 'remote' : 'onsite';
  } else if (!nameRemote && description) {
    const trueWhen = TRUE_WHEN.exec(description);
    if (trueWhen) polarity = REMOTE_WORDS.test(trueWhen[1]) ? 'remote' : 'onsite';
    else if (REMOTE_WORDS.test(description) !== ONSITE_WORDS.test(description)) polarity = REMOTE_WORDS.test(description) ? 'remote' : 'onsite';
  }
  if (!polarity) return undefined;
  const hybrid = hybridPolicy(description, polarity);
  return hybrid === undefined ? { polarity } : { polarity, hybrid };
}

/**
 * The field's value for a hybrid role, when the description says: "hybrid
 * counts" / "hybrid is false" for either polarity; for a remote field also
 * "fully remote", "100% remote" (→ false) and "any remote work", "including
 * hybrid" (→ true); for an on-site field "fully on-site" (→ false).
 */
function hybridPolicy(description: string, polarity: WorkplaceTopic['polarity']): boolean | undefined {
  if (!description) return undefined;
  const explicit = /hybrid[^.;]{0,40}?(?<![\p{L}])(counts?|true|yes|included|includes|false|not|no|excluded)(?![\p{L}])/u.exec(description);
  if (explicit) return !['false', 'not', 'no', 'excluded'].includes(explicit[1]);
  if (/(?:including|incl\.?|or) hybrid/.test(description)) return true;
  const side = polarity === 'remote' ? 'remote' : 'on[ -]?site|in[ -]?office|in[ -]?person';
  const only = new RegExp(
    `(?<![\\p{L}])(?:fully|completely|entirely|100 ?%|only|exclusively)(?![\\p{L}])[^.;]{0,40}?(?:${side})|(?:${side})(?:ly)?[^.;]{0,20}?(?<![\\p{L}])(?:only|exclusively)(?![\\p{L}])`,
    'u',
  );
  if (only.test(description)) return false;
  if (polarity === 'remote' && /(?<![\p{L}])(?:any|partial(?:ly)?|partly|some|at least partly)(?![\p{L}])[^.;]{0,25}?remote/u.test(description)) return true;
  return undefined;
}

/** "isRemote" → "is remote", "work_from_home" → "work from home". */
function splitName(name: string): string {
  return name
    .slice(0, 200)
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase();
}
