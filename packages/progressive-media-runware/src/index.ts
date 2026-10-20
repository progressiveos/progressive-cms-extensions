// Runware image generation provider (ADR-0013, Media spec §71.1/§71.7;
// Image Generation v2 plan T1.4/T1.5). Synchronous single REST POST with a
// JSON array carrying one imageInference task (the API rejects task ids
// that are not UUIDv4). Generation results are candidate metadata only —
// bytes are fetched server-side on accept, and download URLs never leave
// the CMS.
//
// Model management v2: models come from the `models[]` config (air-id +
// docs slug + capability snapshot + per-model params), discovered through
// the native modelSearch catalog and per-model schema.json contracts. The
// scalar `model`/`model_slug`/`model_params` config remains a working
// fallback (single-model legacy shape). Generation uses the stored
// capability snapshot when present — a docs-host outage never blocks it.

import { createExtensionFetchClientFromConfig } from "@pcms/extensions";
import type {
  GeneratedCandidate,
  GenerationProviderCapabilities,
  GenerationRequest,
  GenerationResult,
  ImageGenerationProvider,
  ModelCapabilities,
  ModelSizeOption,
  ProviderContext,
  ProviderFactoryInput,
} from "@pcms/media";
import {
  MAX_COUNT_CEILING,
  ProviderError,
  normalizeModelCapabilities,
  providerErrorFromStatus,
} from "@pcms/media";
import { buildImageInferenceTask } from "./build-task.js";
import { deriveModelCapabilities, fallbackModelCapabilities } from "./capabilities.js";
import {
  DOCS_CATALOG_TTL_MS,
  type DocsCatalog,
  fetchDocsCatalog,
  runwareModelSearch,
  slugForAir,
} from "./catalog.js";
import {
  assertSchemaHost,
  modelSchemaUrl,
  resolveModelSchema,
  schemaRequestProperties,
} from "./model-schema.js";

const API_BASE = "https://api.runware.ai/v1";
const DOWNLOAD_HOST_SUFFIXES = ["runware.net", "runware.ai", "amazonaws.com"];
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_REDIRECTS = 3;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
/** Default generation model (owner decision, PCMS-PRE-RESEARCH A3). */
const DEFAULT_MODEL = "runware:z-image@turbo";
const _DEFAULT_MODEL_SLUG = "alibaba-z-image-turbo";
const ASPECT_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "4:3": { width: 1024, height: 768 },
  "3:4": { width: 768, height: 1024 },
  // True 3:2 at 1024-wide would be 683px — not a multiple of 16 and invalid
  // for most models; 1536×1024 is exact and inside every shipped contract.
  "3:2": { width: 1536, height: 1024 },
  "2:3": { width: 1024, height: 1536 },
  "16:9": { width: 1024, height: 576 },
  "9:16": { width: 576, height: 1024 },
};

function assertAllowedHost(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderError("PROVIDER_INVALID_REQUEST", "runware: invalid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new ProviderError("PROVIDER_INVALID_REQUEST", "runware: download URL must be https");
  }
  if (
    !DOWNLOAD_HOST_SUFFIXES.some(
      (suffix) => parsed.host === suffix || parsed.host.endsWith(`.${suffix}`),
    )
  ) {
    throw new ProviderError("PROVIDER_INVALID_REQUEST", "runware: unexpected download host");
  }
}

interface RunwareImageResult {
  readonly taskType: string;
  readonly taskUUID: string;
  readonly imageUUID: string;
  readonly imageURL: string;
  readonly model: string | null;
  readonly cost: number | null;
  readonly seed: number | null;
}

/** One entry of the v2 `models[]` provider config. */
export interface ConfiguredModel {
  readonly model: string;
  readonly slug?: string;
  readonly params?: Record<string, unknown>;
  readonly capabilities?: ModelCapabilities;
}

