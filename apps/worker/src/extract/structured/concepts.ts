// Field concepts: what a customer field name means, and where schema.org (and
// common embedded JSON) keeps that value for each entity family.
//
// A customer field is matched to concepts by its name ("salePrice" → price,
// "author_name" → author); the field description is only a fallback, and only
// when it names exactly one concept. Unmatched fields are left for later
// stages: guessing here would bypass grounding with a confident-looking value.

import type { FieldSpec, NormalizedSchema } from '../types.js';
import type { Family } from './families.js';
import { identifierTokens } from './text.js';

/**
 * How a leaf value is read:
 *   text      string or number ({"@value"} unwrapped)
 *   name      string or {name} (Person, Brand, Organization, Thing)
 *   body      string or {text} (Answer, HowToStep)
 *   number    a number, or a string holding exactly one number plus currency decoration
 *   quantity  a number, or a string containing one ("4 servings", "240 calories")
 *   url       URL string, or {url | contentUrl | @id} (ImageObject)
 *   date      string with digits
 *   enum      string (schema.org enumeration URL) or boolean
 *   duration  ISO 8601 duration string
 */
export type ValueKind = 'text' | 'name' | 'body' | 'number' | 'quantity' | 'url' | 'date' | 'enum' | 'duration';

/** Multi-valued concepts collect every member of an array value. */
export type MultiMode = 'values' | 'keywords';

export type SpecialResolver =
  | 'price'
  | 'originalPrice'
  | 'lowPrice'
  | 'highPrice'
  | 'currency'
  | 'offerField'
  | 'salary'
  | 'salaryMin'
  | 'salaryMax';

export type PathTable = Readonly<Partial<Record<Family | 'default', readonly string[]>>>;

export interface Concept {
  readonly id: string;
  readonly kind: ValueKind;
  /** Field-name phrases (space-separated lowercase tokens). */
  readonly syn: readonly string[];
  readonly multi?: MultiMode;
  /** Separator when a multi-valued concept fills a string field; none → the first value. */
  readonly join?: string;
  /** Families for which this field is characteristic (entity ranking). */
  readonly fit?: readonly Family[];
  /** Slash-separated property paths per family; 'default' applies to every family. */
  readonly paths?: PathTable;
  readonly og?: readonly string[];
  readonly meta?: readonly string[];
  readonly special?: SpecialResolver;
  /** Offer property read by the 'offerField' resolver. */
  readonly offerKey?: string;
  /** May fill a boolean field (availability → inStock). */
  readonly bool?: boolean;
  /** Paths tried on a list's ListItem wrapper when the item itself lacks the value. */
  readonly wrapper?: readonly string[];
  /** A page-level OpenGraph item may fill this concept for the page's main entity. */
  readonly pageLevel?: boolean;
  /** Extra validation of a raw value (identifier check digits/lengths). */
  readonly check?: (raw: unknown) => boolean;
}

const PRICE_FIT: readonly Family[] = ['product', 'offer', 'book', 'software'];
const OFFER_FIT: readonly Family[] = ['product', 'offer'];
const RATING_FIT: readonly Family[] = ['product', 'book', 'recipe', 'software', 'organization', 'course', 'video', 'place', 'creative', 'review'];
const AUTHOR_FIT: readonly Family[] = ['article', 'book', 'recipe', 'review', 'video', 'creative'];
const DATE_FIT: readonly Family[] = ['article', 'book', 'video', 'creative', 'review'];

function addressPaths(sub: string): PathTable {
  return {
    job: [`jobLocation/address/${sub}`],
    event: [`location/address/${sub}`],
    person: [`address/${sub}`, `homeLocation/address/${sub}`],
    default: [`address/${sub}`, `location/address/${sub}`],
  };
}

function digitsOf(raw: unknown): string | undefined {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : undefined;
  if (typeof raw !== 'string') return undefined;
  const t = raw.replace(/[\s-]/g, '');
  return /^\d+$/.test(t) ? t : undefined;
}

// GTINs are often published without leading zeros (and as JSON numbers).
const gtinOfLength = (len: number) => (raw: unknown) => {
  const d = digitsOf(raw);
  return d !== undefined && d.length <= len && d.length >= len - 2;
};
const anyGtin = (raw: unknown) => {
  const d = digitsOf(raw);
  return d !== undefined && d.length >= 6 && d.length <= 14;
};
const isbnLike = (raw: unknown) => {
  if (typeof raw !== 'string' && typeof raw !== 'number') return false;
  const t = String(raw).replace(/^isbn(?:-1[03])?:?\s*/i, '').replace(/[\s-]/g, '');
  return /^(?:\d{9}[\dXx]|\d{13})$/.test(t);
};

