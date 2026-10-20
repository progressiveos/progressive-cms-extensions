// XMLStock research search adapter (ADR-0015 §3). Wire contract verified live
// in IncusHub 2026-09-18 and against the operator endpoint 2026-09-26:
// GET {base}/{engine}/xml/ with query params user/key/query/page; XML
// response <response>[<error code=N>…]
// <results><grouping>?<group><doc><url|domain|title|headline|passages|modtime>.
// Yandex pages are 1-based (~100 docs/page), google 0-based (~8 docs/page).
// The API key rides query params by provider contract, so request URLs are
// NEVER logged and errors carry status/in-document codes only, never the URL.
import { XMLParser } from "fast-xml-parser";
import psl from "psl";
import { ResearchError } from "./errors.js";

// Live endpoint shape per the operator-supplied credential URLs (verified
// 2026-09-26, PCMS-WEB-RESEARCH): https://xmlstock.com/<engine>/xml/
const XMLSTOCK_BASE = "https://xmlstock.com";
const MAX_PAGES = 5;
const PAGE_DELAY_MS = 300;
const TITLE_MAX = 512;
const SNIPPET_MAX = 1024;

export type ResearchEngine = "yandex" | "google";

export interface XmlStockSettings {
  readonly userId: string;
  readonly apiKey: string;
  readonly engine: ResearchEngine;
  readonly limit: number;
  readonly region: string;
  readonly language: string;
  readonly device: "desktop" | "mobile";
  readonly timeoutMs: number;
}

export interface ResearchSearchInput {
  readonly query: string;
  readonly engine?: ResearchEngine;
  readonly limit?: number;
  readonly region?: string;
  readonly language?: string;
  readonly device?: "desktop" | "mobile";
}

export interface NormalizedSearchResult {
  readonly rank: number;
  readonly url: string;
  readonly normalized_url: string;
  readonly domain: string;
  readonly title: string;
  readonly snippet: string;
  readonly published_hint?: string;
}

export type XmlStockFetch = (
  url: string,
  init?: {
    readonly signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** Deep-collects text from a fast-xml-parser node, flattening hlword/CDATA
 * wrappers; element boundaries become spaces (word separation is preserved,
 * Yandex wraps query hits in <hlword> — a plain chardata read drops them). */
export function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => textOf(item)).join(" ");
  if (value !== null && typeof value === "object") {
    const parts: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith("@_")) continue;
      const text = textOf(child);
      if (text !== "") parts.push(text);
    }
    return parts.join(" ");
  }
  return "";
}

/** Canonical dedup/canonicalization: lowercase scheme+host, default ports
 * dropped, fragment dropped; path/query stay case-sensitive. */
