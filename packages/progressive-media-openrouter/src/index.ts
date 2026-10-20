// OpenRouter image generation provider (Image Generation v2, plan Ф3/T3).
// The Images API is the canonical surface (chat-completions modalities is
// legacy): POST {base}/images returns base64 bytes in data[].b64_json with
// usage.cost; model contracts come from the public catalog
// GET /images/models + per-endpoint GET /images/models/{id}/endpoints
// (supported_parameters + pricing with mixed units). Failed generations are
// 502 and never billed — surfaced as PROVIDER_FAILED. Candidates carry the
// base64 as their server-side-only downloadUrl (never serialized out), so
// accept/fetch decodes in-process — no hosted URL, no cache to evict.
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
  ResolutionTier,
} from "@pcms/media";
import {
  MAX_COUNT_CEILING,
  ProviderError,
  providerErrorFromStatus,
  providerErrorFromTransport,
  normalizeModelCapabilities,
} from "@pcms/media";
import { createExtensionFetchClientFromConfig } from "@pcms/extensions";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 300_000; // image models are slow (up to minutes)

interface ConfiguredModel {
  readonly model: string;
  readonly params?: Record<string, unknown>;
  readonly capabilities?: ModelCapabilities;
}

function readConfiguredModels(config: Record<string, unknown>): readonly ConfiguredModel[] {
  const raw = config["models"];
  if (Array.isArray(raw)) {
    const entries: ConfiguredModel[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      if (typeof record["model"] !== "string" || record["model"].length === 0) continue;
      entries.push({
        model: record["model"],
        ...(typeof record["params"] === "object" && record["params"] !== null
          ? { params: record["params"] as Record<string, unknown> }
          : {}),
        ...(typeof record["capabilities"] === "object" && record["capabilities"] !== null
          ? { capabilities: record["capabilities"] as unknown as ModelCapabilities }
          : {}),
      });
    }
    if (entries.length > 0) return entries;
  }
  const fallback =
    typeof config["default_model"] === "string" ? (config["default_model"] as string) : "";
  return fallback === "" ? [] : [{ model: fallback }];
}

// ---- endpoint document → capability snapshot --------------------------------

interface ParamDescriptor {
  readonly type?: string;
  readonly values?: readonly string[];
  readonly min?: number;
  readonly max?: number;
}

interface PriceLine {
  readonly billable?: string;
  readonly unit?: string;
  readonly cost_usd?: number;
  readonly variant?: string;
}

interface EndpointDoc {
  readonly data?: readonly {
    readonly id?: string;
    readonly name?: string;
    readonly architecture?: {
      readonly input_modalities?: readonly string[];
      readonly output_modalities?: readonly string[];
    };
    readonly supported_parameters?: Record<string, ParamDescriptor>;
    readonly pricing?: readonly PriceLine[];
  }[];
}

interface EndpointsDoc {
  readonly data?: readonly {
    readonly provider_name?: string;
    readonly supported_parameters?: Record<string, ParamDescriptor>;
    readonly pricing?: readonly PriceLine[];
  }[];
}

const TIER_BY_LABEL: ReadonlyMap<string, ResolutionTier> = new Map([
  ["512", "0.5k"],
  ["0.5K", "0.5k"],
  ["1K", "1k"],
  ["2K", "2k"],
  ["4K", "4k"],
]);

const TIER_TARGET_AREA: Readonly<Record<ResolutionTier, number>> = {
  "0.5k": 768 * 768,
  "1k": 1024 * 1024,
  "2k": 2048 * 2048,
  "4k": 3840 * 3840,
};

/** Derives a capability snapshot from one endpoint record. Pixel values are
 *  estimates for the size grid/cost preview — the wire sends
 *  aspect_ratio/resolution, which the API normalizes per provider. */
