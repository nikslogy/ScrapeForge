// Hard limits for the structured-data mapper. Structured data comes from the
// page, so every loop over it is bounded: one hostile page must not cost more
// than a few milliseconds here.

export const STRUCTURED_LIMITS = {
  /** Records returned for array shape; longer lists are cut with a warning. */
  maxRecords: 5_000,
  /** Offers inspected per entity. */
  maxOffers: 200,
  /** Values collected for one multi-valued field (authors, images, ...). */
  maxMultiValues: 100,
  /** priceSpecification entries inspected per offer. */
  maxPriceSpecs: 20,
  /** Embedded JSON: nodes visited per script and per page. */
  maxEmbeddedNodesPerItem: 25_000,
  maxEmbeddedNodesTotal: 100_000,
  maxEmbeddedDepth: 24,
  /** Embedded JSON: entities (single or list members) admitted per page. */
  maxEmbeddedEntities: 300,
  /** Own keys inspected per object (direct key matching, BFS fan-out). */
  maxKeysPerObject: 500,
  /** Array elements walked per array during embedded discovery. */
  maxArrayFanOut: 1_000,
  /** {"@id": ...} references followed per lookup (cycles are possible). */
  maxRefHops: 3,
  /** Wrapper objects unwrapped while reading one leaf value. */
  maxLeafDepth: 4,
  /** mainEntity chains followed from a page entity. */
  maxMainEntityDepth: 3,
  /** Total entities created from JSON-LD / microdata (list members included). */
  maxEntities: 12_000,
  /** Visibility: tokens of a value compared against the page. */
  maxVisibilityTokens: 400,
  /** Visibility: members of an array value checked. */
  maxVisibleArrayMembers: 50,
  /** Below this many visible characters the page is a script shell and visibility is not used to admit data. */
  minSubstantialTextChars: 200,
  /** Embedded lists: share of sampled member names that must be visible. */
  embeddedListVisibleRatio: 0.5,
  embeddedListSample: 20,
} as const;
