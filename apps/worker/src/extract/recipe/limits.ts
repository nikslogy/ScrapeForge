// Hard limits for declarative extraction recipes. Recipes are written by a
// model (or induced from page content an attacker may control), so every
// dimension that drives CPU or memory in the interpreter is bounded here and
// enforced by validateRecipe before anything runs.

export const RECIPE_LIMITS = {
  maxFields: 100,
  maxFieldNameChars: 200,
  maxSelectorChars: 300,
  /** Compound selectors in one selector, counted across lists and pseudo-class arguments. */
  maxCompoundSelectors: 12,
  /** Nesting depth of selector arguments (:not(:is(...))). */
  maxSelectorNesting: 3,
  maxAttrNameChars: 100,
  maxTransforms: 12,
  maxRegexChars: 200,
  /** Regex transforms across the whole recipe (each one is analysed and compiled). */
  maxRegexesPerRecipe: 50,
  /** The regex transform only ever sees this many leading chars of its input. */
  maxRegexInputChars: 10_000,
  /**
   * Regex input chars across one run. V8 cannot interrupt a regex, so the run
   * also checks its deadline before every regex application; this cap bounds
   * the total when the deadline is far off (100 inputs at the per-exec cap).
   */
  maxRegexInputCharsPerRun: 1_000_000,
  maxMapEntries: 100,
  maxMapKeyChars: 200,
  maxMapValueChars: 1_000,
  maxPointerChars: 200,
  maxPointerSegments: 32,
  maxStructuredTypeChars: 100,
  defaultMaxRecords: 5_000,
  /** Items collected per field when `all: true`. */
  maxItemsPerField: 100,
  /** Longest value (text, attribute, structured string) a field yields. */
  maxValueChars: 100_000,
  /** Raw chars read across one run; a hostile recipe/page pair stops here instead of exhausting memory. */
  maxOutputChars: 10_000_000,
  /** Values (array items included) produced by one run. */
  maxOutputValues: 500_000,
} as const;