export const CONCEPTS: readonly Concept[] = [
  // ── names and text ──────────────────────────────────────
  {
    id: 'name',
    kind: 'text',
    syn: ['name', 'title', 'headline', 'heading', 'display name', 'full name'],
    paths: { article: ['headline', 'name'], job: ['title', 'name'], default: ['name', 'headline', 'title'] },
    og: ['og:title'],
    wrapper: ['name'],
  },
  {
    id: 'alternateName',
    kind: 'text',
    syn: ['alternate name', 'alternative name', 'alias', 'subtitle', 'sub title', 'alternative headline', 'subheadline', 'sub headline'],
    paths: { article: ['alternativeHeadline', 'alternateName'], default: ['alternateName', 'alternativeHeadline'] },
  },
  {
    id: 'description',
    kind: 'body',
    syn: ['description', 'desc', 'summary', 'overview', 'abstract', 'blurb', 'synopsis', 'excerpt', 'teaser'],
    paths: { article: ['description', 'abstract'], default: ['description'] },
    og: ['og:description'],
    meta: ['description'],
  },
  {
    id: 'articleBody',
    kind: 'body',
    fit: ['article'],
    syn: ['article body', 'body', 'content', 'text', 'full text', 'article text', 'article content', 'body text', 'main text', 'post content', 'post body'],
    paths: { review: ['reviewBody', 'text'], question: ['text'], default: ['articleBody', 'text'] },
  },

  // ── commerce ────────────────────────────────────────────
  {
    id: 'price',
    kind: 'number',
    special: 'price',
    fit: PRICE_FIT,
    syn: [
      'price', 'amount', 'cost', 'sale price', 'current price', 'selling price', 'sell price', 'offer price', 'final price',
      'now price', 'price now', 'discounted price', 'discount price', 'special price', 'deal price', 'our price', 'your price',
      'unit price', 'price amount', 'price value',
    ],
    og: ['product:sale_price:amount', 'product:price:amount', 'og:price:amount'],
    pageLevel: true,
  },
  {
    id: 'originalPrice',
    kind: 'number',
    special: 'originalPrice',
    fit: OFFER_FIT,
    syn: [
      'original price', 'list price', 'was price', 'price was', 'regular price', 'old price', 'compare at price', 'compare price',
      'compared at price', 'strikethrough price', 'strike through price', 'strike price', 'crossed out price', 'msrp', 'rrp', 'srp',
      'before price', 'price before', 'full price', 'previous price', 'price before discount', 'undiscounted price',
      'reference price', 'recommended retail price', 'suggested retail price', 'retail list price',
    ],
    pageLevel: true,
  },
  {
    id: 'lowPrice',
    kind: 'number',
    special: 'lowPrice',
    fit: OFFER_FIT,
    syn: ['low price', 'min price', 'minimum price', 'lowest price', 'price from', 'from price', 'starting price', 'starting at', 'price min', 'price low'],
  },
  {
    id: 'highPrice',
    kind: 'number',
    special: 'highPrice',
    fit: OFFER_FIT,
    syn: ['high price', 'max price', 'maximum price', 'highest price', 'price to', 'price max', 'price high'],
  },
  {
    id: 'currency',
    kind: 'text',
    special: 'currency',
    syn: ['currency', 'price currency', 'currency code', 'currency iso', 'iso currency', 'price currency code'],
    pageLevel: true,
  },
  {
    id: 'availability',
    kind: 'enum',
    special: 'offerField',
    offerKey: 'availability',
    bool: true,
    fit: OFFER_FIT,
    syn: [
      'availability', 'in stock', 'is in stock', 'instock', 'stock status', 'available', 'is available', 'availability status',
      'stock availability', 'inventory status', 'in stock status', 'stock state', 'availability text',
    ],
    og: ['product:availability', 'og:availability'],
    pageLevel: true,
  },
  {
    id: 'condition',
    kind: 'enum',
    special: 'offerField',
    offerKey: 'itemCondition',
    fit: ['product'],
    syn: ['condition', 'item condition', 'product condition'],
    paths: { default: ['itemCondition'] },
    og: ['product:condition'],
    pageLevel: true,
  },
  {
    id: 'seller',
    kind: 'name',
    special: 'offerField',
    offerKey: 'seller',
    fit: OFFER_FIT,
    syn: ['seller', 'sold by', 'merchant', 'vendor', 'retailer', 'seller name', 'merchant name', 'vendor name', 'retailer name'],
  },
  {
    id: 'priceValidUntil',
    kind: 'date',
    special: 'offerField',
    offerKey: 'priceValidUntil',
    syn: ['price valid until', 'sale ends', 'offer ends', 'offer valid until', 'sale end date', 'offer end date'],
  },
  {
    id: 'offerCount',
    kind: 'number',
    syn: ['offer count', 'number of offers', 'offers count', 'num offers', 'seller count', 'number of sellers'],
    paths: { offer: ['offerCount'], default: ['offers/offerCount'] },
  },

  // ── ratings ─────────────────────────────────────────────
  {
    id: 'rating',
    kind: 'number',
    fit: RATING_FIT,
    syn: [
      'rating', 'stars', 'star', 'star rating', 'stars rating', 'rating value', 'average rating', 'avg rating', 'review rating',
      'overall rating', 'customer rating', 'user rating', 'rating average', 'average stars', 'rating score', 'review score',
      'average review rating', 'avg stars',
    ],
    paths: { review: ['reviewRating/ratingValue'], default: ['aggregateRating/ratingValue'] },
  },
  {
    id: 'bestRating',
    kind: 'number',
    syn: ['best rating', 'max rating', 'maximum rating', 'rating scale', 'rating max', 'out of'],
    paths: { review: ['reviewRating/bestRating'], default: ['aggregateRating/bestRating'] },
  },
  {
    id: 'reviewCount',
    kind: 'number',
    fit: RATING_FIT,
    syn: [
      'review count', 'reviews', 'num reviews', 'number of reviews', 'reviews count', 'total reviews', 'review total',
      'count of reviews', 'reviews number', 'nb reviews', 'reviews total', 'total review count',
    ],
    paths: { default: ['aggregateRating/reviewCount', 'aggregateRating/ratingCount'] },
  },
  {
    id: 'ratingCount',
    kind: 'number',
    fit: RATING_FIT,
    syn: ['rating count', 'ratings', 'num ratings', 'number of ratings', 'ratings count', 'total ratings', 'votes', 'vote count', 'number of votes'],
    paths: { default: ['aggregateRating/ratingCount', 'aggregateRating/reviewCount'] },
  },

  // ── product identity ────────────────────────────────────
  {
    id: 'brand',
    kind: 'name',
    fit: ['product'],
    syn: ['brand', 'make', 'brand name', 'marque'],
    paths: { offer: ['itemOffered/brand', 'brand'], default: ['brand'] },
    og: ['product:brand', 'og:brand'],
    pageLevel: true,
  },
  {
    id: 'manufacturer',
    kind: 'name',
    syn: ['manufacturer', 'maker', 'manufacturer name', 'producer'],
    paths: { default: ['manufacturer'] },
  },
  {
    id: 'sku',
    kind: 'text',
    fit: ['product'],
    syn: ['sku', 'sku id', 'sku code', 'sku number', 'stock keeping unit', 'item number', 'article number'],
    paths: { default: ['sku', 'offers/sku'] },
    og: ['product:retailer_item_id'],
    pageLevel: true,
  },
  {
    id: 'productId',
    kind: 'text',
    syn: ['product id', 'product code', 'item id', 'item code', 'product number'],
    paths: { default: ['productID', 'sku'] },
  },
  {
    id: 'gtin',
    kind: 'text',
    syn: ['gtin', 'barcode', 'global trade item number', 'gtin code', 'barcode number'],
    paths: { default: ['gtin', 'gtin13', 'gtin12', 'gtin14', 'gtin8', 'offers/gtin'] },
    check: anyGtin,
  },
  {
    id: 'gtin13',
    kind: 'text',
    syn: ['gtin13', 'gtin 13', 'ean', 'ean13', 'ean 13', 'ean code', 'european article number'],
    paths: { default: ['gtin13', 'gtin', 'offers/gtin13'] },
    check: gtinOfLength(13),
  },
  {
    id: 'gtin12',
    kind: 'text',
    syn: ['gtin12', 'gtin 12', 'upc', 'upc code', 'upc a'],
    paths: { default: ['gtin12', 'gtin', 'offers/gtin12'] },
    check: gtinOfLength(12),
  },
  { id: 'gtin8', kind: 'text', syn: ['gtin8', 'gtin 8', 'ean8', 'ean 8'], paths: { default: ['gtin8', 'gtin'] }, check: gtinOfLength(8) },
  { id: 'gtin14', kind: 'text', syn: ['gtin14', 'gtin 14', 'itf14', 'itf 14'], paths: { default: ['gtin14', 'gtin'] }, check: gtinOfLength(14) },
  {
    id: 'mpn',
    kind: 'text',
    syn: ['mpn', 'manufacturer part number', 'part number', 'mfr part number', 'mfg part number'],
    paths: { default: ['mpn', 'offers/mpn'] },
  },
  { id: 'model', kind: 'name', syn: ['model', 'model number', 'model name', 'model no'], paths: { default: ['model'] } },
  {
    id: 'color',
    kind: 'name',
    multi: 'values',
    join: ', ',
    fit: ['product'],
    syn: ['color', 'colour', 'colors', 'colours', 'color name', 'colour name'],
    paths: { default: ['color'] },
  },
  { id: 'size', kind: 'name', multi: 'values', join: ', ', syn: ['size', 'sizes'], paths: { default: ['size'] } },
  { id: 'material', kind: 'name', multi: 'values', join: ', ', syn: ['material', 'materials', 'fabric'], paths: { default: ['material'] } },

  // ── media and links ─────────────────────────────────────
  {
    id: 'image',
    kind: 'url',
    multi: 'values',
    syn: [
      'image', 'images', 'image url', 'image urls', 'img', 'img url', 'img src', 'image src', 'image link', 'photo', 'photos',
      'photo url', 'picture', 'pictures', 'pic', 'main image', 'featured image', 'cover', 'cover image', 'cover url',
      'primary image', 'hero image', 'gallery', 'image list',
    ],
    paths: { offer: ['image', 'itemOffered/image'], default: ['image', 'photo', 'thumbnailUrl'] },
    og: ['og:image', 'og:image:url', 'og:image:secure_url'],
    pageLevel: true,
    wrapper: ['image'],
  },
  {
    id: 'thumbnail',
    kind: 'url',
    syn: ['thumbnail', 'thumbnail url', 'thumb', 'thumbnail image', 'thumb url'],
    paths: { default: ['thumbnailUrl', 'thumbnail', 'image'] },
    og: ['og:image'],
    pageLevel: true,
  },
  {
    id: 'logo',
    kind: 'url',
    syn: ['logo', 'logo url', 'company logo', 'brand logo', 'publisher logo', 'site logo'],
    paths: { job: ['hiringOrganization/logo'], article: ['publisher/logo'], default: ['logo', 'brand/logo'] },
  },
  {
    id: 'url',
    kind: 'url',
    syn: [
      'url', 'link', 'href', 'permalink', 'page url', 'canonical url', 'canonical', 'canonical link', 'web url', 'website',
      'homepage', 'web address', 'page link', 'source url', 'detail url', 'details url',
    ],
    paths: { offer: ['url', 'itemOffered/url'], default: ['url', 'mainEntityOfPage'] },
    og: ['og:url'],
    meta: ['canonical'],
    pageLevel: true,
    wrapper: ['url', 'item'],
  },

  // ── people and organizations ────────────────────────────
  {
    id: 'author',
    kind: 'name',
    multi: 'values',
    join: ', ',
    fit: AUTHOR_FIT,
    syn: [
      'author', 'authors', 'writer', 'writers', 'by', 'byline', 'author name', 'author names', 'creator', 'creators',
      'written by', 'posted by', 'reviewer', 'reviewer name', 'review author', 'journalist',
    ],
    paths: { default: ['author', 'creator'] },
    og: ['article:author', 'book:author'],
    meta: ['author'],
    pageLevel: true,
  },
  {
    id: 'publisher',
    kind: 'name',
    fit: ['article', 'book'],
    syn: ['publisher', 'publisher name', 'published by', 'publishing house', 'publication', 'news outlet', 'outlet'],
    paths: { default: ['publisher'] },
  },
  {
    id: 'company',
    kind: 'name',
    fit: ['job'],
    syn: [
      'company', 'employer', 'hiring organization', 'hiring organisation', 'company name', 'employer name', 'organization',
      'organisation', 'organization name', 'hiring company', 'firm',
    ],
    paths: { job: ['hiringOrganization'], person: ['worksFor', 'affiliation'] },
  },
  {
    id: 'siteName',
    kind: 'text',
    syn: ['site name', 'website name', 'site', 'source name', 'site title'],
    paths: { site: ['name'] },
    og: ['og:site_name'],
    pageLevel: true,
  },
  {
    id: 'jobTitle',
    kind: 'text',
    fit: ['job', 'person'],
    syn: ['job title', 'position', 'role', 'position title', 'occupation', 'designation', 'job name', 'job position', 'vacancy'],
    paths: { job: ['title', 'name'], person: ['jobTitle'] },
  },
  { id: 'givenName', kind: 'text', syn: ['first name', 'given name', 'firstname', 'forename'], paths: { default: ['givenName'] } },
  { id: 'familyName', kind: 'text', syn: ['last name', 'family name', 'surname', 'lastname'], paths: { default: ['familyName'] } },
  {
    id: 'telephone',
    kind: 'text',
    fit: ['organization'],
    syn: ['telephone', 'phone', 'phone number', 'tel', 'contact number', 'mobile', 'phone no', 'telephone number', 'contact phone'],
    paths: { default: ['telephone', 'contactPoint/telephone'] },
  },
  {
    id: 'email',
    kind: 'text',
    fit: ['organization', 'person'],
    syn: ['email', 'email address', 'e mail', 'contact email', 'mail'],
    paths: { default: ['email', 'contactPoint/email'] },
  },
  {
    id: 'openingHours',
    kind: 'text',
    multi: 'values',
    join: ', ',
    fit: ['organization'],
    syn: ['opening hours', 'hours', 'business hours', 'open hours', 'opening times', 'hours of operation'],
    paths: { default: ['openingHours'] },
  },
  {
    id: 'priceRange',
    kind: 'text',
    fit: ['organization'],
    syn: ['price range', 'price level', 'cost range', 'price bracket'],
    paths: { default: ['priceRange'] },
  },
  {
    id: 'cuisine',
    kind: 'text',
    multi: 'values',
    join: ', ',
    fit: ['recipe', 'organization'],
    syn: ['cuisine', 'cuisines', 'serves cuisine', 'cuisine type', 'food type'],
    paths: { recipe: ['recipeCuisine'], organization: ['servesCuisine'], default: ['recipeCuisine', 'servesCuisine'] },
  },
  {
    id: 'sameAs',
    kind: 'url',
    multi: 'values',
    syn: ['same as', 'social links', 'social profiles', 'social media', 'social media links', 'social urls', 'profiles'],
    paths: { default: ['sameAs'] },
  },
  {
    id: 'foundingDate',
    kind: 'date',
    syn: ['founding date', 'founded', 'founded in', 'year founded', 'established', 'founded on', 'founding year', 'year established'],
    paths: { default: ['foundingDate'] },
  },
  {
    id: 'employees',
    kind: 'quantity',
    syn: ['number of employees', 'employees', 'employee count', 'company size', 'headcount', 'staff count', 'num employees'],
    paths: { default: ['numberOfEmployees/value', 'numberOfEmployees'] },
  },

  // ── address ─────────────────────────────────────────────
  {
    id: 'location',
    kind: 'name',
    fit: ['job', 'event'],
    syn: ['location', 'job location', 'venue', 'where', 'place', 'location name', 'venue name', 'event location', 'event venue', 'work location'],
    paths: {
      job: ['jobLocation/address/addressLocality', 'jobLocation/address', 'jobLocation/name'],
      event: ['location/name', 'location/address/addressLocality', 'location/address', 'location'],
      person: ['homeLocation/name', 'address/addressLocality'],
      default: ['location/name', 'location', 'address/addressLocality'],
    },
  },
  { id: 'city', kind: 'name', syn: ['city', 'town', 'locality', 'address locality', 'city name'], paths: addressPaths('addressLocality') },
  { id: 'region', kind: 'name', syn: ['region', 'state', 'province', 'address region', 'county', 'state province'], paths: addressPaths('addressRegion') },
  { id: 'country', kind: 'name', syn: ['country', 'country code', 'address country', 'country name', 'nation'], paths: addressPaths('addressCountry') },
  { id: 'postalCode', kind: 'text', syn: ['postal code', 'zip', 'zip code', 'zipcode', 'postcode', 'post code', 'postal'], paths: addressPaths('postalCode') },
  {
    id: 'streetAddress',
    kind: 'text',
    syn: ['street address', 'street', 'address line', 'address line 1', 'address1', 'address 1', 'street line'],
    paths: addressPaths('streetAddress'),
  },
  {
    id: 'address',
    kind: 'text',
    fit: ['organization', 'place'],
    syn: ['address', 'full address', 'postal address', 'location address', 'business address'],
    paths: { job: ['jobLocation/address'], event: ['location/address'], default: ['address'] },
  },

  // ── dates ───────────────────────────────────────────────
  {
    id: 'datePublished',
    kind: 'date',
    fit: DATE_FIT,
    syn: [
      'date published', 'published at', 'published', 'publish date', 'publication date', 'published date', 'pub date',
      'posted at', 'posted on', 'post date', 'posted date', 'date posted', 'publish time', 'published time', 'release date',
      'released', 'released at', 'upload date', 'uploaded at', 'published on', 'publishing date',
    ],
    paths: { job: ['datePosted', 'datePublished'], video: ['uploadDate', 'datePublished'], default: ['datePublished'] },
    og: ['article:published_time', 'book:release_date', 'video:release_date'],
    pageLevel: true,
  },
  {
    id: 'date',
    kind: 'date',
    syn: ['date', 'day'],
    paths: { event: ['startDate'], job: ['datePosted', 'datePublished'], video: ['uploadDate', 'datePublished'], default: ['datePublished'] },
    og: ['article:published_time'],
    pageLevel: true,
  },
  {
    id: 'dateCreated',
    kind: 'date',
    syn: ['date created', 'created at', 'created', 'creation date', 'created date', 'created on'],
    paths: { default: ['dateCreated'] },
  },
  {
    id: 'dateModified',
    kind: 'date',
    fit: ['article'],
    syn: [
      'date modified', 'modified at', 'modified', 'updated at', 'updated', 'last updated', 'last modified', 'modified date',
      'update date', 'updated date', 'date updated', 'last update', 'edited at', 'updated on', 'modified on',
    ],
    paths: { default: ['dateModified'] },
    og: ['article:modified_time', 'og:updated_time'],
    pageLevel: true,
  },

  // ── classification ──────────────────────────────────────
  {
    id: 'category',
    kind: 'name',
    multi: 'values',
    join: ', ',
    syn: ['category', 'categories', 'product category', 'department', 'category name'],
    paths: {
      article: ['articleSection', 'category'],
      book: ['genre', 'category'],
      software: ['applicationCategory', 'category'],
      recipe: ['recipeCategory', 'category'],
      video: ['genre', 'category'],
      default: ['category'],
    },
    og: ['product:category', 'article:section'],
    pageLevel: true,
  },
  { id: 'genre', kind: 'name', multi: 'values', join: ', ', syn: ['genre', 'genres'], paths: { default: ['genre'] } },
  {
    id: 'section',
    kind: 'name',
    syn: ['section', 'article section', 'news section', 'news category'],
    paths: { default: ['articleSection'] },
    og: ['article:section'],
    pageLevel: true,
  },
  {
    id: 'keywords',
    kind: 'text',
    multi: 'keywords',
    join: ', ',
    fit: ['article'],
    syn: ['keywords', 'keyword', 'tags', 'tag', 'topics', 'hashtags'],
    paths: { default: ['keywords'] },
    meta: ['keywords'],
    pageLevel: true,
  },

  // ── books ───────────────────────────────────────────────
  {
    id: 'isbn',
    kind: 'text',
    fit: ['book'],
    syn: ['isbn', 'isbn13', 'isbn10', 'isbn 13', 'isbn 10', 'isbn number', 'isbn code'],
    paths: { default: ['isbn'] },
    og: ['book:isbn'],
    pageLevel: true,
    check: isbnLike,
  },
  {
    id: 'numberOfPages',
    kind: 'number',
    fit: ['book'],
    syn: ['number of pages', 'pages', 'page count', 'num pages', 'pages count', 'total pages', 'no of pages', 'pagecount'],
    paths: { default: ['numberOfPages'] },
  },
  { id: 'bookFormat', kind: 'enum', syn: ['book format', 'format', 'binding', 'book binding'], paths: { default: ['bookFormat'] } },
  { id: 'bookEdition', kind: 'text', syn: ['edition', 'book edition'], paths: { default: ['bookEdition'] } },
  { id: 'language', kind: 'name', syn: ['language', 'in language', 'lang', 'languages'], paths: { default: ['inLanguage'] } },
  { id: 'illustrator', kind: 'name', multi: 'values', join: ', ', syn: ['illustrator', 'illustrators'], paths: { default: ['illustrator'] } },
  {
    id: 'wordCount',
    kind: 'number',
    fit: ['article'],
    syn: ['word count', 'words', 'number of words', 'words count'],
    paths: { default: ['wordCount'] },
  },

  // ── jobs ────────────────────────────────────────────────
  {
    id: 'salary',
    kind: 'number',
    special: 'salary',
    fit: ['job'],
    syn: ['salary', 'base salary', 'pay', 'compensation', 'wage', 'wages', 'salary amount', 'pay rate', 'salary value', 'remuneration', 'estimated salary'],
  },
  {
    id: 'salaryMin',
    kind: 'number',
    special: 'salaryMin',
    fit: ['job'],
    syn: ['salary min', 'min salary', 'minimum salary', 'salary from', 'salary minimum', 'min pay', 'lowest salary', 'salary low', 'salary lower bound'],
  },
  {
    id: 'salaryMax',
    kind: 'number',
    special: 'salaryMax',
    fit: ['job'],
    syn: ['salary max', 'max salary', 'maximum salary', 'salary to', 'salary maximum', 'max pay', 'highest salary', 'salary high', 'salary upper bound'],
  },
  {
    id: 'salaryUnit',
    kind: 'enum',
    fit: ['job'],
    syn: ['salary unit', 'salary period', 'pay period', 'pay frequency', 'salary frequency', 'salary interval', 'pay unit'],
    paths: { default: ['baseSalary/value/unitText', 'baseSalary/unitText', 'estimatedSalary/value/unitText'] },
  },
  {
    id: 'salaryCurrency',
    kind: 'text',
    fit: ['job'],
    syn: ['salary currency', 'pay currency', 'wage currency'],
    paths: { default: ['baseSalary/currency', 'salaryCurrency', 'estimatedSalary/currency'] },
  },
  {
    id: 'employmentType',
    kind: 'enum',
    multi: 'values',
    join: ', ',
    fit: ['job'],
    syn: ['employment type', 'job type', 'contract type', 'work type', 'type of employment', 'employment'],
    paths: { default: ['employmentType'] },
  },
  {
    id: 'validThrough',
    kind: 'date',
    fit: ['job'],
    syn: [
      'valid through', 'expires', 'expiry date', 'expiration date', 'closing date', 'deadline', 'apply by', 'application deadline',
      'expires at', 'valid until', 'expiry',
    ],
    paths: { default: ['validThrough'] },
  },
  {
    id: 'experience',
    kind: 'body',
    syn: ['experience', 'experience requirements', 'experience required', 'required experience', 'years of experience'],
    paths: { default: ['experienceRequirements'] },
  },
  {
    id: 'education',
    kind: 'body',
    syn: ['education', 'education requirements', 'education required', 'required education', 'educational requirements'],
    paths: { default: ['educationRequirements'] },
  },
  { id: 'qualifications', kind: 'body', syn: ['qualifications', 'requirements', 'job requirements'], paths: { default: ['qualifications'] } },
  {
    id: 'responsibilities',
    kind: 'body',
    syn: ['responsibilities', 'duties', 'job duties', 'job responsibilities'],
    paths: { default: ['responsibilities'] },
  },
  { id: 'skills', kind: 'text', multi: 'values', join: ', ', syn: ['skills', 'required skills', 'skill', 'skill set', 'skillset'], paths: { default: ['skills'] } },
  { id: 'industry', kind: 'text', syn: ['industry', 'sector'], paths: { default: ['industry'] } },

  // ── events ──────────────────────────────────────────────
  {
    id: 'startDate',
    kind: 'date',
    fit: ['event'],
    syn: [
      'start date', 'starts at', 'start time', 'start', 'begins', 'begin date', 'event date', 'date start', 'start datetime',
      'starts on', 'start at', 'begins at', 'event start', 'from date', 'date from', 'start date time', 'starts',
    ],
    paths: { job: ['jobStartDate'], default: ['startDate'] },
  },
  {
    id: 'endDate',
    kind: 'date',
    fit: ['event'],
    syn: ['end date', 'ends at', 'end time', 'end', 'ends', 'date end', 'end datetime', 'ends on', 'event end', 'to date', 'date to', 'until', 'end date time'],
    paths: { default: ['endDate'] },
  },
  {
    id: 'organizer',
    kind: 'name',
    multi: 'values',
    join: ', ',
    fit: ['event'],
    syn: ['organizer', 'organiser', 'organizers', 'organisers', 'host', 'hosted by', 'organized by', 'organised by'],
    paths: { default: ['organizer'] },
  },
  {
    id: 'performer',
    kind: 'name',
    multi: 'values',
    join: ', ',
    fit: ['event'],
    syn: ['performer', 'performers', 'artist', 'artists', 'lineup', 'line up', 'band', 'speaker', 'speakers', 'headliner'],
    paths: { default: ['performer'] },
  },
  { id: 'eventStatus', kind: 'enum', syn: ['event status'], paths: { default: ['eventStatus'] } },
  {
    id: 'attendanceMode',
    kind: 'enum',
    syn: ['attendance mode', 'event attendance mode', 'event mode', 'event format'],
    paths: { default: ['eventAttendanceMode'] },
  },

  // ── recipes ─────────────────────────────────────────────
  {
    id: 'ingredients',
    kind: 'text',
    multi: 'values',
    join: '\n',
    fit: ['recipe'],
    syn: ['ingredients', 'recipe ingredients', 'ingredient list', 'ingredient', 'recipe ingredient'],
    paths: { default: ['recipeIngredient', 'ingredients'] },
  },
  {
    id: 'instructions',
    kind: 'body',
    multi: 'values',
    join: '\n',
    fit: ['recipe'],
    syn: ['instructions', 'recipe instructions', 'steps', 'directions', 'method', 'preparation steps', 'instruction', 'step', 'recipe steps'],
    paths: { default: ['recipeInstructions', 'step'] },
  },
  { id: 'prepTime', kind: 'duration', fit: ['recipe'], syn: ['prep time', 'preparation time', 'prep duration', 'time to prep'], paths: { default: ['prepTime'] } },
  {
    id: 'cookTime',
    kind: 'duration',
    fit: ['recipe'],
    syn: ['cook time', 'cooking time', 'cook duration', 'bake time', 'baking time'],
    paths: { default: ['cookTime'] },
  },
  {
    id: 'totalTime',
    kind: 'duration',
    fit: ['recipe'],
    syn: ['total time', 'ready in', 'total duration', 'time required'],
    paths: { default: ['totalTime', 'timeRequired'] },
  },
  {
    id: 'recipeYield',
    kind: 'quantity',
    fit: ['recipe'],
    syn: ['servings', 'yield', 'serves', 'recipe yield', 'portions', 'number of servings', 'yields', 'serving count'],
    paths: { default: ['recipeYield', 'yield'] },
  },
  {
    id: 'calories',
    kind: 'quantity',
    fit: ['recipe'],
    syn: ['calories', 'kcal', 'calorie count', 'energy', 'calories per serving'],
    paths: { default: ['nutrition/calories'] },
  },
  {
    id: 'duration',
    kind: 'duration',
    syn: ['duration', 'runtime', 'run time', 'running time', 'video duration', 'length'],
    paths: { default: ['duration', 'timeRequired'] },
  },

  // ── FAQ, software, courses, reviews, lists ──────────────
  {
    id: 'question',
    kind: 'text',
    fit: ['question'],
    syn: ['question', 'question text', 'faq question', 'q'],
    paths: { question: ['name', 'text'] },
  },
  {
    id: 'answer',
    kind: 'body',
    fit: ['question'],
    syn: ['answer', 'answer text', 'faq answer', 'a', 'accepted answer', 'response', 'reply'],
    paths: { question: ['acceptedAnswer', 'suggestedAnswer'] },
  },
  {
    id: 'operatingSystem',
    kind: 'text',
    fit: ['software'],
    syn: ['operating system', 'operating systems', 'os', 'platform', 'platforms', 'supported platforms', 'supported os'],
    paths: { default: ['operatingSystem'] },
  },
  {
    id: 'applicationCategory',
    kind: 'text',
    syn: ['application category', 'app category', 'software category'],
    paths: { default: ['applicationCategory'] },
  },
  {
    id: 'softwareVersion',
    kind: 'text',
    fit: ['software'],
    syn: ['version', 'software version', 'app version', 'latest version', 'current version', 'version number'],
    paths: { default: ['softwareVersion', 'version'] },
  },
  { id: 'fileSize', kind: 'text', syn: ['file size', 'download size', 'app size', 'install size'], paths: { default: ['fileSize'] } },
  {
    id: 'downloadUrl',
    kind: 'url',
    syn: ['download url', 'download link', 'install url', 'install link'],
    paths: { default: ['downloadUrl', 'installUrl'] },
  },
  {
    id: 'provider',
    kind: 'name',
    fit: ['course'],
    syn: ['provider', 'course provider', 'institution', 'school', 'university', 'offered by'],
    paths: { course: ['provider'] },
  },
  {
    id: 'reviewBody',
    kind: 'body',
    fit: ['review'],
    syn: ['review body', 'review text', 'review', 'review content', 'comment', 'comment text', 'review comment', 'testimonial'],
    paths: { review: ['reviewBody', 'description', 'text'] },
  },
  {
    id: 'rank',
    kind: 'number',
    syn: ['rank', 'position', 'list position', 'ranking', 'rank position', 'list rank'],
    paths: { default: ['position'] },
    wrapper: ['position'],
  },
  {
    id: 'numberOfItems',
    kind: 'number',
    syn: ['number of items', 'item count', 'total items', 'results count', 'total results', 'number of results', 'items count', 'number of products'],
    paths: { list: ['numberOfItems'] },
  },
];