/** Reads the v2 models list with the scalar legacy shape as fallback. */
export function readConfiguredModels(config: Record<string, unknown>): readonly ConfiguredModel[] {
  const raw = config.models;
  if (Array.isArray(raw)) {
    const entries: ConfiguredModel[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.model !== "string" || record.model.length === 0) continue;
      entries.push({
        model: record.model,
        ...(typeof record.slug === "string" && record.slug.length > 0 ? { slug: record.slug } : {}),
        ...(typeof record.params === "object" && record.params !== null
          ? { params: record.params as Record<string, unknown> }
          : {}),
        ...(typeof record.capabilities === "object" && record.capabilities !== null
          ? { capabilities: record.capabilities as unknown as ModelCapabilities }
          : {}),
      });
    }
    if (entries.length > 0) return entries;
  }
  // Legacy scalar shape — still fully functional.
  const model =
    typeof config.model === "string" && config.model.length > 0
      ? (config.model as string)
      : DEFAULT_MODEL;
  const slug =
    typeof config.model_slug === "string" && config.model_slug.length > 0
      ? (config.model_slug as string)
      : undefined;
  const legacyModelParams =
    typeof config.model_params === "object" && config.model_params !== null
      ? (config.model_params as Record<string, unknown>)
      : undefined;
  return [
    {
      model,
      ...(slug === undefined ? {} : { slug }),
      ...(legacyModelParams === undefined ? {} : { params: legacyModelParams }),
    },
  ];
}

/** Picks the closest configured size for an aspect intent (schema-derived
 *  first, hardcoded table as the last resort). */
export function pickFallbackDimensions(
  snapshot: ModelCapabilities | null,
  aspect: string | null | undefined,
): { width: number; height: number } {
  if (snapshot !== null && snapshot.sizeOptions.length > 0) {
    const matching =
      aspect === null || aspect === undefined
        ? []
        : snapshot.sizeOptions.filter((option: ModelSizeOption) => option.ratio === aspect);
    const pool = matching.length > 0 ? matching : snapshot.sizeOptions;
    const preferred = pool.find((option) => option.tier === "1k") ?? pool[0];
    if (preferred !== undefined) return { width: preferred.width, height: preferred.height };
  }
  const legacy = aspect !== null && aspect !== undefined ? ASPECT_DIMENSIONS[aspect] : undefined;
  return legacy ?? ASPECT_DIMENSIONS["1:1"]!;
}

