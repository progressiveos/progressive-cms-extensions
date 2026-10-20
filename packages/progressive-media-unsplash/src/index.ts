// Unsplash stock provider (ADR-0013, Media spec §71; PCMS-MPA-T012).
//
// Server-side adapter: search maps to GET /search/photos with the stored
// Access Key; fetch downloads through the provider-mandated download
// tracking endpoint (images.unsplash.com allowlist). All provider-specific
// knowledge (hosts, auth header shape, payload mapping) stays inside this
// module — the CMS core only sees the MediaStockProvider contract.
import type { ExtensionFetchClient } from "@pcms/extensions";
import type {
  MediaStockProvider,
  ProviderContext,
  ProviderFactoryInput,
  StockCandidate,
  StockSearchRequest,
  StockSearchResult,
} from "@pcms/media";
import { createExtensionFetchClientFromConfig } from "@pcms/extensions";
import { providerErrorFromStatus, providerErrorFromTransport, ProviderError } from "@pcms/media";

const API_BASE = "https://api.unsplash.com";
const DOWNLOAD_HOST_SUFFIXES = ["images.unsplash.com", "unsplash.com"];
const REQUEST_TIMEOUT_MS = 30_000;

/** Only the configured provider API hosts are reachable — no arbitrary egress. */
function assertAllowedHost(url: string): void {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new ProviderError("PROVIDER_INVALID_REQUEST", "unsplash: invalid URL");
  }
  if (!DOWNLOAD_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    throw new ProviderError("PROVIDER_INVALID_REQUEST", "unsplash: unexpected download host");
  }
}

async function apiJson<T>(
  path: string,
  accessKey: string,
  outboundFetch: ExtensionFetchClient,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await outboundFetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Client-ID ${accessKey}`, "Accept-Version": "v1" },
      signal: controller.signal,
    });
  } catch (cause) {
    throw providerErrorFromTransport(cause, "unsplash");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw providerErrorFromStatus(response.status, "unsplash");
  return (await response.json()) as T;
}

interface UnsplashSearchItem {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly alt_description: string | null;
  readonly urls: { readonly small: string; readonly regular: string };
  readonly user: { readonly name: string; readonly links: { readonly html: string } };
  readonly links: { readonly html: string };
}

interface UnsplashSearchResponse {
  readonly results: readonly UnsplashSearchItem[];
  readonly total_pages: number;
}

interface UnsplashDownloadResponse {
  readonly url: string;
}

async function download(path: string, accessKey: string, outboundFetch: ExtensionFetchClient) {
  const tracked = await apiJson<UnsplashDownloadResponse>(path, accessKey, outboundFetch);
  assertAllowedHost(tracked.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await outboundFetch(tracked.url, { signal: controller.signal, redirect: "follow" });
  } catch (cause) {
    throw providerErrorFromTransport(cause, "unsplash");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw providerErrorFromStatus(response.status, "unsplash");
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    mimeType: response.headers.get("content-type"),
    filename: new URL(tracked.url).pathname.split("/").pop() ?? "unsplash.jpg",
  };
}

export function createStockProvider(input: ProviderFactoryInput): MediaStockProvider {
  const accessKey = input.config["access_key"];
  if (typeof accessKey !== "string" || accessKey.length === 0) {
    throw new ProviderError("PROVIDER_NOT_CONFIGURED", "unsplash: access key is not configured");
  }
  const outboundFetch = createExtensionFetchClientFromConfig(input.config);
  const provider: MediaStockProvider = {
    providerId: "unsplash",
    displayName: "Unsplash",
    capabilities: () => ({ providerId: "unsplash", displayName: "Unsplash" }),
    async search(_ctx: ProviderContext, request: StockSearchRequest): Promise<StockSearchResult> {
      const perPage = Math.min(Math.max(request.limit, 1), 30);
      const params = new URLSearchParams({ query: request.query, per_page: String(perPage) });
      if (request.orientation !== null && request.orientation !== undefined) {
        params.set("orientation", request.orientation);
      }
      if (request.cursor) params.set("page", request.cursor);
      const data = await apiJson<UnsplashSearchResponse>(
        `/search/photos?${params.toString()}`,
        accessKey,
        outboundFetch,
      );
      const candidates: StockCandidate[] = data.results.map((item) => ({
        providerId: "unsplash",
        providerAssetId: item.id,
        previewUrl: item.urls.small,
        // Kept server-side inside the signed token; never serialized to a client.
        downloadUrl: item.urls.regular,
        width: item.width,
        height: item.height,
        creatorName: item.user.name,
        creatorUrl: item.user.links.html,
        sourceUrl: item.links.html,
        licenseName: "Unsplash License",
        licenseUrl: "https://unsplash.com/license",
      }));
      const page = Number.parseInt(params.get("page") ?? "1", 10);
      const nextPage = Number.isFinite(page) ? page + 1 : 2;
      return {
        candidates,
        nextCursor: page < data.total_pages ? String(nextPage) : null,
      };
    },
    async fetch(_ctx, candidate: StockCandidate) {
      return download(
        `/photos/${encodeURIComponent(candidate.providerAssetId)}/download`,
        accessKey,
        outboundFetch,
      );
    },
    async testConnection(_ctx) {
      // Free authenticated endpoint: proves the key works without side effects.
      await apiJson<unknown>("/photos?per_page=1", accessKey, outboundFetch);
      return { ok: true, message: null };
    },
  };
  return provider;
}
