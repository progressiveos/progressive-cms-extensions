// Bounded browser-render fallback (ADR-0015 §7, extended in round 2 with
// screenshot capture for the vision fallback). playwright-core is imported
// dynamically: when the runtime host has no playwright/browser binary the
// operation fails typed (RESEARCH_FETCH_BROWSER_UNAVAILABLE) and HTTP fetch
// stays fully functional — doctor reports degraded, never failure. Per fetch:
// fresh isolated context, no persistence, fonts/media blocked (images are
// ALLOWED when vision capture is requested — the screenshot must show the
// real page), subresource hosts policy-checked at the URL layer.
// Challenge/login walls are typed states, never bypassed.

import { existsSync } from "node:fs";
import type { Browser, BrowserContext } from "playwright-core";
import { ResearchError } from "./errors.js";
import { isBlockedHostname, isBlockedIpString } from "./url-policy.js";

export interface RenderOptions {
  readonly url: string;
  readonly timeoutMs: number;
  readonly socksProxy?: { host: string; port: number; username?: string; password?: string };
  /** Capture a full-page screenshot (vision fallback input). */
  readonly captureScreenshot?: boolean;
  /** Test-only escape for local fixtures; never set from configuration. */
  readonly allowPrivateTargets?: boolean;
}

export interface RenderResult {
  readonly html: string;
  readonly finalUrl: string;
  readonly blockedChallenge: boolean;
  readonly loginRequired: boolean;
  readonly screenshot?: { readonly mime: "image/png"; readonly data: Buffer };
}

const CHALLENGE_MARKERS =
  /just a moment|attention required|checking your browser|cf-browser-verification|captcha|подтвердите, что запросы отправляли вы/i;
const LOGIN_MARKERS =
  /log ?in to (continue|read|view)|sign ?in to (continue|read|view)|войдите, чтобы|subscription required|покупка подписки/i;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

type PlaywrightModule = typeof import("playwright-core");

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  try {
    return (await import("playwright-core")) as PlaywrightModule;
  } catch {
    return null;
  }
}

export async function browserIsAvailable(): Promise<boolean> {
  const playwright = await loadPlaywright();
  if (playwright === null) return false;
  try {
    const executable = playwright.chromium.executablePath();
    return executable !== "" && existsSync(executable);
  } catch {
    return false;
  }
}

export async function browserRender(options: RenderOptions): Promise<RenderResult> {
  const playwright = await loadPlaywright();
  if (playwright === null) {
    throw new ResearchError(
      "RESEARCH_FETCH_BROWSER_UNAVAILABLE",
      "research fetch: browser render fallback requested but playwright-core is not installed at the runtime host (HTTP fetch is unaffected)",
    );
  }
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      // Standard container flags: the service user has no user namespaces and
      // /dev/shm is tiny; the process itself is confined by systemd hardening.
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      ...(options.socksProxy !== undefined
        ? {
            proxy: {
              server: `socks5://${options.socksProxy.host}:${String(options.socksProxy.port)}`,
            },
          }
        : {}),
    });
    context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      strictSelectors: false,
      viewport: { width: 1280, height: 900 },
    });
    await applySubresourcePolicy(
      context,
      options.captureScreenshot === true,
      options.allowPrivateTargets === true,
    );
    const page = await context.newPage();
    await page.goto(options.url, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs,
    });
    const html = await page.content();
    const finalUrl = page.url();
    const textSample = html.replace(/<[^>]+>/g, " ");
    let screenshot: RenderResult["screenshot"];
    if (options.captureScreenshot === true) {
      let data = await page.screenshot({ fullPage: true, type: "png" });
      if (data.byteLength > MAX_SCREENSHOT_BYTES) {
        // Full page too large for the vision cap — fall back to the viewport.
        data = await page.screenshot({ fullPage: false, type: "png" });
      }
      if (data.byteLength <= MAX_SCREENSHOT_BYTES) {
        screenshot = { mime: "image/png", data: Buffer.from(data) };
      }
    }
    return {
      html,
      finalUrl,
      blockedChallenge: CHALLENGE_MARKERS.test(textSample),
      loginRequired: LOGIN_MARKERS.test(textSample) && textSample.length < 20_000,
      ...(screenshot !== undefined ? { screenshot } : {}),
    };
  } catch (cause) {
    if (cause instanceof ResearchError) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ResearchError(
      "RESEARCH_FETCH_BROWSER_FAILED",
      `research fetch: browser render failed (${message.slice(0, 200)})`,
      { cause },
    );
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

/** URL-layer subresource policy: only public http(s), no private/local hosts,
 * media/font classes aborted (images too, unless vision capture needs them).
 * DNS-level checks inside the browser are a documented residual gap
 * (ADR-0015 §7). */
async function applySubresourcePolicy(
  context: BrowserContext,
  allowImages: boolean,
  allowPrivateTargets: boolean,
): Promise<void> {
  await context.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      void route.abort();
      return;
    }
    if (
      !allowPrivateTargets &&
      (isBlockedHostname(url.hostname) || isBlockedIpString(url.hostname))
    ) {
      void route.abort();
      return;
    }
    const type = request.resourceType();
    if (type === "media" || type === "font" || (type === "image" && !allowImages)) {
      void route.abort();
      return;
    }
    void route.continue();
  });
}
