import { Redis } from 'ioredis';
import { pruneForLlm } from './html-cleaner.js';
import { CodeGenerator } from './code-generator.js';

export interface AiExtractionResult {
  data: Record<string, unknown>;
  route: 'cached-script' | 'gemini-flash' | 'gpt-nano';
  llmCost: number;
  tokensUsed?: number;
}

interface ModelResponse {
  data: Record<string, unknown>;
  tokensUsed: number;
  cost: number;
  rawOutput: string;
}

const GEMINI_INPUT_RATE = 0.075 / 1_000_000;   // $0.075 per 1M tokens
const GEMINI_OUTPUT_RATE = 0.30 / 1_000_000;
const GPT_NANO_INPUT_RATE = 0.10 / 1_000_000;  // $0.10 per 1M tokens
const GPT_NANO_OUTPUT_RATE = 0.40 / 1_000_000;
const CHARS_PER_TOKEN = 4;

export class AiExtractor {
  private codeGen: CodeGenerator;

  constructor(private redis: Redis) {
    this.codeGen = new CodeGenerator(redis);
  }

  async extract(
    rawHtml: string,
    url: string,
    schema: Record<string, unknown>,
  ): Promise<AiExtractionResult> {
    const domain = new URL(url).hostname;

    // Route 1: try deterministic cached script first (zero LLM cost)
    const cached = await this.codeGen.tryExecute(domain, schema, rawHtml);
    if (cached) {
      return { data: cached, route: 'cached-script', llmCost: 0 };
    }

    const prunedHtml = pruneForLlm(rawHtml);
    const prompt = buildExtractionPrompt(prunedHtml, schema);

    // Route 2: Gemini 2.0 Flash-Lite (cheapest LLM)
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const resp = await callGemini(prompt, geminiKey);
        await this.codeGen.generateAndStore(domain, schema, prunedHtml, resp.rawOutput);
        return { data: resp.data, route: 'gemini-flash', llmCost: resp.cost, tokensUsed: resp.tokensUsed };
      } catch (err) {
        console.warn('[AI] Gemini failed, falling back to GPT:', (err as Error).message);
      }
    }

    // Route 3: GPT-4.1 nano
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      const resp = await callGptNano(prompt, openaiKey);
      await this.codeGen.generateAndStore(domain, schema, prunedHtml, resp.rawOutput);
      return { data: resp.data, route: 'gpt-nano', llmCost: resp.cost, tokensUsed: resp.tokensUsed };
    }

    throw new Error('No AI API key configured (set GEMINI_API_KEY or OPENAI_API_KEY)');
  }
}

function buildExtractionPrompt(html: string, schema: Record<string, unknown>): string {
  return `Extract structured data from the HTML below according to the JSON schema.
Return ONLY valid JSON matching the schema — no explanations, no markdown fences.

--- SCHEMA ---
${JSON.stringify(schema, null, 2)}

--- HTML ---
${html}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function parseJsonSafe(text: string): Record<string, unknown> {
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  return JSON.parse(cleaned);
}

// ── Gemini 2.0 Flash-Lite ───────────────────────────────

async function callGemini(prompt: string, apiKey: string): Promise<ModelResponse> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json() as any;
  const rawOutput = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const usage = json.usageMetadata || {};
  const inputTokens = usage.promptTokenCount || estimateTokens(prompt);
  const outputTokens = usage.candidatesTokenCount || estimateTokens(rawOutput);

  return {
    data: parseJsonSafe(rawOutput),
    tokensUsed: inputTokens + outputTokens,
    cost: inputTokens * GEMINI_INPUT_RATE + outputTokens * GEMINI_OUTPUT_RATE,
    rawOutput,
  };
}

// ── GPT-4.1 nano ────────────────────────────────────────

async function callGptNano(prompt: string, apiKey: string): Promise<ModelResponse> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4.1-nano',
      messages: [
        { role: 'system', content: 'You extract structured data from HTML. Return ONLY valid JSON.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json() as any;
  const rawOutput = json.choices?.[0]?.message?.content || '';
  const usage = json.usage || {};
  const inputTokens = usage.prompt_tokens || estimateTokens(prompt);
  const outputTokens = usage.completion_tokens || estimateTokens(rawOutput);

  return {
    data: parseJsonSafe(rawOutput),
    tokensUsed: inputTokens + outputTokens,
    cost: inputTokens * GPT_NANO_INPUT_RATE + outputTokens * GPT_NANO_OUTPUT_RATE,
    rawOutput,
  };
}