export function deriveFromEndpoint(
  model: string,
  endpoint: {
    readonly supported_parameters?: Record<string, ParamDescriptor>;
    readonly pricing?: readonly PriceLine[];
  },
): ModelCapabilities {
  const params = endpoint.supported_parameters ?? {};
  const aspects = (params["aspect_ratio"]?.values ?? []).filter(
    (value): value is string => typeof value === "string",
  );
  const tiers = (params["resolution"]?.values ?? [])
    .map((value) => TIER_BY_LABEL.get(value) ?? null)
    .filter((value): value is ResolutionTier => value !== null);
  const nMax = params["n"]?.max;
  const refsMax = params["input_references"]?.max;

  const sizeOptions: ModelSizeOption[] = [];
  for (const tier of tiers.length > 0 ? tiers : (["1k"] as const)) {
    const targetArea = TIER_TARGET_AREA[tier];
    for (const ratio of aspects.length > 0 ? aspects : ["1:1"]) {
      const parts = ratio.split(":").map(Number);
      const rw = parts[0];
      const rh = parts[1];
      if (
        rw === undefined ||
        rh === undefined ||
        !Number.isFinite(rw) ||
        !Number.isFinite(rh) ||
        rw <= 0 ||
        rh <= 0
      ) {
        continue;
      }
      const scale = Math.sqrt(targetArea / (rw * rh));
      const round16 = (value: number) => Math.max(16, Math.floor(value / 16) * 16);
      sizeOptions.push({ ratio, width: round16(rw * scale), height: round16(rh * scale), tier });
    }
  }

  const pricing = (endpoint.pricing ?? [])
    .filter((line) => typeof line.cost_usd === "number" && typeof line.unit === "string")
    .map((line) => ({
      unit: line.unit as string,
      costUsd: line.cost_usd as number,
      ...(line.variant === undefined ? {} : { variant: line.variant }),
    }));

  return {
    providerId: "openrouter",
    model,
    displayName: model,
    sizeOptions,
    requestProfile: {
      // OpenRouter normalizes aspect/resolution server-side; pixels are ours.
      dimensionMode: "widthHeight",
      sendSteps: false,
      sendCfgScale: false,
      sendScheduler: false,
      sendSeed: params["seed"]?.type === "boolean",
      sendStrength: false,
      maxReferenceImages: typeof refsMax === "number" ? Math.trunc(refsMax) : 0,
    },
    maxCount:
      typeof nMax === "number" && nMax >= 1 ? Math.min(Math.trunc(nMax), MAX_COUNT_CEILING) : 1,
    supportsNegativePrompt: false,
    ...(pricing.length > 0 ? { pricing } : {}),
    source: "catalog",
    schemaSha256: null,
    lastSyncedAt: new Date().toISOString(),
  };
}

