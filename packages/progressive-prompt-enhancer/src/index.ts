// Prompt Enhancer extension (PCMS-PRE-RESEARCH A4): improves image-generation
// prompts through any OpenAI-compatible chat endpoint (OpenRouter, OpenAI,
// Ollama, …). Deliberately a separate text-model adapter — not part of the
// Runware media provider. Reasoning is a first-class knob with per-provider
// wire mappings: `off` maps to a real disable per style (reasoning_effort
// "none" on OpenAI, reasoning{enabled:false} on OpenRouter, reasoning:false
// on Ollama), because no single parameter is universal.
import { createExtensionFetchClientFromConfig } from "@pcms/extensions";
import { providerErrorFromStatus, providerErrorFromTransport, ProviderError } from "@pcms/media";

const REQUEST_TIMEOUT_MS_DEFAULT = 30_000;

const BUILT_IN_SYSTEM_PROMPT = [
  "You rewrite prompts for text-to-image models.",
  'Reply with STRICT JSON only: {"prompt_en": "<improved prompt in English>", "prompt_ru": "<improved prompt in Russian>"}.',
  "Use null for prompt_ru when the original prompt is already in Russian.",
  "Keep the subject and intent; add concrete visual detail (composition, lighting, materials, mood, camera/lens feel) that serves the intent.",
  "Remove contradictions. No markdown fences, no commentary outside the JSON object.",
].join("\n");

/**
 * Robust response parse (plan Ф5/T5.1): Mistral/GLM routes can silently
 * degrade from structured output to plain text, so JSON is extracted from
 * the surrounding text when needed; an unparseable response is treated as
 * plain prompt text rather than an error.
 */
export function parseEnhancerResponse(content: string): {
  prompt: string;
  promptRu: string | null;
} {
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      const parsed = JSON.parse(content.slice(first, last + 1)) as {
        prompt_en?: unknown;
        prompt_ru?: unknown;
      };
      const promptEn = typeof parsed.prompt_en === "string" ? parsed.prompt_en.trim() : "";
      const promptRu =
        typeof parsed.prompt_ru === "string" && parsed.prompt_ru.trim() !== ""
          ? parsed.prompt_ru.trim()
          : null;
      if (promptEn !== "") return { prompt: promptEn, promptRu };
    } catch {
      // fall through to plain-text handling
    }
  }
  return { prompt: content.trim(), promptRu: null };
}

type ReasoningLevel = "provider_default" | "off" | "low" | "medium" | "high";
type ReasoningStyle = "auto" | "openai" | "openrouter" | "ollama" | "none";

interface EnhanceConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly reasoningLevel: ReasoningLevel;
  readonly reasoningStyle: ReasoningStyle;
  readonly temperature: number | null;
  readonly topP: number | null;
  readonly maxOutputTokens: number | null;
  readonly timeoutMs: number;
  readonly system: string | null;
}

/** Provider-agnostic shape check — only fields this adapter sends are read. */
export function readEnhanceConfig(config: Record<string, unknown>): EnhanceConfig {
  const str = (key: string): string =>
    typeof config[key] === "string" ? (config[key] as string) : "";
  const num = (key: string): number | null =>
    typeof config[key] === "number" ? (config[key] as number) : null;
  const level = str("reasoning_level");
  const style = str("reasoning_style");
  const baseUrl = str("base_url").replace(/\/$/, "");
  return {
    baseUrl,
    model: str("model"),
    apiKey: str("api_key"),
    reasoningLevel:
      level === "off" || level === "low" || level === "medium" || level === "high"
        ? level
        : "provider_default",
    reasoningStyle:
      style === "openai" || style === "openrouter" || style === "ollama" || style === "none"
        ? style
        : "auto",
    temperature: num("temperature"),
    topP: num("top_p"),
    maxOutputTokens: num("max_output_tokens"),
    timeoutMs: num("timeout_ms") ?? REQUEST_TIMEOUT_MS_DEFAULT,
    system: str("system") === "" ? null : str("system"),
  };
}

