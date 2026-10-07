import { Redis } from 'ioredis';

/**
 * Publishes SSE progress events to a Redis channel so the API server
 * can stream them to clients.
 *
 * Channel pattern: `sse:{jobId}`
 * Each message is JSON: { event, data }
 */
export class SseEmitter {
  constructor(private redis: Redis) {}

  async emit(jobId: string, event: string, data: unknown): Promise<void> {
    const channel = `sse:${jobId}`;
    const msg = JSON.stringify({ event, data, ts: Date.now() });
    await this.redis.publish(channel, msg);
  }

  async emitHeaders(jobId: string, statusCode: number, headers: Record<string, string>): Promise<void> {
    await this.emit(jobId, 'headers', { statusCode, headers });
  }

  async emitContent(jobId: string, format: string, preview: string): Promise<void> {
    await this.emit(jobId, 'content', { format, preview: preview.slice(0, 500) });
  }

  // Extraction data is an object for single-entity pages, an array of records
  // for listing pages, or a whole ExtractionOutcome; anything JSON-serializable
  // goes, exactly as for emit().
  async emitExtraction(jobId: string, data: unknown): Promise<void> {
    await this.emit(jobId, 'extraction', data);
  }

  async emitComplete(jobId: string, result: Record<string, unknown>): Promise<void> {
    await this.emit(jobId, 'complete', result);
  }

  async emitError(jobId: string, error: string): Promise<void> {
    await this.emit(jobId, 'error', { error });
  }
}
