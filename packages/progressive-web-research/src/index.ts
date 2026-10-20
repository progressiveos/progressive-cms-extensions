// Progressive Web Research extension (PCMS-WEB-RESEARCH, ADR-0015): two
// INDEPENDENT typed operations behind one package — `search` (XMLStock SERP
// discovery) and `fetchPage` (SSRF-safe public-Web retrieval → normalized
// Markdown). The model owns every research decision: no auto-fetch, no
// ranking, no rewriting. External content is untrusted data, by contract.
import { createHash } from "node:crypto";
import {
  createExtensionFetchClient,
  type ExtensionOutboundPolicy,
  parseOutboundPolicy,
} from "@pcms/extensions";
import { ResearchError } from "./errors.js";
import {
  type ExtractionResult,
  extractHtml,
  extractTextPassthrough,
  looksLikeJsShell,
} from "./extract.js";
import { extractPdfText, renderPdfPages } from "./pdf.js";
import { browserRender } from "./render.js";
import { decodeBody, safeFetch, userAgent } from "./safe-fetch.js";
import { isBlockedHostname, isBlockedIpString, parsePublicHttpUrl } from "./url-policy.js";
import { type VisionImage, visionReady, visionTranscribe } from "./vision.js";
import {
  type NormalizedSearchResult,
  type ResearchEngine,
  type XmlStockFetch,
  xmlstockSearch,
} from "./xmlstock.js";

export interface ResearchOperationCall {
  readonly input: {
    readonly [key: string]: unknown;
  };
  readonly actor: { readonly id: string; readonly type: string };
  readonly requestId: string;
  readonly extension: {
    readonly id: string;
    readonly config: Record<string, unknown> | null;
  };
}

export interface ResearchSettings {
  readonly userId: string;
  readonly apiKey: string;
  readonly engine: ResearchEngine;
  readonly limit: number;
  readonly region: string;
  readonly language: string;
  readonly device: "desktop" | "mobile";
  readonly searchTimeoutMs: number;
  readonly redirectLimit: number;
  readonly maxResponseBytes: number;
  readonly maxDecompressedBytes: number;
  readonly maxExtractedChars: number;
  readonly totalTimeoutMs: number;
  readonly allowedPorts: number[];
  readonly browserEnabled: boolean;
  readonly vision: {
    readonly enabled: boolean;
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKey: string;
    readonly timeoutMs: number;
    readonly maxPages: number;
  };
  readonly policy: ExtensionOutboundPolicy;
}

const str = (config: Record<string, unknown>, key: string): string =>
  typeof config[key] === "string" ? (config[key] as string) : "";
const num = (config: Record<string, unknown>, key: string): number | undefined =>
  typeof config[key] === "number" ? (config[key] as number) : undefined;
const bool = (config: Record<string, unknown>, key: string, fallback: boolean): boolean =>
  typeof config[key] === "boolean" ? (config[key] as boolean) : fallback;

export function readSettings(config: Record<string, unknown>): ResearchSettings {
  const ports = Array.isArray(config["fetch.allowed_ports"])
    ? (config["fetch.allowed_ports"] as unknown[]).filter(
        (value): value is number => typeof value === "number",
      )
    : [];
  const engine = str(config, "search.engine");
  const device = str(config, "search.device");
  return {
    userId: str(config, "xmlstock.user_id"),
    apiKey: str(config, "xmlstock.api_key"),
    engine: engine === "google" ? "google" : "yandex",
    limit: num(config, "search.default_limit") ?? 20,
    region: str(config, "search.region"),
    language: str(config, "search.language"),
    device: device === "mobile" ? "mobile" : "desktop",
    searchTimeoutMs: num(config, "search.timeout_ms") ?? 15_000,
    redirectLimit: num(config, "fetch.redirect_limit") ?? 5,
    maxResponseBytes: num(config, "fetch.max_response_bytes") ?? 8 * 1024 * 1024,
    maxDecompressedBytes: num(config, "fetch.max_decompressed_bytes") ?? 16 * 1024 * 1024,
    maxExtractedChars: num(config, "fetch.max_extracted_chars") ?? 60_000,
    totalTimeoutMs: num(config, "fetch.total_timeout_ms") ?? 30_000,
    allowedPorts: ports.length > 0 ? ports : [80, 443],
    browserEnabled: bool(config, "fetch.browser.enabled", true),
    vision: {
      enabled: bool(config, "vision.enabled", true),
      baseUrl: str(config, "vision.base_url"),
      model: str(config, "vision.model"),
      apiKey: str(config, "vision.api_key"),
      timeoutMs: num(config, "vision.timeout_ms") ?? 90_000,
      maxPages: num(config, "vision.max_pages") ?? 8,
    },
    policy: parseOutboundPolicy(config),
  };
}

