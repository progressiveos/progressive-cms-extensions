// Pexels stock provider (ADR-0013, Media spec §71; PCMS-MPA-T013).
//
// Server-side adapter over GET /v1/search with the API key header.
// Downloads hit images.pexels.com hosts only. Same contract shape as the
// Unsplash adapter — independent package/lifecycle/credentials by design.
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

const API_BASE = "https://api.pexels.com/v1";
const DOWNLOAD_HOST_SUFFIXES = ["images.pexels.com", "pexels.com"];
const REQUEST_TIMEOUT_MS = 30_000;

function assertAllowedHost(url: string): void {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new ProviderError("PROVIDER_INVALID_REQUEST", "pexels: invalid URL");
  }
  if (!DOWNLOAD_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    throw new ProviderError("PROVIDER_INVALID_REQUEST", "pexels: unexpected download host");
  }
}

async function apiJson<T>(
  path: string,
  apiKey: string,
  outboundFetch: ExtensionFetchClient,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await outboundFetch(`${API_BASE}${path}`, {
      headers: { Authorization: apiKey },
      signal: controller.signal,
    });
  } catch (cause) {
    throw providerErrorFromTransport(cause, "pexels");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw providerErrorFromStatus(response.status, "pexels");
  return (await response.json()) as T;
}

interface PexelsPhoto {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly photographer: string;
  readonly photographer_url: string;
  readonly url: string;
  readonly src: { readonly medium: string; readonly original: string };
}

interface PexelsSearchResponse {
  readonly photos: readonly PexelsPhoto[];
  readonly total_results: number;
  readonly page: number;
  readonly per_page: number;
}

async function downloadOriginal(
  photo: PexelsPhoto,
  apiKey: string,
  outboundFetch: ExtensionFetchClient,
) {
  assertAllowedHost(photo.src.original);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await outboundFetch(photo.src.original, {
      headers: { Authorization: apiKey },
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (cause) {
    throw providerErrorFromTransport(cause, "pexels");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw providerErrorFromStatus(response.status, "pexels");
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    mimeType: response.headers.get("content-type"),
    filename: new URL(photo.src.original).pathname.split("/").pop() ?? `pexels-${photo.id}.jpg`,
  };
}

export function createStockProvider(input: ProviderFactoryInput): MediaStockProvider {
  const apiKey = input.config["api_key"];
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new ProviderError("PROVIDER_NOT_CONFIGURED", "pexels: API key is not configured");
  }
  const outboundFetch = createExtensionFetchClientFromConfig(input.config);
  const provider: MediaStockProvider = {
    providerId: "pexels",
    displayName: "Pexels",
    capabilities: () => ({ providerId: "pexels", displayName: "Pexels" }),
    async search(_ctx: ProviderContext, request: StockSearchRequest): Promise<StockSearchResult> {
      const perPage = Math.min(Math.max(request.limit, 1), 30);
      const params = new URLSearchParams({ query: request.query, per_page: String(perPage) });
      if (request.orientation !== null && request.orientation !== undefined) {
        params.set("orientation", request.orientation);
      }
      const page = request.cursor ? Number.parseInt(request.cursor, 10) : 1;
      if (Number.isFinite(page) && page > 1) params.set("page", String(page));
      const data = await apiJson<PexelsSearchResponse>(
        `/search?${params.toString()}`,
        apiKey,
        outboundFetch,
      );
      const candidates: StockCandidate[] = data.photos.map((photo) => ({
        providerId: "pexels",
        providerAssetId: String(photo.id),
        previewUrl: photo.src.medium,
        // Server-side only (inside the signed token); never serialized out.
        downloadUrl: photo.src.original,
        width: photo.width,
        height: photo.height,
        creatorName: photo.photographer,
        creatorUrl: photo.photographer_url,
        sourceUrl: photo.url,
        licenseName: "Pexels License",
        licenseUrl: "https://www.pexels.com/license/",
      }));
      const fetched = data.page ?? page;
      const covered = fetched * (data.per_page || perPage);
      return {
        candidates,
        nextCursor: covered < data.total_results ? String(fetched + 1) : null,
      };
    },
    async fetch(_ctx, candidate: StockCandidate) {
      // GET /v1/photos/:id returns the photo (with its src.original).
      const photo = await apiJson<PexelsPhoto>(
        `/photos/${encodeURIComponent(candidate.providerAssetId)}`,
        apiKey,
        outboundFetch,
      );
      return downloadOriginal(photo, apiKey, outboundFetch);
    },
    async testConnection(_ctx) {
      await apiJson<unknown>("/curated?per_page=1", apiKey, outboundFetch);
      return { ok: true, message: null };
    },
  };
  return provider;
}