// ─────────────────────────────────────────────────────────────
// Field-name → concept matching
// ─────────────────────────────────────────────────────────────

const PHRASES = new Map<string, Concept[]>();
for (const c of CONCEPTS) {
  for (const phrase of c.syn) {
    const list = PHRASES.get(phrase);
    if (!list) PHRASES.set(phrase, [c]);
    else if (!list.includes(c)) list.push(c);
  }
}

export const CONCEPT_BY_ID: ReadonlyMap<string, Concept> = new Map(CONCEPTS.map((c) => [c.id, c]));

// Qualifiers that do not change what a field means ("productTitle",
// "item_price", "priceText"). Removed only after the full name failed to match,
// so "productId" or "jobTitle" keep their specific meaning.
const NOISE = new Set([
  'the', 'a', 'an', 'its', 'this', 'product', 'products', 'item', 'items', 'book', 'article', 'post', 'blog', 'job', 'event',
  'recipe', 'listing', 'page', 'main', 'primary', 'value', 'text', 'field', 'info', 'data', 'string', 'str',
]);

function singularLast(tokens: readonly string[]): string[] | undefined {
  const last = tokens[tokens.length - 1];
  if (!last || last.length <= 3 || !last.endsWith('s') || last.endsWith('ss')) return undefined;
  const single = last.endsWith('ies') ? `${last.slice(0, -3)}y` : last.slice(0, -1);
  return [...tokens.slice(0, -1), single];
}