export interface SearchOperationOutput {
  readonly provider: "xmlstock";
  readonly engine: ResearchEngine;
  readonly query: string;
  readonly count: number;
  readonly trust: "untrusted_external";
  readonly results: readonly NormalizedSearchResult[];
}

/** Operation handler `search` — XMLStock SERP discovery. */
export async function search(call: ResearchOperationCall): Promise<SearchOperationOutput> {
  if (call.extension.config === null) {
    throw new ResearchError(
      "RESEARCH_SEARCH_CONFIG_MISSING",
      "research search: the extension is enabled but not configured (xmlstock.user_id and xmlstock.api_key are required)",
    );
  }
  const settings = readSettings(call.extension.config);
  if (settings.userId === "" || settings.apiKey === "") {
    throw new ResearchError(
      "RESEARCH_SEARCH_CONFIG_MISSING",
      "research search: xmlstock.user_id and xmlstock.api_key must be configured (Admin → Extensions → Progressive Web Research)",
    );
  }
  const input = call.input as {
    query?: unknown;
    engine?: unknown;
    limit?: unknown;
    region?: unknown;
    language?: unknown;
    device?: unknown;
  };
  if (typeof input.query !== "string") {
    throw new ResearchError(
      "RESEARCH_SEARCH_QUERY_INVALID",
      "research search: query (string) is required",
    );
  }
  // The outbound client honors the extension network policy (direct / socks5 /
  // direct_then_socks5). Adapter request URLs carry the API key by provider
  // contract — they are never logged and never appear in error messages.
  const outboundFetch = createExtensionFetchClient(settings.policy);
  const doFetch: XmlStockFetch = (url, init) =>
    outboundFetch(url, {
      signal: init?.signal ?? null,
      headers: { "user-agent": userAgent() },
    }) as unknown as ReturnType<XmlStockFetch>;
  const results = await xmlstockSearch(
    { ...settings, timeoutMs: settings.searchTimeoutMs },
    {
      query: input.query,
      ...(input.engine === "yandex" || input.engine === "google" ? { engine: input.engine } : {}),
      ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
      ...(typeof input.region === "string" ? { region: input.region } : {}),
      ...(typeof input.language === "string" ? { language: input.language } : {}),
      ...(input.device === "desktop" || input.device === "mobile" ? { device: input.device } : {}),
    },
    doFetch,
  );
  return {
    provider: "xmlstock",
    engine: settings.engine,
    query: input.query.trim(),
    count: results.length,
    trust: "untrusted_external",
    results,
  };
}

export interface FetchOperationInput {
  readonly url: string;
  readonly mode: "auto" | "http_only";
  readonly maxChars?: number;
  readonly includeLinks: boolean;
}

export interface FetchOperationOutput {
  readonly request_url: string;
  readonly final_url: string;
  readonly status: number;
  readonly content_type: string;
  readonly fetched_at: string;
  readonly network_path: "direct" | "socks5" | "direct_then_socks5";
  readonly method:
    | "http_readability"
    | "http_text"
    | "browser_render"
    | "http_pdf"
    | "vision_fallback";
  readonly title?: string;
  readonly description?: string;
  readonly canonical_url?: string;
  readonly language?: string;
  readonly author_hint?: string;
  readonly published_at_hint?: string;
  readonly markdown: string;
  readonly word_count: number;
  readonly char_count: number;
  readonly truncated: boolean;
  readonly content_sha256: string;
  readonly headings: readonly string[];
  readonly links?: readonly { url: string; text: string }[];
  readonly page_count?: number;
  readonly vision_used?: boolean;
  readonly extraction_quality: "good" | "thin" | "fallback";
  readonly trust: "untrusted_external";
}