/** Guesses the reasoning wire style from the endpoint when set to auto. */
export function resolveReasoningStyle(config: EnhanceConfig): ReasoningStyle {
  if (config.reasoningStyle !== "auto") return config.reasoningStyle;
  const url = config.baseUrl.toLowerCase();
  if (url.includes("openrouter")) return "openrouter";
  if (url.includes(":11434") || url.includes("ollama")) return "ollama";
  return "openai";
}

/** Applies the reasoning knob to a chat/completions body, per style. */
export function applyReasoning(
  body: Record<string, unknown>,
  level: ReasoningLevel,
  style: ReasoningStyle,
): void {
  if (level === "provider_default" || style === "none") return;
  if (style === "openai") {
    // gpt-5.x accepts "none"; o-series floor is "low" — upstream rejects
    // unknown values with a typed 4xx the UI surfaces verbatim.
    body["reasoning_effort"] = level === "off" ? "none" : level;
    return;
  }
  if (style === "openrouter") {
    body["reasoning"] = level === "off" ? { enabled: false } : { effort: level };
    return;
  }
  // ollama: the OpenAI-compatible /v1 layer accepts reasoning_effort (or a
  // reasoning:{effort} object). The old top-level `reasoning: false|level`
  // shape is the NATIVE /api/chat form and is ignored on /v1 — so "off"
  // never actually disabled thinking there.
  body["reasoning_effort"] = level === "off" ? "none" : level;
}

function userMessage(input: { prompt: string; context?: string; language?: string }): string {
  const parts = [`Prompt to improve:\n${input.prompt}`];
  if (input.context !== undefined && input.context.length > 0) {
    parts.push(`Usage context: ${input.context}`);
  }
  if (input.language !== undefined && input.language.length > 0) {
    parts.push(`Write the improved prompt in: ${input.language}`);
  }
  return parts.join("\n\n");
}

export interface EnhancePromptCall {
  readonly input: {
    readonly prompt: string;
    readonly context?: string;
    readonly language?: string;
  };
  readonly extension: {
    readonly id: string;
    readonly config: Record<string, unknown> | null;
  };
}

/** Operation handler — exported under the manifest name `enhancePrompt`. */
export async function enhancePrompt(
  call: EnhancePromptCall,
): Promise<{ prompt: string; prompt_ru: string | null; model: string }> {
  if (call.extension.config === null) {
    throw new ProviderError(
      "PROVIDER_NOT_CONFIGURED",
      "prompt-enhancer: extension is enabled but not configured (base URL, model and API key are required)",
    );
  }
  const config = readEnhanceConfig(call.extension.config);
  if (config.baseUrl === "" || config.model === "" || config.apiKey === "") {
    throw new ProviderError(
      "PROVIDER_NOT_CONFIGURED",
      "prompt-enhancer: base_url, model and api_key must all be configured",
    );
  }

  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: "system", content: config.system ?? BUILT_IN_SYSTEM_PROMPT },
      { role: "user", content: userMessage(call.input) },
    ],
    max_tokens: config.maxOutputTokens,
  };
  if (config.temperature !== null) body["temperature"] = config.temperature;
  if (config.topP !== null) body["top_p"] = config.topP;
  applyReasoning(body, config.reasoningLevel, resolveReasoningStyle(config));

  const outboundFetch = createExtensionFetchClientFromConfig(call.extension.config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await outboundFetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    throw providerErrorFromTransport(cause, "prompt-enhancer");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw providerErrorFromStatus(response.status, "prompt-enhancer");

  let payload: {
    choices?: readonly { message?: { content?: string | null } }[];
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch (cause) {
    throw new ProviderError("PROVIDER_FAILED", "prompt-enhancer: malformed chat response", {
      cause,
    });
  }
  const content = payload.choices?.[0]?.message?.content ?? "";
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new ProviderError(
      "PROVIDER_FAILED",
      "prompt-enhancer: model returned no text content (reasoning-only response?) — set reasoning_level to off or pick a different model",
    );
  }
  const parsed = parseEnhancerResponse(content);
  return { prompt: parsed.prompt, prompt_ru: parsed.promptRu, model: config.model };
}
