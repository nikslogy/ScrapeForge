import { Redis } from 'ioredis';
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';

const SCRIPT_TTL = 7 * 24 * 3600; // 7 days
const MIN_QUALITY = 0.7;

interface StoredScript {
  code: string;
  createdAt: string;
  execCount: number;
  avgQuality: number;
}

/**
 * Zero-cost-at-scale extraction:
 * 1. First request → LLM extracts data AND generates a Cheerio script.
 * 2. Script is cached in Redis keyed by domain + schema hash.
 * 3. Subsequent requests execute the cached script deterministically.
 * 4. If quality drifts below threshold, the script is regenerated.
 */
export class CodeGenerator {
  constructor(private redis: Redis) {}

  /**
   * Try running a cached deterministic script.
   * Returns extracted data, or null if no script exists / quality too low.
   */
  async tryExecute(
    domain: string,
    schema: Record<string, unknown>,
    html: string,
  ): Promise<Record<string, unknown> | null> {
    const key = this.buildKey(domain, schema);
    const raw = await this.redis.get(key);
    if (!raw) return null;

    const stored: StoredScript = JSON.parse(raw);

    if (stored.avgQuality < MIN_QUALITY && stored.execCount >= 3) {
      await this.redis.del(key);
      return null;
    }

    try {
      const result = this.executeScript(stored.code, html);
      if (!result || Object.keys(result).length === 0) return null;

      const quality = this.scoreResult(result, schema);
      stored.execCount += 1;
      stored.avgQuality =
        (stored.avgQuality * (stored.execCount - 1) + quality) / stored.execCount;
      await this.redis.set(key, JSON.stringify(stored), 'EX', SCRIPT_TTL);

      if (quality < MIN_QUALITY) return null;
      return result;
    } catch {
      await this.redis.del(key);
      return null;
    }
  }

  /**
   * After an LLM extraction succeeds, ask the LLM to generate a
   * reusable Cheerio/CSS selector script and cache it.
   */
  async generateAndStore(
    domain: string,
    schema: Record<string, unknown>,
    prunedHtml: string,
    llmExtractedJson: string,
  ): Promise<void> {
    const code = await this.buildScript(schema, prunedHtml, llmExtractedJson);
    if (!code) return;

    const stored: StoredScript = {
      code,
      createdAt: new Date().toISOString(),
      execCount: 0,
      avgQuality: 1.0,
    };

    const key = this.buildKey(domain, schema);
    await this.redis.set(key, JSON.stringify(stored), 'EX', SCRIPT_TTL);
  }

  // ── Private helpers ───────────────────────────────────

  private buildKey(domain: string, schema: Record<string, unknown>): string {
    const hash = createHash('sha256')
      .update(JSON.stringify(schema))
      .digest('hex')
      .slice(0, 12);
    return `codegen:${domain}:${hash}`;
  }

  private executeScript(code: string, html: string): Record<string, unknown> | null {
    const $ = cheerio.load(html);

    const fn = new Function('$', 'html', `"use strict";\n${code}`);
    const result = fn($, html);

    if (typeof result !== 'object' || result === null) return null;
    return result as Record<string, unknown>;
  }

  private scoreResult(
    result: Record<string, unknown>,
    schema: Record<string, unknown>,
  ): number {
    const schemaKeys = this.extractSchemaKeys(schema);
    if (schemaKeys.length === 0) return 1.0;

    let filled = 0;
    for (const key of schemaKeys) {
      const val = result[key];
      if (val !== null && val !== undefined && val !== '') filled++;
    }
    return filled / schemaKeys.length;
  }

  private extractSchemaKeys(schema: Record<string, unknown>): string[] {
    const props = (schema as any).properties;
    if (props && typeof props === 'object') return Object.keys(props);

    const items = (schema as any).items?.properties;
    if (items && typeof items === 'object') return Object.keys(items);

    return Object.keys(schema);
  }

  /**
   * Generates a deterministic Cheerio extraction script by analysing
   * the HTML structure and the LLM's successful output.
   *
   * If an LLM API is available, it asks the model to write the script.
   * Otherwise, falls back to a heuristic CSS selector builder.
   */
  private async buildScript(
    schema: Record<string, unknown>,
    html: string,
    extractedJson: string,
  ): Promise<string | null> {
    const geminiKey = process.env.GEMINI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    const prompt = `You are a code generator. Given this HTML and the expected JSON output,
write a JavaScript function body that uses Cheerio's $ to extract the same data.

Available: $ (Cheerio loaded with the HTML), html (raw string).
You MUST return a plain object with the extracted values.
Do NOT use require/import. Do NOT wrap in a function declaration.
Return ONLY the JavaScript code — no markdown fences, no explanations.

--- EXPECTED OUTPUT ---
${extractedJson}

--- SCHEMA ---
${JSON.stringify(schema, null, 2)}

--- HTML (first 8000 chars) ---
${html.slice(0, 8000)}`;

    try {
      if (geminiKey) {
        return await this.callLlmForCode(prompt, 'gemini', geminiKey);
      }
      if (openaiKey) {
        return await this.callLlmForCode(prompt, 'openai', openaiKey);
      }
    } catch (err) {
      console.warn('[CodeGen] LLM code generation failed:', (err as Error).message);
    }

    return this.heuristicScript(schema, html, extractedJson);
  }

  private async callLlmForCode(
    prompt: string,
    provider: 'gemini' | 'openai',
    apiKey: string,
  ): Promise<string | null> {
    if (provider === 'gemini') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.0, maxOutputTokens: 2048 },
          }),
        },
      );
      if (!res.ok) return null;
      const json = (await res.json()) as any;
      return cleanCodeBlock(json.candidates?.[0]?.content?.parts?.[0]?.text || '');
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4.1-nano',
        messages: [
          { role: 'system', content: 'You write Cheerio extraction scripts. Return ONLY code.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.0,
        max_tokens: 2048,
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    return cleanCodeBlock(json.choices?.[0]?.message?.content || '');
  }

  /**
   * Fallback: build a simple selector-based script from the schema keys
   * and attempt to locate matching elements by text content.
   */
  private heuristicScript(
    schema: Record<string, unknown>,
    _html: string,
    extractedJson: string,
  ): string | null {
    const keys = this.extractSchemaKeys(schema);
    if (keys.length === 0) return null;

    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(extractedJson); } catch { return null; }

    const lines: string[] = ['const result = {};'];
    for (const key of keys) {
      const val = parsed[key];
      if (typeof val === 'string') {
        const escaped = val.replace(/'/g, "\\'").slice(0, 60);
        lines.push(
          `result[${JSON.stringify(key)}] = $('*:contains("${escaped}")').first().text().trim() || null;`,
        );
      } else {
        lines.push(`result[${JSON.stringify(key)}] = null;`);
      }
    }
    lines.push('return result;');
    return lines.join('\n');
  }
}

function cleanCodeBlock(text: string): string | null {
  let code = text.trim();
  const fenceMatch = code.match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
  if (fenceMatch) code = fenceMatch[1].trim();
  return code || null;
}