export function createGenerationProvider(input: ProviderFactoryInput): ImageGenerationProvider {
  const apiKey = input.config.api_key;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new ProviderError("PROVIDER_NOT_CONFIGURED", "runware: API key is not configured");
  }
  const models = readConfiguredModels(input.config);
  const outboundFetch = createExtensionFetchClientFromConfig(input.config);

  // Manual-redirect download: every hop re-passes the https+host allowlist
  // and the body is stream-capped, so a compromised API answer cannot bounce
  // the fetch at internal addresses (same discipline as @pcms/media
  // fetchRemoteMedia, but through the extension's proxy-aware fetch client).
  async function readBodyCapped(response: Response, cap: number): Promise<Buffer> {
    const body = response.body;
    if (body === null) {
      throw new ProviderError("PROVIDER_FAILED", "runware: empty download body");
    }
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        void reader.cancel();
        throw new ProviderError("PROVIDER_FAILED", "runware: download exceeds size cap");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  async function fetchDownloadBytes(
    rawUrl: string,
  ): Promise<{ bytes: Buffer; mimeType: string; url: string }> {
    let current = rawUrl;
    for (let hop = 0; ; hop += 1) {
      assertAllowedHost(current);
      const response = await outboundFetch(current, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        if (hop >= MAX_DOWNLOAD_REDIRECTS) {
          throw new ProviderError(
            "PROVIDER_FAILED",
            `runware: more than ${MAX_DOWNLOAD_REDIRECTS} redirects`,
          );
        }
        const location = response.headers.get("location");
        if (location === null) {
          throw new ProviderError("PROVIDER_FAILED", "runware: redirect without location");
        }
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) throw providerErrorFromStatus(response.status, "runware");
      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
        throw new ProviderError("PROVIDER_FAILED", "runware: download exceeds size cap");
      }
      return {
        bytes: await readBodyCapped(response, MAX_DOWNLOAD_BYTES),
        mimeType: response.headers.get("content-type") ?? "image/jpeg",
        url: current,
      };
    }
  }

  // Docs catalog cache (module-lifetime): air → schema slug mapping.
  let docsCatalog: DocsCatalog | null = null;
  let docsCatalogFetchedAt = 0;
  async function docsCatalogCached(): Promise<DocsCatalog | null> {
    if (docsCatalog !== null && Date.now() - docsCatalogFetchedAt < DOCS_CATALOG_TTL_MS) {
      return docsCatalog;
    }
    try {
      const previous = docsCatalog ?? undefined;
      docsCatalog = await fetchDocsCatalog(async (url) => {
        assertSchemaHost(url);
        const response = await outboundFetch(url, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw providerErrorFromStatus(response.status, "runware");
        return await response.text();
      }, previous);
      docsCatalogFetchedAt = Date.now();
      return docsCatalog;
    } catch {
      return docsCatalog; // stale beats empty; never blocks anything
    }
  }

  async function fetchSchemaJson(url: string, timeoutMs: number): Promise<unknown> {
    assertSchemaHost(url);
    const response = await outboundFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw providerErrorFromStatus(response.status, "runware");
    return (await response.json()) as unknown;
  }

  async function postTasks<T>(task: Record<string, unknown>): Promise<readonly T[]> {
    const response = await outboundFetch(API_BASE, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify([task]),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw providerErrorFromStatus(response.status, "runware");
    const payload = (await response.json()) as { data?: readonly T[] };
    return payload.data ?? [];
  }

  /** Slug for a model: config entry → known map → live docs catalog. */
  async function slugForModel(model: string): Promise<string | null> {
    const entry = models.find((candidate) => candidate.model === model);
    if (entry?.slug !== undefined) return entry.slug;
    // 2026-09-29: split("/")[4] returned "models" (the path segment), which
    // passed the slug regex and produced /docs/models/models/schema.json —
    // a fast 404 that broke model sync while generation survived on its
    // stored-snapshot fallback. Parse the slug position instead of counting.
    const knownUrl = modelSchemaUrl(model, null);
    const known =
      knownUrl === null ? null : (knownUrl.split("/docs/models/")[1]?.split("/")[0] ?? null);
    if (known !== null && known.length > 0) return known;
    return slugForAir(await docsCatalogCached(), model);
  }

  /** Live capability resolution from the model's published schema. When the
   *  slug/schema can't be resolved (brand-new model, docs catalog lag, or a
   *  blocked docs fetch — 0.1.200 report), the model still generates:
   *  returns a labeled "preset" contract instead of null, so the studio
   *  never 404s the model behind MEDIA_MODEL_UNKNOWN. */
  async function liveCapabilities(model: string): Promise<ModelCapabilities | null> {
    const slug = await slugForModel(model);
    if (slug !== null && slug.length > 0) {
      const resolved = await resolveModelSchema(slug, fetchSchemaJson);
      if (resolved.schema !== null) {
        return deriveModelCapabilities({
          schema: resolved.schema,
          sha256: resolved.sha256,
          fetchedAt: resolved.fetchedAt ?? new Date().toISOString(),
          providerId: "runware",
        });
      }
    }
    return fallbackModelCapabilities(model, "runware");
  }

  const provider: ImageGenerationProvider = {
    providerId: "runware",
    displayName: "Runware",
    capabilities(): GenerationProviderCapabilities {
      return {
        providerId: "runware",
        displayName: "Runware",
        models: models.map((entry) => entry.model),
        maxCount: MAX_COUNT_CEILING,
        supportsSeed: true,
        supportsNegativePrompt: true,
        aspects: Object.keys(ASPECT_DIMENSIONS),
      };
    },
    configuredModels(): readonly ModelCapabilities[] {
      // Stored snapshots arrive in the Admin wire shape — normalize instead
      // of casting (a blind cast crashed capabilitiesWire on sizeOptions.map,
      // 2026-09-29 prod incident).
      return models
        .map((entry) => normalizeModelCapabilities(entry.capabilities, "runware"))
        .filter((entry): entry is ModelCapabilities => entry !== null);
    },
    async listModels(ctx, query) {
      void ctx;
      const page = await runwareModelSearch(
        async (body) => {
          const response = await outboundFetch(API_BASE, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (!response.ok) throw providerErrorFromStatus(response.status, "runware");
          return (await response.json()) as {
            data?: readonly (Record<string, unknown> | null)[];
            errors?: never;
          };
        },
        {
          ...(query.search === undefined ? {} : { search: query.search }),
          capabilities: ["io:text-to-image"],
          source: "curated",
          limit: Math.min(Math.max(query.limit ?? 20, 1), 100),
        },
      );
      return page.results;
    },
    async resolveModelCapabilities(ctx, model) {
      void ctx;
      return liveCapabilities(model);
    },
    async generate(_ctx: ProviderContext, request: GenerationRequest): Promise<GenerationResult> {
      const model = request.model ?? models[0]?.model ?? DEFAULT_MODEL;
      const entry = models.find((candidate) => candidate.model === model);
      const modelParams = entry?.params ?? {};

      // Contract resolution: slug (config → known map → docs cache) →
      // schema (resolver degrades fetched → cache → last-known-good → none
      // and never throws). A stored capability snapshot fills in the
      // request profile and fallback sizes when the schema is unavailable.
      const slug = await slugForModel(model);
      const resolved =
        slug === null || slug.length === 0 ? null : await resolveModelSchema(slug, fetchSchemaJson);
      const properties = resolved === null ? null : schemaRequestProperties(resolved);
      // Stored capability snapshots arrive in the Admin wire shape
      // (snake_case) — normalize instead of casting: a blind cast crashed
      // generate() on sizeOptions.length (same class as the 2026-09-29
      // configuredModels incident; owner-confirmed on arenaofstars 0.1.199).
      let snapshot = normalizeModelCapabilities(entry?.capabilities ?? null, "runware");
      if (snapshot === null && resolved?.schema != null) {
        snapshot = deriveModelCapabilities({
          schema: resolved.schema,
          sha256: resolved.sha256,
          fetchedAt: resolved.fetchedAt ?? new Date().toISOString(),
          providerId: "runware",
        });
      }

      const fallbackDimensions = pickFallbackDimensions(snapshot, request.aspect);
      const built = buildImageInferenceTask({
        request,
        model,
        modelParams,
        properties,
        schemaSource: resolved?.source ?? "none",
        schemaFetchedAt: resolved?.fetchedAt ?? null,
        profile: snapshot?.requestProfile ?? null,
        fallbackDimensions,
        maxCount: MAX_COUNT_CEILING,
      });
      const { task, width, height, count } = built;

      const results = await postTasks<RunwareImageResult>(task);
      if (results.length === 0) {
        throw new ProviderError("PROVIDER_FAILED", "runware: response carried no image results");
      }
      const candidates: GeneratedCandidate[] = results.map((item, index) => {
        assertAllowedHost(item.imageURL);
        return {
          index,
          previewUrl: item.imageURL,
          // Server-side only: stored in the run row, never serialized out.
          downloadUrl: item.imageURL,
          width,
          height,
          mimeType: "image/jpeg",
          model: item.model ?? model,
          providerRequestId: item.imageUUID,
          seed: item.seed,
          cost: item.cost,
        };
      });
      const totalCost = candidates.reduce((sum, candidate) => sum + (candidate.cost ?? 0), 0);
      return {
        candidates,
        providerRequestId: built.task.taskUUID as string,
        cost: totalCost > 0 ? totalCost : null,
      };
    },
    async fetch(_ctx, candidate: GeneratedCandidate) {
      if (candidate.downloadUrl === null) {
        throw new ProviderError(
          "PROVIDER_FAILED",
          "runware: candidate carries no download location",
        );
      }
      const { bytes, mimeType, url } = await fetchDownloadBytes(candidate.downloadUrl);
      return {
        bytes,
        mimeType,
        filename: new URL(url).pathname.split("/").pop() ?? "runware.jpg",
      };
    },
    async testConnection(_ctx) {
      // Runware has no free ping; the smallest honest probe is one minimal
      // inference (documented cost behavior — surfaced by Test connection).
      // 512×512 keeps the probe cheap on megapixel-priced models.
      const result = await provider.generate(
        { requestId: "test" },
        {
          prompt: "connection test",
          count: 1,
          aspect: "1:1",
          width: 512,
          height: 512,
          resolution: null,
          model: null,
          negativePrompt: null,
          seed: null,
        },
      );
      return {
        ok: true,
        message: result.cost === null ? null : `test generation cost ${result.cost} credits`,
      };
    },
  };
  return provider;
}
