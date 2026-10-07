import { Redis } from 'ioredis';
import { pruneForLlm } from './html-cleaner.js';
import { CodeGenerator } from './code-generator.js';

// `data` is intentionally a union because listing pages (search results,
// product grids) return an array of items while single-entity pages return
// one object. See buildExtractionPrompt for the rules we give the LLM.
export type ExtractedData =
  | Record<string, unknown>
  | Array<Record<string, unknown>>;

export interface AiExtractionResult {
  data: ExtractedData;
  route: 'cached-script' | 'groq-free' | 'openrouter-free' | 'gemini-flash' | 'gpt-nano';
  llmCost: number;
  tokensUsed?: number;
  modelUsed?: string;
}

interface ModelResponse {
  data: ExtractedData;
  tokensUsed: number;
  cost: number;
  rawOutput: string;
  modelUsed?: string;
}

const GEMINI_INPUT_RATE = 0.075 / 1_000_000;   // $0.075 per 1M tokens
const GEMINI_OUTPUT_RATE = 0.30 / 1_000_000;
const GPT_NANO_INPUT_RATE = 0.10 / 1_000_000;  // $0.10 per 1M tokens
const GPT_NANO_OUTPUT_RATE = 0.40 / 1_000_000;
const CHARS_PER_TOKEN = 4;

// OpenRouter's free auto-router. Cost is zero; the router picks from whichever
// free model currently has capacity and supports response_format=json_object.
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_REFERER = 'https://scrapeforge.io';
const OPENROUTER_APP_TITLE = 'ScrapeForge';

// Groq's OpenAI-compatible endpoint. Free tier is generous (~30 req/min,
// ~6000 req/day as of 2026) and latency is the lowest of any free provider
// thanks to their custom inference silicon. We prefer Groq over OpenRouter
// when both are available because (a) separate quota, (b) much faster p50,
// (c) llama-3.3-70b-versatile reliably honours json_object response_format.
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

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

    // Route 2: Groq (zero cost, fastest free route, separate daily quota)
    //
    // We cascade through multiple Groq models because the free tier has a
    // PER-MODEL token-per-minute cap (roughly 6k TPM on 70B, higher on the
    // smaller models). A huge page (Amazon, Walmart) can exceed 70B's single
    // -request ceiling and return HTTP 413 "Request too large"; in that case
    // we fall over to a model with more headroom before we leave Groq at all.
    //
    //   Primary   : llama-3.3-70b-versatile   — best reasoning, tight TPM
    //   Fallback  : openai/gpt-oss-20b        — 1000 tps, larger per-req budget
    //   Fallback  : llama-3.1-8b-instant      — tiny & fast, biggest TPM
    //
    // On 413 specifically we also retry the same model with a more aggressive
    // HTML prune (20k chars instead of 60k), which typically fits in one call.
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      const cascade = (
        process.env.GROQ_MODELS ||
        process.env.GROQ_MODEL ||
        'llama-3.3-70b-versatile,openai/gpt-oss-20b,llama-3.1-8b-instant'
      )
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      let shrunkPrompt: string | null = null;

      for (const model of cascade) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const tryPrompt = attempt === 0 ? prompt : (shrunkPrompt ??= buildExtractionPrompt(
            pruneForLlm(rawHtml, 20_000),
            schema,
          ));
          try {
            const resp = await callGroq(tryPrompt, groqKey, model);
            await this.codeGen.generateAndStore(domain, schema, prunedHtml, resp.rawOutput);
            return {
              data: resp.data,
              route: 'groq-free',
              llmCost: resp.cost,
              tokensUsed: resp.tokensUsed,
              modelUsed: resp.modelUsed,
            };
          } catch (err) {
            const msg = (err as Error).message;
            const tooLarge = /Groq API 413|Request too large/i.test(msg);
            console.warn(
              `[AI] Groq model=${model} attempt=${attempt} failed: ${msg.slice(0, 160)}`,
            );
            // Retry the same model once with a shrunken prompt only on 413.
            // Every other error — 429 rate-limit, 5xx, parse fail — skips to
            // the next model in the cascade where we have a fresh TPM budget.
            if (!tooLarge) break;
          }
        }
      }
    }

    // Route 3: OpenRouter (zero cost via free models, secondary)
    //
    // Tries the configured model first, then falls back to the free auto-router
    // if the primary returns empty content (e.g. token-limit truncation on
    // small models). Only escalates to paid providers after both attempts fail.
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (openrouterKey) {
      const primaryModel = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';
      const attempts: string[] = [primaryModel];
      if (primaryModel !== 'openrouter/free') attempts.push('openrouter/free');

      for (const model of attempts) {
        try {
          const resp = await callOpenRouter(prompt, openrouterKey, model);
          await this.codeGen.generateAndStore(domain, schema, prunedHtml, resp.rawOutput);
          return {
            data: resp.data,
            route: 'openrouter-free',
            llmCost: resp.cost,
            tokensUsed: resp.tokensUsed,
            modelUsed: resp.modelUsed,
          };
        } catch (err) {
          console.warn(
            `[AI] OpenRouter model=${model} failed: ${(err as Error).message.slice(0, 160)}`,
          );
        }
      }
    }

    // Route 4: Gemini 2.0 Flash-Lite (cheap paid fallback)
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const resp = await callGemini(prompt, geminiKey);
        await this.codeGen.generateAndStore(domain, schema, prunedHtml, resp.rawOutput);
        return {
          data: resp.data,
          route: 'gemini-flash',
          llmCost: resp.cost,
          tokensUsed: resp.tokensUsed,
          modelUsed: 'gemini-2.0-flash-lite',
        };
      } catch (err) {
        console.warn('[AI] Gemini failed, falling back to GPT:', (err as Error).message);
      }
    }

    // Route 5: GPT-4.1 nano (last-resort paid fallback)
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      const resp = await callGptNano(prompt, openaiKey);
      await this.codeGen.generateAndStore(domain, schema, prunedHtml, resp.rawOutput);
      return {
        data: resp.data,
        route: 'gpt-nano',
        llmCost: resp.cost,
        tokensUsed: resp.tokensUsed,
        modelUsed: 'gpt-4.1-nano',
      };
    }

    throw new Error(
      'No AI API key configured. Set GROQ_API_KEY or OPENROUTER_API_KEY ' +
        '(both free), or GEMINI_API_KEY / OPENAI_API_KEY as paid fallbacks.',
    );
  }
}

