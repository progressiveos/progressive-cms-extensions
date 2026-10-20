// HTML/text extraction → normalized Markdown (ADR-0015 §7, Web Research spec
// §5). Networking is owned by the safe fetcher; this module only parses bytes
// it is handed. JSDOM runs with scripts and resource loading disabled;
// Readability picks the article; DOM-level sanitation strips scripts/forms/
// event handlers/javascript: URLs BEFORE Turndown converts to Markdown.
/// <reference path="./vendor-types.d.ts" />

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export interface ExtractionOptions {
  readonly baseUrl: string;
  readonly maxChars: number;
  readonly includeLinks: boolean;
}

export interface PageMetadata {
  readonly title?: string;
  readonly description?: string;
  readonly canonicalUrl?: string;
  readonly language?: string;
  readonly authorHint?: string;
  readonly publishedAtHint?: string;
}

export interface ExtractionResult extends PageMetadata {
  readonly markdown: string;
  readonly headings: readonly string[];
  readonly links?: readonly { url: string; text: string }[];
  readonly wordCount: number;
  readonly charCount: number;
  readonly truncated: boolean;
  readonly quality: "good" | "thin" | "fallback";
  readonly noscriptHintsJs: boolean;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  hr: "---",
  emDelimiter: "*",
});
turndown.use(gfm);

const UNWRAPPED_TAGS = new Set(["html", "head", "body"]);

function elementToMarkdown(element: Element): string {
  if (UNWRAPPED_TAGS.has(element.tagName.toLowerCase())) {
    return element.innerHTML;
  }
  return element.outerHTML;
}

/** Removes script/style/noscript/iframes/forms and inline event handlers /
 * javascript: URLs from the article DOM before conversion. */
export function sanitizeArticle(root: Element): void {
  for (const node of root.querySelectorAll(
    "script, style, noscript, iframe, frame, object, embed, form, button, input, select, textarea, template, link, meta",
  )) {
    node.remove();
  }
  for (const node of root.querySelectorAll("*")) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        node.removeAttribute(attribute.name);
        continue;
      }
      if (
        (name === "href" || name === "src" || name === "srcset" || name === "action") &&
        /^\s*javascript:/i.test(attribute.value)
      ) {
        node.removeAttribute(attribute.name);
      }
    }
  }
}

