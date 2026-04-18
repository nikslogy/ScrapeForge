import type { OutputFormat } from '@scrapeforge/shared';
import { extractContent, type ExtractionResult } from './pipeline-impl.js';

export interface ExtractPayload {
  rawHtml: string;
  url: string;
  formats: OutputFormat[];
}

export default async function extractInWorker(
  payload: ExtractPayload,
): Promise<ExtractionResult> {
  return extractContent(payload.rawHtml, payload.url, payload.formats);
}