export function normalizeResultUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname === "") return null;
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    ) {
      url.port = "";
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Registrable domain (eTLD+1) via the public suffix list; hostname fallback. */
export function registrableDomain(hostname: string): string {
  try {
    return psl.get(hostname) ?? hostname;
  } catch {
    return hostname;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (entity) => NAMED_ENTITIES[entity] ?? entity);
}

function cleanText(value: unknown, max: number): string {
  return decodeEntities(
    textOf(value)
      // CDATA keeps provider markup literal (<hlword> inside <![CDATA[…]]>);
      // non-CDATA hlword is already flattened by textOf.
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, max);
}

function publishedHint(modtime: unknown): string | undefined {
  const raw = textOf(modtime).trim();
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  return match === null ? undefined : `${match[1]}-${match[2]}-${match[3]}`;
}

interface ParsedDoc {
  readonly url: string;
  readonly domain: string;
  readonly title: string;
  readonly snippet: string;
  readonly modtime: string;
}

function collectDocs(node: unknown, out: ParsedDoc[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectDocs(item, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if ("doc" in record) {
    const doc = (record["doc"] ?? {}) as Record<string, unknown>;
    out.push({
      url: textOf(doc["url"]).trim(),
      domain: cleanText(doc["domain"], 255),
      title: cleanText(doc["title"], TITLE_MAX),
      snippet: cleanText(doc["headline"] ?? doc["passages"], SNIPPET_MAX),
      modtime: textOf(doc["modtime"]).trim(),
    });
  }
  for (const child of Object.values(record)) {
    if (child !== null && typeof child === "object") collectDocs(child, out);
  }
}

const xmlParser = new XMLParser({ ignoreAttributes: false });

/**
 * One logical search: 1..MAX_PAGES provider requests (pagination only while
 * the requested limit exceeds the pages yielded so far). Provider rank is
 * preserved; only exact normalized-URL duplicates are dropped.
 */
export async function xmlstockSearch(
  settings: XmlStockSettings,
  input: ResearchSearchInput,
  doFetch: XmlStockFetch,
): Promise<NormalizedSearchResult[]> {
  const query = input.query.trim();
  if (query.length < 2 || query.length > 400) {
    throw new ResearchError(
      "RESEARCH_SEARCH_QUERY_INVALID",
      "research search: query must be 2..400 characters",
    );
  }
  const engine = input.engine ?? settings.engine;
  const limit = input.limit ?? settings.limit;

  const results: NormalizedSearchResult[] = [];
  const seen = new Set<string>();
  // Yandex XML pages are 1-based, google via xmlstock is 0-based.
  let page = engine === "google" ? 0 : 1;
  for (
    let pagesFetched = 0;
    pagesFetched < MAX_PAGES && results.length < limit;
    pagesFetched += 1
  ) {
    const fresh = await fetchPage(settings, input, engine, page, doFetch);
    let addedThisPage = 0;
    for (const doc of fresh) {
      const normalized = normalizeResultUrl(doc.url);
      if (normalized === null || seen.has(normalized)) continue;
      seen.add(normalized);
      addedThisPage += 1;
      const hint = publishedHint(doc.modtime);
      results.push({
        rank: results.length + 1,
        url: doc.url,
        normalized_url: normalized,
        domain: doc.domain === "" ? registrableDomain(hostnameOf(normalized)) : doc.domain,
        title: doc.title,
        snippet: doc.snippet,
        ...(hint !== undefined ? { published_hint: hint } : {}),
      });
      if (results.length >= limit) break;
    }
    // Exhaustion = empty page or a page that added zero new candidates.
    if (fresh.length === 0 || addedThisPage === 0) break;
    if (results.length < limit) {
      await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
      page += engine === "google" ? 1 : 1;
    }
  }
  return results;
}

function hostnameOf(normalizedUrl: string): string {
  try {
    return new URL(normalizedUrl).hostname;
  } catch {
    return "";
  }
}

async function fetchPage(
  settings: XmlStockSettings,
  input: ResearchSearchInput,
  engine: ResearchEngine,
  page: number,
  doFetch: XmlStockFetch,
): Promise<ParsedDoc[]> {
  if (settings.userId === "" || settings.apiKey === "") {
    throw new ResearchError(
      "RESEARCH_SEARCH_CONFIG_MISSING",
      "research search: xmlstock.user_id and xmlstock.api_key must be configured",
    );
  }
  const params = new URLSearchParams();
  params.set("user", settings.userId);
  params.set("key", settings.apiKey);
  params.set("query", input.query.trim());
  params.set("page", String(page));
  // Best-effort refinement knobs: absent unless configured (the verified
  // provider contract is user/key/query/page — unknown params stay out).
  const region = input.region ?? settings.region;
  const language = input.language ?? settings.language;
  const device = input.device ?? settings.device;
  if (region !== "") params.set("region", region);
  if (language !== "") params.set("lang", language);
  if (device === "mobile") params.set("device", "mobile");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  let response: Awaited<ReturnType<XmlStockFetch>>;
  try {
    response = await doFetch(`${XMLSTOCK_BASE}/${engine}/xml/?${params.toString()}`, {
      signal: controller.signal,
    });
  } catch (cause) {
    if (cause instanceof ResearchError) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    if (cause instanceof Error && cause.name === "AbortError") {
      throw new ResearchError("RESEARCH_SEARCH_TIMEOUT", "research search: provider timed out", {
        cause,
      });
    }
    throw new ResearchError(
      "RESEARCH_SEARCH_NETWORK_FAILED",
      `research search: transport failure (${message})`,
      { cause },
    );
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) {
    throw new ResearchError(
      "RESEARCH_SEARCH_AUTH_FAILED",
      `research search: XMLStock rejected the credentials (HTTP ${String(response.status)})`,
    );
  }
  if (response.status === 429) {
    throw new ResearchError(
      "RESEARCH_SEARCH_RATE_LIMITED",
      "research search: XMLStock rate limit exceeded",
    );
  }
  if (!response.ok) {
    throw new ResearchError(
      "RESEARCH_SEARCH_PROVIDER_ERROR",
      `research search: XMLStock returned HTTP ${String(response.status)}`,
    );
  }
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(body);
  } catch (cause) {
    throw new ResearchError(
      "RESEARCH_SEARCH_RESPONSE_INVALID",
      "research search: provider response is not parseable XML",
      { cause },
    );
  }
  // In-document provider errors (<error code="N">text</error>): quota/balance
  // classification is a documented heuristic on the provider text.
  const errorNode = findErrorNode(parsed);
  if (errorNode !== null) {
    const text = cleanText(errorNode.text, 200);
    const code = errorNode.code;
    if (/balance|quota|limit money|exceeded/i.test(text)) {
      throw new ResearchError(
        "RESEARCH_SEARCH_BALANCE_OR_QUOTA",
        `research search: XMLStock account limit (code ${code}): ${text}`,
      );
    }
    throw new ResearchError(
      "RESEARCH_SEARCH_PROVIDER_ERROR",
      `research search: XMLStock error (code ${code}): ${text}`,
    );
  }
  const docs: ParsedDoc[] = [];
  collectDocs((parsed as Record<string, unknown>)?.["response"] ?? parsed, docs);
  return docs;
}

function findErrorNode(parsed: unknown): { code: string; text: string } | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const response = record["response"] ?? record;
  if (response === null || typeof response !== "object") return null;
  const error = (response as Record<string, unknown>)["error"];
  if (error === undefined || error === null) return null;
  const node = (Array.isArray(error) ? error[0] : error) as Record<string, unknown>;
  return {
    code: String((node as { "@_code"?: unknown })["@_code"] ?? "?"),
    text: textOf(node),
  };
}