function buildExtractionPrompt(html: string, schema: Record<string, unknown>): string {
  // The LLM must decide shape based on the page:
  //   • PDP / article / single-entity page → one object matching the schema
  //   • Search results / listings / feed   → array of objects matching the schema
  //
  // Without this guidance the model defaults to "single object" even on
  // pages that obviously list dozens of items (e.g. Amazon search results),
  // which is exactly the bug report from 2026-04-18. We explicitly allow
  // either shape in the output and let the model pick.
  //
  // If the caller wants to FORCE an array they can wrap their schema, e.g.
  //   { "items": { "type": "array", "items": { ...productSchema } } }
  // and the model will respect it verbatim.
  return `You are a structured-data extractor. Extract data from the HTML below that matches the JSON schema.

OUTPUT SHAPE RULES (important):
- If the page clearly contains MULTIPLE distinct items that each match the schema
  (e.g. a search results page, product grid, listing, feed, table of rows),
  return a JSON ARRAY: [ { ...item1 }, { ...item2 }, ... ].
- If the page is a SINGLE-ITEM page (product detail, article, profile, one row),
  return a JSON OBJECT matching the schema.
- If the schema explicitly defines an array at the top level, always return an array.

OTHER RULES:
- Return ONLY valid JSON. No explanations, no markdown fences, no prose.
- Use null for fields that genuinely don't appear on the page; don't invent data.
- For numeric fields, strip currency symbols and thousands separators ("$1,299.00" → 1299).
- Prefer the MAIN content of the page; ignore nav, footer, "related products", and ads.

--- SCHEMA ---
${JSON.stringify(schema, null, 2)}

--- HTML ---
${html}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function parseJsonSafe(text: string): ExtractedData {
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // Output may be either an object ({...}) OR an array ([...]) depending
  // on page type (see buildExtractionPrompt). Pick whichever delimiter pair
  // encloses more content to handle LLM prose on either side.
  const firstObj = cleaned.indexOf('{');
  const lastObj = cleaned.lastIndexOf('}');
  const firstArr = cleaned.indexOf('[');
  const lastArr = cleaned.lastIndexOf(']');

  const arrSpan = firstArr !== -1 && lastArr > firstArr ? lastArr - firstArr : -1;
  const objSpan = firstObj !== -1 && lastObj > firstObj ? lastObj - firstObj : -1;

  // Use the OUTER shape: whichever delimiter appears first. If '[' appears
  // before '{' the whole payload is an array. Falling back to object span
  // if array delimiters aren't present at all.
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj) && arrSpan > 0) {
    cleaned = cleaned.slice(firstArr, lastArr + 1);
  } else if (objSpan > 0) {
    cleaned = cleaned.slice(firstObj, lastObj + 1);
  }

  return JSON.parse(cleaned);
}

// ── Groq (OpenAI-compatible, fastest free route) ────────
//
// Default model: llama-3.3-70b-versatile — 128k context, reliable JSON mode,
// Groq's flagship reasoning model on hardware. Swap via GROQ_MODEL env var
// (e.g. `llama-3.1-8b-instant` for even lower latency on simple schemas,
// or `openai/gpt-oss-120b` for tougher pages if available on your account).

async function callGroq(
  prompt: string,
  apiKey: string,
  model: string,
): Promise<ModelResponse> {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You extract structured data from HTML. Return ONLY valid JSON matching the schema provided. No explanations, no markdown fences.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq API ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as any;
  const choice = json.choices?.[0];
  const rawOutput = choice?.message?.content || '';
  const finishReason = choice?.finish_reason;

  if (!rawOutput) {
    throw new Error(
      `Groq empty content (model=${json.model ?? model}, finish=${finishReason}).`,
    );
  }
  if (finishReason === 'length') {
    throw new Error(
      `Groq truncated (model=${json.model ?? model}, finish=length). ` +
        `Partial output (${rawOutput.length} chars) — raise max_tokens or switch model.`,
    );
  }

  const usage = json.usage || {};
  const inputTokens = usage.prompt_tokens || estimateTokens(prompt);
  const outputTokens = usage.completion_tokens || estimateTokens(rawOutput);

  return {
    data: parseJsonSafe(rawOutput),
    tokensUsed: inputTokens + outputTokens,
    cost: 0, // Free tier; Groq doesn't bill via API headers for free keys.
    rawOutput,
    modelUsed: json.model || model,
  };
}

// ── OpenRouter free auto-router ─────────────────────────
//
// Uses the `openrouter/free` slug which routes each call to whichever free
// model currently has capacity AND supports response_format=json_object.
// This is resilient: if DeepSeek is down, the router silently tries Llama,
// Qwen, etc. We ask for json_object mode to keep parse success high.
//
// Can be overridden with OPENROUTER_MODEL env var (e.g. to pin a specific
// free model like `meta-llama/llama-3.3-70b-instruct:free`).

async function callOpenRouter(
  prompt: string,
  apiKey: string,
  modelOverride?: string,
): Promise<ModelResponse> {
  const model =
    modelOverride || process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      // OpenRouter uses these for ranking/attribution (optional but recommended).
      'HTTP-Referer': OPENROUTER_REFERER,
      'X-Title': OPENROUTER_APP_TITLE,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You extract structured data from HTML. Return ONLY valid JSON matching the schema provided. No explanations, no markdown fences.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter API ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as any;
  const choice = json.choices?.[0];
  const rawOutput = choice?.message?.content || '';
  const finishReason = choice?.finish_reason;

  if (!rawOutput) {
    throw new Error(
      `OpenRouter empty content (model=${json.model ?? model}, finish=${finishReason}). ` +
        `Response: ${JSON.stringify(json).slice(0, 250)}`,
    );
  }
  // Truncated-by-length responses are usually invalid JSON — bail early so the
  // caller can retry with a larger model instead of us crashing in parseJsonSafe.
  if (finishReason === 'length') {
    throw new Error(
      `OpenRouter truncated (model=${json.model ?? model}, finish=length). ` +
        `Partial output (${rawOutput.length} chars) — retry with a bigger model.`,
    );
  }

  const usage = json.usage || {};
  const inputTokens = usage.prompt_tokens || estimateTokens(prompt);
  const outputTokens = usage.completion_tokens || estimateTokens(rawOutput);

  return {
    data: parseJsonSafe(rawOutput),
    tokensUsed: inputTokens + outputTokens,
    // Free router returns cost: 0. If user pins a paid model, OpenRouter
    // reports cost in `usage.cost` (USD). Fall back to 0 if missing.
    cost: Number(usage.cost ?? 0),
    rawOutput,
    modelUsed: json.model || model,
  };
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