/** Concepts named by an identifier (field name or embedded-JSON key); [] when none. */
export function conceptsForName(name: string): readonly Concept[] {
  const tokens = identifierTokens(name);
  if (tokens.length === 0 || tokens.length > 8) return [];
  const attempts: Array<readonly string[] | undefined> = [tokens, singularLast(tokens)];
  const stripped = tokens.filter((t) => !NOISE.has(t));
  if (stripped.length > 0 && stripped.length < tokens.length) attempts.push(stripped, singularLast(stripped));
  for (const attempt of attempts) {
    if (!attempt) continue;
    const hit = PHRASES.get(attempt.join(' '));
    if (hit) return hit;
  }
  return [];
}

// Phrases that are too ambiguous to trust inside free-text descriptions
// ("a", "by", "end", "start", "out of", ...). Field names may still use them.
const DESCRIPTION_STOP = new Set([
  'a', 'q', 'by', 'start', 'starts', 'end', 'ends', 'until', 'begins', 'text', 'content', 'body', 'method', 'steps', 'step',
  'pages', 'size', 'state', 'where', 'place', 'cover', 'serves', 'make', 'host', 'pay', 'hours', 'os', 'tel', 'available',
  'section', 'length', 'comment', 'response', 'reply', 'published', 'updated', 'modified', 'released', 'founded', 'established',
  'expires', 'position', 'role', 'rank', 'ratings', 'votes', 'reviews', 'review', 'link', 'website', 'site', 'out of', 'words',
  'created', 'day', 'date', 'heading', 'model', 'format', 'edition', 'mail', 'mobile', 'energy', 'employment',
  'organization', 'organisation', 'company', 'platform', 'version', 'street', 'region', 'county', 'nation', 'store', 'amount',
  'cost', 'star', 'stars', 'cuisine', 'performer', 'band', 'artist', 'speaker', 'lineup', 'duration', 'type', 'status',
]);