function metaFrom(document: Document): PageMetadata {
  const content = (selector: string): string | undefined => {
    const node = document.querySelector(selector);
    const value = node?.getAttribute("content")?.trim();
    return value === undefined || value === "" ? undefined : value.slice(0, 1024);
  };
  const canonical = document.querySelector("link[rel=canonical]")?.getAttribute("href");
  const title = document.title?.trim();
  const lang = document.documentElement.getAttribute("lang");
  const description =
    content("meta[name=description]") ?? content("meta[property='og:description']");
  const author = content("meta[name=author]");
  const published =
    content("meta[property='article:published_time']") ?? content("meta[name='date']");
  return {
    ...(title !== undefined && title !== "" ? { title: title.slice(0, 512) } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(typeof canonical === "string" && canonical !== ""
      ? { canonicalUrl: absoluteUrl(canonical, document.baseURI).slice(0, 2048) }
      : {}),
    ...(lang !== null && lang !== "" ? { language: lang.slice(0, 32) } : {}),
    ...(author !== undefined ? { authorHint: author } : {}),
    ...(published !== undefined ? { publishedAtHint: published } : {}),
  };
}

function absoluteUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** Primary HTML path: Readability article → sanitized → Markdown. */
export function extractHtml(html: string, options: ExtractionOptions): ExtractionResult {
  const dom = new JSDOM(html, {
    url: options.baseUrl,
    // No runScripts, no resource loading — JSDOM is a parser only.
    pretendToBeVisual: false,
  });
  const document = dom.window.document;
  const meta = metaFrom(document);
  const noscriptHintsJs = /javascript|включ.{0,20}script|enable.{0,20}script/i.test(
    Array.from(document.querySelectorAll("noscript"))
      .map((node) => node.textContent ?? "")
      .join(" "),
  );

  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(document.cloneNode(true) as Document).parse();
  } catch {
    article = null;
  }

  let markdown: string;
  let links: { url: string; text: string }[] | undefined;
  let quality: "good" | "thin" | "fallback";
  let title = meta.title;

  if (article !== null && article.content != null && article.content !== "") {
    const contentDom = new JSDOM(article.content, { url: options.baseUrl });
    const contentRoot =
      contentDom.window.document.body ?? contentDom.window.document.documentElement;
    sanitizeArticle(contentRoot);
    // Readability's title pick already scores <title> against the article h1.
    title = article.title?.trim() || title;
    markdown = turndown.turndown(elementToMarkdown(contentRoot));
    const words = countWords(markdown);
    quality = words >= 30 && markdown.length >= 400 ? "good" : "thin";
    if (options.includeLinks) {
      links = collectLinks(contentRoot, options.baseUrl);
    }
  } else {
    // Fallback: no article detected — raw body text, clearly labeled.
    const bodyRoot = document.body ?? document.documentElement;
    sanitizeArticle(bodyRoot);
    markdown = turndown.turndown(elementToMarkdown(bodyRoot));
    quality = "fallback";
    if (options.includeLinks) {
      links = collectLinks(bodyRoot, options.baseUrl);
    }
  }
  const headings = Array.from(markdown.matchAll(/^#{1,6} (.+)$/gm))
    .map((match) => (match[1] ?? "").trim())
    .filter((line) => line !== "")
    .slice(0, 100);

  const truncated = markdown.length > options.maxChars;
  const bounded = truncated ? markdown.slice(0, options.maxChars) : markdown;
  return {
    ...meta,
    ...(title !== undefined && title !== meta.title ? { title } : {}),
    markdown: bounded,
    headings,
    ...(links !== undefined ? { links } : {}),
    wordCount: countWords(bounded),
    charCount: bounded.length,
    truncated,
    quality,
    noscriptHintsJs,
  };
}

/** Non-HTML text passthrough (json/xml/text): normalized text, no fake article extraction. */
export function extractTextPassthrough(text: string, options: ExtractionOptions): ExtractionResult {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  const truncated = trimmed.length > options.maxChars;
  const bounded = truncated ? trimmed.slice(0, options.maxChars) : trimmed;
  const quality: "good" | "thin" = bounded.length >= 200 ? "good" : "thin";
  return {
    markdown: bounded,
    headings: [],
    wordCount: countWords(bounded),
    charCount: bounded.length,
    truncated,
    quality,
    noscriptHintsJs: false,
  };
}

export function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}'’-]+/gu);
  return matches === null ? 0 : matches.length;
}

function collectLinks(root: Element, baseUrl: string): { url: string; text: string }[] {
  const seen = new Set<string>();
  const links: { url: string; text: string }[] = [];
  root.querySelectorAll("a[href]").forEach((node) => {
    if (links.length >= 50) return;
    const raw = node.getAttribute("href");
    if (raw === null || raw === "" || raw.startsWith("#")) return;
    const absolute = absoluteUrl(raw, baseUrl);
    if (!/^https?:\/\//i.test(absolute) || seen.has(absolute)) return;
    seen.add(absolute);
    links.push({
      url: absolute.slice(0, 2048),
      text: (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 255),
    });
  });
  return links;
}

/** Deterministic JS-shell heuristics (spec: render only on real insufficiency).
 * A solid article never renders just because a <noscript> notice exists. */
export function looksLikeJsShell(result: ExtractionResult): boolean {
  if (result.quality === "good") return false;
  if (result.noscriptHintsJs && result.wordCount < 120) return true;
  return result.quality === "fallback" && result.wordCount < 80;
}
