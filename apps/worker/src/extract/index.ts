// Public surface of the structured-extraction engine (docs/engine/DESIGN.md).

export { blockedFromQualitySignals, decimalSeparatorFromHtml, detectBlockedPage, extractStructured, flushRecipeLearning } from './engine.js';
export type { ExtractDeps, LearningMode } from './engine.js';
export type {
  EvidenceSource,
  ExtractionMethod,
  ExtractionOutcome,
  ExtractionStatus,
  ExtractRequest,
  FieldEvidence,
  LlmAttemptRecord,
  LlmUsageSummary,
  MissingField,
  MissingReason,
} from './types.js';
export { createDefaultModelClient, ModelClient } from './llm/index.js';
export { RecipeStore } from './recipe/index.js';
export type { RecipeKv } from './recipe/index.js';