const MAX_DESCRIPTION_TOKENS = 80;

/** Concepts named in a field description; used only when exactly one concept is named. */
export function conceptsInDescription(description: string): Concept[] {
  const tokens = (description.slice(0, 2000).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_DESCRIPTION_TOKENS);
  const found: Concept[] = [];
  for (let i = 0; i < tokens.length; ) {
    let advanced = false;
    for (let n = Math.min(5, tokens.length - i); n >= 1; n--) {
      const phrase = tokens.slice(i, i + n).join(' ');
      if (DESCRIPTION_STOP.has(phrase)) continue;
      const hit = PHRASES.get(phrase);
      if (!hit) continue;
      for (const c of hit) if (!found.includes(c)) found.push(c);
      i += n;
      advanced = true;
      break;
    }
    if (!advanced) i++;
  }
  return found;
}

// ─────────────────────────────────────────────────────────────
// Schema plan
// ─────────────────────────────────────────────────────────────

export type OutputMode = 'scalar' | 'join' | 'array' | 'auto';

export interface FieldPlan {
  readonly index: number;
  readonly field: FieldSpec;
  /** Candidate concepts in priority order; empty → exact-key fallback only. */
  readonly concepts: readonly Concept[];
  /** Families for which this field is characteristic (union over concepts). */
  readonly fit: ReadonlySet<Family>;
  /** Identifier phrase used by the exact-key fallback. */
  readonly keyPhrase: string;
  /**
   * The name means no known concept: a property with exactly this name
   * ("color" ↔ "color", "isbn13" ↔ "isbn13") may still fill it. Never used when
   * the name matched a concept of an incompatible type.
   */
  readonly exactKeyFallback: boolean;
  readonly matchedBy: 'name' | 'description' | 'none';
}

