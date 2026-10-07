// schema.org types grouped into families. Field synonyms, pointer tables and
// entity ranking work per family so that the long tail of subtypes
// (NewsArticle, Restaurant, MusicEvent, ...) behaves like its parent.

export type Family =
  | 'product'
  | 'offer'
  | 'book'
  | 'article'
  | 'job'
  | 'event'
  | 'recipe'
  | 'organization'
  | 'person'
  | 'faq'
  | 'question'
  | 'software'
  | 'video'
  | 'course'
  | 'review'
  | 'place'
  | 'creative'
  | 'page'
  | 'site'
  | 'list'
  | 'navigation'
  | 'other';

const EXACT: Record<string, Family> = {
  Product: 'product',
  ProductGroup: 'product',
  ProductModel: 'product',
  IndividualProduct: 'product',
  SomeProducts: 'product',
  Vehicle: 'product',
  Car: 'product',
  Motorcycle: 'product',
  MotorizedBicycle: 'product',
  BusOrCoach: 'product',
  Offer: 'offer',
  AggregateOffer: 'offer',
  Book: 'book',
  Audiobook: 'book',
  Blog: 'article',
  JobPosting: 'job',
  Festival: 'event',
  Recipe: 'recipe',
  Organization: 'organization',
  Corporation: 'organization',
  NGO: 'organization',
  Airline: 'organization',
  Consortium: 'organization',
  Person: 'person',
  FAQPage: 'faq',
  Question: 'question',
  SoftwareApplication: 'software',
  VideoGame: 'software',
  VideoObject: 'video',
  Course: 'course',
  Recommendation: 'review',
  Place: 'place',
  TouristAttraction: 'place',
  TouristDestination: 'place',
  Accommodation: 'place',
  Residence: 'place',
  LandmarksOrHistoricalBuildings: 'place',
  CreativeWork: 'creative',
  Movie: 'creative',
  TVSeries: 'creative',
  Episode: 'creative',
  MusicRecording: 'creative',
  MusicAlbum: 'creative',
  MusicPlaylist: 'creative',
  PodcastEpisode: 'creative',
  PodcastSeries: 'creative',
  Dataset: 'creative',
  HowTo: 'creative',
  Game: 'creative',
  Photograph: 'creative',
  Painting: 'creative',
  Sculpture: 'creative',
  WebSite: 'site',
  ItemList: 'list',
  OfferCatalog: 'list',
  // Navigation is never the record and never a listing.
  BreadcrumbList: 'navigation',
  SiteNavigationElement: 'navigation',
  WPHeader: 'navigation',
  WPFooter: 'navigation',
  WPSideBar: 'navigation',
};

// Checked in order after EXACT: JobPosting is exact, so "Posting" means
// BlogPosting / SocialMediaPosting / DiscussionForumPosting.
const SUFFIXES: ReadonlyArray<readonly [string, Family]> = [
  ['Product', 'product'],
  ['Offer', 'offer'],
  ['Article', 'article'],
  ['Posting', 'article'],
  ['Event', 'event'],
  ['Review', 'review'],
  ['Application', 'software'],
  ['Page', 'page'],
  ['Organization', 'organization'],
  ['Business', 'organization'],
  ['Store', 'organization'],
  ['Restaurant', 'organization'],
  ['Hotel', 'organization'],
  ['Shop', 'organization'],
  ['Agency', 'organization'],
  ['Dealer', 'organization'],
  ['Office', 'organization'],
  ['Clinic', 'organization'],
];

export function familyOfType(type: string): Family {
  if (Object.hasOwn(EXACT, type)) return EXACT[type];
  for (const [suffix, family] of SUFFIXES) {
    if (type.endsWith(suffix)) return family;
  }
  return 'other';
}

/** Families of a type list, most specific first, without duplicates. */
export function familiesOf(types: readonly string[]): Family[] {
  const out: Family[] = [];
  for (const t of types) {
    const f = familyOfType(t);
    if (!out.includes(f)) out.push(f);
  }
  if (out.length === 0) out.push('other');
  // A known family beats 'other' when a node lists both ("Product", "Thing").
  if (out.length > 1 && out.includes('other')) out.splice(out.indexOf('other'), 1);
  return out;
}

/**
 * How much an entity of this family is "what the page is about". Content
 * entities (a product, an article) beat page and organization entities,
 * which beat site scaffolding (WebSite, lists, navigation).
 */
export const FAMILY_PRIOR: Readonly<Record<Family, number>> = {
  product: 2,
  offer: 2,
  book: 2,
  article: 2,
  job: 2,
  event: 2,
  recipe: 2,
  faq: 2,
  question: 2,
  software: 2,
  video: 2,
  course: 2,
  review: 2,
  place: 2,
  creative: 2,
  organization: 1,
  person: 1,
  page: 1,
  site: 0,
  list: 0,
  navigation: 0,
  other: 0,
};

/** Families whose repeated top-level entities form a listing. */
export const LISTABLE: ReadonlySet<Family> = new Set<Family>([
  'product',
  'offer',
  'book',
  'article',
  'job',
  'event',
  'recipe',
  'software',
  'video',
  'course',
  'review',
  'place',
  'creative',
  'question',
  'organization',
  'person',
]);

export function isContentFamily(f: Family): boolean {
  return FAMILY_PRIOR[f] >= 2;
}

/** og:type → family ("product", "product.item", "article", "video.movie", ...). */
export function familyOfOgType(ogType: unknown): Family {
  if (typeof ogType !== 'string') return 'page';
  const t = ogType.trim().toLowerCase();
  if (t === 'product' || t.startsWith('product.') || t === 'og:product') return 'product';
  if (t === 'article' || t.startsWith('article.')) return 'article';
  if (t === 'book' || t.startsWith('books.')) return 'book';
  if (t === 'profile') return 'person';
  if (t.startsWith('video.')) return 'video';
  if (t.startsWith('music.')) return 'creative';
  return 'page';
}