/** Operation handler `fetchPage` — one public URL per call, by design. */
export async function fetchPage(call: ResearchOperationCall): Promise<FetchOperationOutput> {
  if (call.extension.config === null) {
    throw new ResearchError(
      "RESEARCH_CONFIG_MISSING",
      "research fetch: the extension is enabled but not configured — at minimum review the fetch/network settings",
    );
  }
  const settings = readSettings(call.extension.config);
  const input = call.input as Record<string, unknown>;
  const requestUrl = input["url"];
  if (typeof requestUrl !== "string") {
    throw new ResearchError(
      "RESEARCH_FETCH_URL_SCHEME",
      "research fetch: url (string) is required",
    );
  }
  const mode = input["mode"] === "http_only" ? "http_only" : "auto";
  const maxChars =
    typeof input["max_chars"] === "number"
      ? Math.min(Math.max(input["max_chars"] as number, 500), 200_000)
      : settings.maxExtractedChars;
  const includeLinks = input["include_links"] === true;

  // Static admission up front (scheme/credentials/port/host) — the fetcher
  // re-validates every redirect hop and every DNS result.
  parsePublicHttpUrl(requestUrl, settings.allowedPorts);
  const fetched = await safeFetch(
    requestUrl,
    {
      redirectLimit: settings.redirectLimit,
      maxResponseBytes: settings.maxResponseBytes,
      maxDecompressedBytes: settings.maxDecompressedBytes,
      totalTimeoutMs: settings.totalTimeoutMs,
      allowedPorts: settings.allowedPorts,
    },
    settings.policy,
  );
  const baseType = (fetched.contentType.split(";")[0] ?? fetched.contentType).trim();
  const options = {
    baseUrl: fetched.finalUrl,
    maxChars,
    includeLinks,
  };

  const proxy = settings.policy.mode !== "direct" ? settings.policy.proxy : undefined;
  const socksProxy =
    proxy !== undefined
      ? {
          host: proxy.host,
          port: proxy.port,
          ...(proxy.username !== undefined ? { username: proxy.username } : {}),
          ...(proxy.password !== undefined ? { password: proxy.password } : {}),
        }
      : undefined;

  // PDFs take the document pipeline: native text layer first (pdf.js, scripts
  // never executed); a scanned document (IncusHub gate: <200 chars/page) goes
  // to rendered page images + the vision transcriber when configured.
  if (baseType === "application/pdf") {
    const pdf = await extractPdfText(fetched.bytes);
    let markdown = pdf.markdown.slice(0, maxChars);
    let truncated = pdf.markdown.length > maxChars;
    let quality: "good" | "thin" | "fallback" = pdf.textSufficient
      ? pdf.markdown.length >= 500
        ? "good"
        : "thin"
      : "fallback";
    let visionUsed = false;
    if (!pdf.textSufficient) {
      if (!visionReady(settings.vision)) {
        throw new ResearchError(
          "RESEARCH_FETCH_VISION_NOT_CONFIGURED",
          `research fetch: the PDF has ${String(pdf.pageCount)} pages but no usable text layer (scanned document) — configure vision.base_url/model/api_key to enable OCR-grade vision transcription`,
        );
      }
      const pages = await renderPdfPages(fetched.bytes, { maxPages: settings.vision.maxPages });
      const visionMarkdown = await visionTranscribe(
        pages as readonly VisionImage[],
        { url: fetched.finalUrl, kind: `scanned PDF document (${String(pdf.pageCount)} pages)` },
        settings.vision,
        visionFetch(settings),
      );
      markdown = visionMarkdown.slice(0, maxChars);
      truncated = visionMarkdown.length > maxChars;
      quality = markdown.length >= 500 ? "good" : "thin";
      visionUsed = true;
    }
    return {
      request_url: requestUrl,
      final_url: fetched.finalUrl,
      status: fetched.status,
      content_type: fetched.contentType,
      fetched_at: new Date().toISOString(),
      network_path: fetched.networkPath,
      method: visionUsed ? "vision_fallback" : "http_pdf",
      markdown,
      word_count: countWordsOf(markdown),
      char_count: markdown.length,
      truncated,
      content_sha256: createHash("sha256").update(markdown, "utf8").digest("hex"),
      headings: headingsOf(markdown),
      page_count: pdf.pageCount,
      ...(visionUsed ? { vision_used: true } : {}),
      extraction_quality: quality,
      trust: "untrusted_external",
    };
  }

  let extraction: ExtractionResult;
  let method: FetchOperationOutput["method"];
  let visionUsed = false;
  if (baseType === "text/html" || baseType === "application/xhtml+xml") {
    const html = decodeBody(fetched.bytes, fetched.contentType).text;
    extraction = extractHtml(html, options);
    method = "http_readability";
    // Bounded browser fallback: only on deterministic insufficiency, only in
    // auto mode, only when enabled AND a browser exists at the runtime host.
    // When the rendered page STILL yields little text (image-heavy content),
    // the captured screenshot goes to the vision transcriber — the last link
    // of the chain, explicitly labeled in the output.
    const needsVision =
      mode === "auto" &&
      settings.browserEnabled &&
      (looksLikeJsShell(extraction) || extraction.quality !== "good");
    if (needsVision) {
      const rendered = await browserRender({
        url: fetched.finalUrl,
        timeoutMs: settings.totalTimeoutMs,
        captureScreenshot: visionReady(settings.vision),
        ...(socksProxy !== undefined ? { socksProxy } : {}),
      });
      if (rendered.blockedChallenge) {
        throw new ResearchError(
          "RESEARCH_FETCH_BROWSER_BLOCKED_CHALLENGE",
          "research fetch: the page is a bot challenge (CAPTCHA/verification) — bypassing is not supported",
        );
      }
      if (rendered.loginRequired) {
        throw new ResearchError(
          "RESEARCH_FETCH_BROWSER_LOGIN_REQUIRED",
          "research fetch: the page requires a login/subscription — public-Web fetch stops here",
        );
      }
      const renderedHtml = decodeBody(
        Buffer.from(rendered.html, "utf-8"),
        "text/html; charset=utf-8",
      ).text;
      extraction = extractHtml(renderedHtml, { ...options, baseUrl: rendered.finalUrl });
      method = "browser_render";
      if (extraction.quality !== "good" && rendered.screenshot !== undefined) {
        const visionMarkdown = await visionTranscribe(
          [
            {
              mime: rendered.screenshot.mime,
              data: rendered.screenshot.data,
              locator: rendered.finalUrl,
            },
          ],
          { url: rendered.finalUrl, kind: "rendered web page" },
          settings.vision,
          visionFetch(settings),
        );
        visionUsed = true;
        // Vision replaces the BODY, not the page metadata (title/canonical/
        // description from the rendered DOM remain the best available facts).
        const { links: _droppedLinks, ...meta } = extraction;
        extraction = {
          ...meta,
          markdown: visionMarkdown.slice(0, maxChars),
          headings: headingsOf(visionMarkdown),
          wordCount: countWordsOf(visionMarkdown),
          charCount: Math.min(visionMarkdown.length, maxChars),
          truncated: visionMarkdown.length > maxChars,
          quality: visionMarkdown.length >= 500 ? "good" : "thin",
          noscriptHintsJs: false,
        };
        method = "vision_fallback";
      }
    }
  } else if (/^(text\/|application\/json|application\/xml)/.test(baseType)) {
    const decoded = decodeBody(fetched.bytes, fetched.contentType);
    extraction = extractTextPassthrough(decoded.text, options);
    method = "http_text";
  } else {
    throw new ResearchError(
      "RESEARCH_FETCH_CONTENT_UNSUPPORTED_TYPE",
      `research fetch: content type "${baseType}" is not supported`,
    );
  }

  return {
    request_url: requestUrl,
    final_url: fetched.finalUrl,
    status: fetched.status,
    content_type: fetched.contentType,
    fetched_at: new Date().toISOString(),
    network_path: fetched.networkPath,
    method,
    ...(extraction.title !== undefined ? { title: extraction.title } : {}),
    ...(extraction.description !== undefined ? { description: extraction.description } : {}),
    ...(extraction.canonicalUrl !== undefined ? { canonical_url: extraction.canonicalUrl } : {}),
    ...(extraction.language !== undefined ? { language: extraction.language } : {}),
    ...(extraction.authorHint !== undefined ? { author_hint: extraction.authorHint } : {}),
    ...(extraction.publishedAtHint !== undefined
      ? { published_at_hint: extraction.publishedAtHint }
      : {}),
    markdown: extraction.markdown,
    word_count: extraction.wordCount,
    char_count: extraction.charCount,
    truncated: extraction.truncated,
    content_sha256: createHash("sha256").update(extraction.markdown, "utf8").digest("hex"),
    headings: extraction.headings,
    ...(extraction.links !== undefined ? { links: extraction.links } : {}),
    ...(visionUsed ? { vision_used: true } : {}),
    extraction_quality: extraction.quality,
    trust: "untrusted_external",
  };
}