export interface SchemaPlan {
  readonly fields: readonly FieldPlan[];
}

/** Can a value of this concept fill a field of this type? */
export function compatible(c: Concept, field: FieldSpec): boolean {
  switch (field.type) {
    case 'number':
    case 'integer':
      return c.kind === 'number' || c.kind === 'quantity';
    case 'boolean':
      return c.bool === true;
    case 'array':
      return c.multi !== undefined && field.itemType !== 'object' && field.itemType !== 'array';
    case 'object':
      return false;
    default:
      return true;
  }
}

/** How a (possibly multi-valued) concept's values are shaped for this field. */
export function outputMode(c: Concept, field: FieldSpec): OutputMode {
  if (!c.multi) return 'scalar';
  if (field.type === 'array') return 'array';
  // Values that cannot be joined (image URLs): a single field takes the first.
  if (c.join === undefined) return 'scalar';
  return field.type === 'unknown' ? 'auto' : 'join';
}

const planCache = new WeakMap<NormalizedSchema, SchemaPlan>();

export function planSchema(schema: NormalizedSchema): SchemaPlan {
  const cached = planCache.get(schema);
  if (cached) return cached;
  const fields = (Array.isArray(schema.fields) ? schema.fields : []).map((field, index) => planField(field, index));
  const plan: SchemaPlan = { fields };
  planCache.set(schema, plan);
  return plan;
}

