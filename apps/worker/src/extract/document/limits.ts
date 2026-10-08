// Hard limits for buildSourceDocument. Every limit exists to keep one hostile
// or pathological page from blowing up CPU, memory or downstream recursion.

export const DOCUMENT_LIMITS = {
  /** Emission stops after this many blocks; stats.truncated is set. */
  maxBlocks: 20_000,
  /**
   * Elements deeper than this (counted from <body>) never own blocks: their
   * text is folded into the nearest shallower owner. Bounds selector length
   * (and therefore document size) on adversarially deep DOMs.
   */
  maxBlockDepth: 80,
  /**
   * Raw HTML nesting deeper than this is flattened before parsing (parse5 is
   * quadratic in nesting depth). Real pages stay far below it.
   */
  maxHtmlNesting: 512,
  /** Scripts whose text is longer than this (UTF-16 chars) are not parsed. */
  maxScriptChars: 2 * 1024 * 1024,
  maxStructuredItems: 200,
  /** Parsed JSON nested deeper than this is skipped (JSON.stringify recursion). */
  maxJsonDepth: 128,
  maxMicrodataDepth: 32,
  maxMicrodataProps: 5_000,
  maxMicrodataTextChars: 2_000,
  maxMetaValueChars: 2_000,
  maxTableRows: 2_000,
  maxTableCols: 100,
  maxColspan: 100,
  maxRowspan: 1_000,
  maxRecordGroups: 100,
  minRecordsPerGroup: 3,
  /** Visible non-whitespace chars each record needs. */
  minRecordTextChars: 10,
  /** A field is a small leaf: at most this many visible non-whitespace chars. */
  maxFieldChars: 200,
  maxHeadingPathChars: 200,
  maxAttrChars: 500,
  maxClassChars: 200,
  maxDataAttrs: 10,
  maxDataAttrChars: 200,
  maxUrlChars: 2_048,
} as const;