/**
 * Vision endpoint routing (deterministic, decided BEFORE the call — this is
 * not a post-failure fallback): local/LAN endpoints (localhost, private
 * ranges) go DIRECT — an external proxy cannot reach them; cloud endpoints
 * use the SOCKS5 proxy whenever one is configured, because paid AI APIs sit
 * behind geo/CDN layers that 403 direct regional traffic (proven live:
 * OpenRouter answers "Access denied by security policy" directly but works
 * through the configured proxy — same reason prompt-enhancer runs socks5).
 */
function visionFetch(settings: ResearchSettings) {
  const localVision = (() => {
    try {
      const host = new URL(settings.vision.baseUrl).hostname.replace(/^\[|\]$/g, "");
      return isBlockedHostname(host) || isBlockedIpString(host);
    } catch {
      return false;
    }
  })();
  const policy: ExtensionOutboundPolicy =
    localVision || settings.policy.proxy === undefined
      ? { mode: "direct" }
      : { mode: "socks5", proxy: settings.policy.proxy };
  const outboundFetch = createExtensionFetchClient(policy);
  return (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      signal: AbortSignal;
    },
  ) =>
    outboundFetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    }) as unknown as Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}

function countWordsOf(text: string): number {
  const matches = text.match(/[\p{L}\p{N}'’-]+/gu);
  return matches === null ? 0 : matches.length;
}

function headingsOf(markdown: string): string[] {
  return Array.from(markdown.matchAll(/^#{1,6} (.+)$/gm))
    .map((match) => (match[1] ?? "").trim())
    .filter((line) => line !== "")
    .slice(0, 100);
}