function planField(field: FieldSpec, index: number): FieldPlan {
  const name = typeof field.name === 'string' ? field.name : '';
  let matchedBy: FieldPlan['matchedBy'] = 'none';
  let concepts: readonly Concept[] = [];
  const byName = conceptsForName(name);
  if (byName.length > 0) {
    // A name match with an incompatible type (e.g. "reviews" as an array of
    // objects) is a different field, not a reason to consult the description.
    concepts = byName.filter((c) => compatible(c, field));
    matchedBy = concepts.length > 0 ? 'name' : 'none';
  } else if (typeof field.description === 'string' && field.description.trim()) {
    const named = conceptsInDescription(field.description).filter((c) => compatible(c, field));
    if (named.length === 1) {
      concepts = named;
      matchedBy = 'description';
    }
  }
  const fit = new Set<Family>();
  for (const c of concepts) for (const f of c.fit ?? []) fit.add(f);
  const keyPhrase = identifierTokens(name).join(' ');
  const exactKeyFallback = byName.length === 0 && concepts.length === 0 && keyPhrase.length > 0;
  return { index, field, concepts, fit, keyPhrase, exactKeyFallback, matchedBy };
}

/** Property paths of a concept for an entity's families (family-specific first, then defaults). */
export function pathsFor(c: Concept, families: readonly Family[]): readonly string[] {
  const table = c.paths;
  if (!table) return [];
  const out: string[] = [];
  for (const f of families) {
    const specific = table[f];
    if (specific) {
      for (const p of specific) if (!out.includes(p)) out.push(p);
      break;
    }
  }
  for (const p of table.default ?? []) if (!out.includes(p)) out.push(p);
  return out;
}