export function createGenerationProvider(input: ProviderFactoryInput): ImageGenerationProvider {
  const apiKey = input.config["api_key"];
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new ProviderError("PROVIDER_NOT_CONFIGURED", "openrouter: API key is not configured");
  }
  const baseUrl =
    typeof input.config["base_url"] === "string" && input.config["base_url"].length > 0
      ? (input.config["base_url"] as string).replace(/\/$/, "")
      : DEFAULT_BASE_URL;
  const models = readConfiguredModels(input.config);
  const outboundFetch = createExtensionFetchClientFromConfig(input.config);

  async function getJson<T>(url: string): Promise<T> {
    let response: Response;
    try {
      response = await outboundFetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw providerErrorFromTransport(cause, "openrouter");
    }
    if (!response.ok) throw providerErrorFromStatus(response.status, "openrouter");
    return (await response.json()) as T;
  }

  async function endpointForModel(model: string) {
    const doc = await getJson<EndpointsDoc>(`${baseUrl}/images/models/${model}/endpoints`);
    const endpoint = (doc.data ?? [])[0];
    if (endpoint === undefined) {
      throw new ProviderError(
        "PROVIDER_INVALID_REQUEST",
        `openrouter: model "${model}" has no image endpoints`,
      );
    }
    return endpoint;
  }

  const provider: ImageGenerationProvider = {
    providerId: "openrouter",
    displayName: "OpenRouter",
    capabilities(): GenerationProviderCapabilities {
      return {
        providerId: "openrouter",
        displayName: "OpenRouter",
        models: models.map((entry) => entry.model),
        maxCount: MAX_COUNT_CEILING,
        supportsSeed: true,
        supportsNegativePrompt: false,
        aspects: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
      };
    },
    configuredModels(): readonly ModelCapabilities[] {
      // Stored snapshots arrive in the Admin wire shape — normalize, never
      // cast (see runware, 2026-09-29 prod incident).
      return models
        .map((entry) => normalizeModelCapabilities(entry.capabilities, "openrouter"))
        .filter((entry): entry is ModelCapabilities => entry !== null);
    },
    async listModels(_ctx, query) {
      const doc = await getJson<EndpointDoc>(`${baseUrl}/images/models`);
      const items = doc.data ?? [];
      const needle = query.search?.toLowerCase();
      return items
        .filter((entry) => typeof entry.id === "string")
        .filter(
          (entry) =>
            needle === undefined || needle === "" || entry.id!.toLowerCase().includes(needle),
        )
        .slice(0, query.limit ?? 50)
        .map((entry) => ({
          model: entry.id as string,
          displayName: entry.name ?? (entry.id as string),
          capabilities: entry.architecture?.input_modalities ?? [],
          thumbnail: null,
          status: null,
        }));
    },
    async resolveModelCapabilities(_ctx, model) {
      return deriveFromEndpoint(model, await endpointForModel(model));
    },
    async generate(_ctx, request: GenerationRequest): Promise<GenerationResult> {
      const model = request.model ?? models[0]?.model;
      if (model === undefined || model === "") {
        throw new ProviderError("PROVIDER_NOT_CONFIGURED", "openrouter: no model configured");
      }
      const entry = models.find((candidate) => candidate.model === model);
      const body: Record<string, unknown> = {
        model,
        prompt: request.prompt,
        // Count ladder ends at the agent/human surfaces; clamp defensively.
        n: Math.min(Math.max(request.count, 1), MAX_COUNT_CEILING),
      };
      if (
        request.width !== null &&
        request.width !== undefined &&
        request.height !== null &&
        request.height !== undefined
      ) {
        body["size"] = `${request.width}x${request.height}`;
      } else {
        if (request.aspect !== null && request.aspect !== undefined)
          body["aspect_ratio"] = request.aspect;
        if (request.resolution !== null && request.resolution !== undefined)
          body["resolution"] = request.resolution.toUpperCase().replace("0.5K", "512");
      }
      if (request.seed !== null && request.seed !== undefined) body["seed"] = request.seed;
      const references = request.referenceImages ?? [];
      if (references.length > 0)
        body["input_references"] = references.map((reference) => reference.dataUri);
      Object.assign(body, entry?.params ?? {});

      let response: Response;
      try {
        response = await outboundFetch(`${baseUrl}/images`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (cause) {
        throw providerErrorFromTransport(cause, "openrouter");
      }
      if (!response.ok) {
        // 402 insufficient credits and upstream provider failures deserve
        // their message text — the studio shows it verbatim.
        const detail = await response.text().catch(() => "");
        const error = providerErrorFromStatus(response.status, "openrouter");
        throw new ProviderError(
          error.code,
          `${error.message}${detail === "" ? "" : `: ${detail.slice(0, 300)}`}`,
        );
      }
      const payload = (await response.json()) as {
        data?: readonly { readonly b64_json?: string; readonly media_type?: string }[];
        usage?: { readonly cost?: number };
      };
      const items = (payload.data ?? []).filter((item) => typeof item.b64_json === "string");
      if (items.length === 0) {
        throw new ProviderError("PROVIDER_FAILED", "openrouter: response carried no images");
      }
      const perImageCost =
        payload.usage?.cost !== undefined && items.length > 0
          ? payload.usage.cost / items.length
          : null;
      const candidates: GeneratedCandidate[] = items.map((item, index) => {
        const mime = item.media_type ?? "image/png";
        const dataUri = `data:${mime};base64,${item.b64_json}`;
        return {
          index,
          // Bytes live in-process: preview waits for the auto-imported asset.
          previewUrl: null,
          downloadUrl: dataUri,
          width: request.width ?? null,
          height: request.height ?? null,
          mimeType: mime,
          model,
          providerRequestId: null,
          seed: request.seed ?? null,
          cost: perImageCost,
        };
      });
      return {
        candidates,
        providerRequestId: null,
        cost: payload.usage?.cost ?? null,
      };
    },
    async fetch(_ctx, candidate) {
      if (candidate.downloadUrl === null || !candidate.downloadUrl.startsWith("data:")) {
        throw new ProviderError("PROVIDER_FAILED", "openrouter: candidate carries no inline bytes");
      }
      const commaIndex = candidate.downloadUrl.indexOf(",");
      const mime = candidate.downloadUrl.slice(5, candidate.downloadUrl.indexOf(";"));
      const bytes = Buffer.from(candidate.downloadUrl.slice(commaIndex + 1), "base64");
      return {
        bytes,
        mimeType: mime === "" ? "image/png" : mime,
        filename: `openrouter-${candidate.index}.${mime === "image/jpeg" ? "jpg" : "png"}`,
      };
    },
    async testConnection(_ctx) {
      // Free ping: the models catalog rejects bad credentials.
      await getJson(`${baseUrl}/images/models`);
      return { ok: true, message: null };
    },
  };
  return provider;
}

// Re-exported type for tests.
