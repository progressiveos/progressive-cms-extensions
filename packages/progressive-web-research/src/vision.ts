// Vision-model fallback (ADR-0015 §7, PCMS-WEB-RESEARCH round 2). Last link
// of the fetch chain: when deterministic extraction is insufficient (scanned
// PDFs, image-heavy pages) the page/document images go to a configured
// vision-capable chat model — cloud (OpenRouter) or local (any
// OpenAI-compatible endpoint), through the SAME extension outbound policy.
// Borrowed from IncusHub contentengine/vision.go: data-URL images, locator +
// uncertainty prompt, 8 MiB image cap. Output is derived evidence — labeled
// untrusted like everything else.
import { ResearchError } from "./errors.js";

export interface VisionSettings {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxPages: number;
}

export interface VisionImage {
  readonly mime: "image/png" | "image/jpeg";
  readonly data: Buffer;
  readonly locator: string;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES_PER_CALL = 8;

const SYSTEM_PROMPT =
  "You transcribe and factually describe the visible content of web pages and document images: " +
  "text, labels, diagrams, tables, charts. Preserve reading order and structure as Markdown " +
  "(headings, lists, tables). Keep locators (URLs, numbers, code) verbatim. " +
  "Your output is derived evidence, not unquestionable truth; mark uncertain readings explicitly.";

/** Local Ollama-style endpoints need no credentials — only cloud ones do. */
export function visionReady(settings: VisionSettings): boolean {
  return settings.enabled && settings.baseUrl !== "" && settings.model !== "";
}

export type VisionFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Transcribes one or more page/document images into Markdown via a
 * vision-capable chat/completions endpoint. */
export async function visionTranscribe(
  images: readonly VisionImage[],
  context: { readonly url: string; readonly kind: string },
  settings: VisionSettings,
  doFetch: VisionFetch,
): Promise<string> {
  if (images.length === 0) {
    throw new ResearchError(
      "RESEARCH_FETCH_VISION_FAILED",
      "research fetch: vision fallback requested with no images to transcribe",
    );
  }
  const bounded = images.slice(0, MAX_IMAGES_PER_CALL);
  for (const image of bounded) {
    if (image.data.length > MAX_IMAGE_BYTES) {
      throw new ResearchError(
        "RESEARCH_FETCH_VISION_FAILED",
        `research fetch: image exceeds the ${String(MAX_IMAGE_BYTES)} byte vision cap`,
      );
    }
  }
  const userContent: Record<string, unknown>[] = [
    {
      type: "text",
      text:
        `Transcribe the visible content of this ${context.kind} as Markdown, preserving ` +
        `headings, lists and tables.\nSOURCE LOCATOR: ${context.url}\n` +
        `Report every uncertain reading explicitly.`,
    },
    ...bounded.map((image) => ({
      type: "image_url",
      image_url: {
        url: `data:${image.mime};base64,${image.data.toString("base64")}`,
      },
    })),
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  let payload: {
    choices?: readonly { message?: { content?: string | null } }[];
  };
  try {
    const response = await doFetch(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(settings.apiKey === "" ? {} : { authorization: `Bearer ${settings.apiKey}` }),
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0,
        max_tokens: 8192,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new ResearchError(
        "RESEARCH_FETCH_VISION_FAILED",
        `research fetch: vision endpoint rejected the credentials (HTTP ${String(response.status)})`,
      );
    }
    if (!response.ok) {
      throw new ResearchError(
        "RESEARCH_FETCH_VISION_FAILED",
        `research fetch: vision endpoint returned HTTP ${String(response.status)}`,
      );
    }
    payload = (await response.json()) as typeof payload;
  } catch (cause) {
    if (cause instanceof ResearchError) throw cause;
    if (cause instanceof Error && cause.name === "AbortError") {
      throw new ResearchError(
        "RESEARCH_FETCH_VISION_FAILED",
        "research fetch: vision request timed out",
        { cause },
      );
    }
    throw new ResearchError(
      "RESEARCH_FETCH_VISION_FAILED",
      `research fetch: vision request failed (${cause instanceof Error ? cause.message : String(cause)})`,
      { cause },
    );
  } finally {
    clearTimeout(timer);
  }
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new ResearchError(
      "RESEARCH_FETCH_VISION_FAILED",
      "research fetch: vision model returned no text content",
    );
  }
  return content.trim();
}
