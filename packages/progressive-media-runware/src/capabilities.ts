// Runware model-capabilities derivation (Image Generation v2, plan T1.2;
// PCMS-PRE-RESEARCH A3 successor). Ports the proven algorithm from the
// progressive-ai reference implementation: per-model request capabilities
// are READ from the published schema, never hardcoded per model. Two schema
// shapes are handled:
//  1. explicit size presets — allOf[].then.oneOf entries titled "<TIER>
//     (<ratio>)" with const width/height (Google image models);
//  2. bounded dimensions — width/height minimum/maximum/multipleOf, from
//     which standard-ratio options are derived per resolution tier.
// The output feeds the studio UI (T4), the server-side pixel derivation
// (T2.3) and the cost estimator (T1.6).
import type {
  ModelCapabilities,
  ModelRequestProfile,
  ModelSizeOption,
  ResolutionTier,
} from "@pcms/media";
import type { RunwareModelSchema } from "./model-schema.js";

interface SchemaProperty {
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly multipleOf?: number;
  readonly default?: unknown;
  readonly maxItems?: number;
  readonly const?: number;
}

type SchemaProperties = Record<string, SchemaProperty & { properties?: SchemaProperties }>;

const TIER_ORDER: readonly ResolutionTier[] = ["0.5k", "1k", "2k", "4k"];
/** Target megapixel area per tier for size derivation (~0.59/1/4/14 MP). */
const TIER_TARGET_AREA: Readonly<Record<ResolutionTier, number>> = {
  "0.5k": 768 * 768,
  "1k": 1024 * 1024,
  "2k": 2048 * 2048,
  "4k": 3840 * 3840,
};
const DERIVED_RATIOS: readonly (readonly [number, number])[] = [
  [1, 1],
  [4, 3],
  [3, 4],
  [3, 2],
  [2, 3],
  [16, 9],
  [9, 16],
  [21, 9],
];
const DEFAULT_MULTIPLE_OF = 16;

function coerceTier(value: unknown): ResolutionTier | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (TIER_ORDER as readonly string[]).includes(normalized)
    ? (normalized as ResolutionTier)
    : null;
}

function snapDown(value: number, multipleOf: number): number {
  return Math.max(multipleOf, Math.floor(value / multipleOf) * multipleOf);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Explicit presets: allOf[].then.oneOf titled "<TIER> (<ratio>)". */
function presetsFromAllOf(items: {
  readonly allOf?: readonly {
    readonly then?: {
      readonly oneOf?: readonly { title?: string; properties?: SchemaProperties }[];
    };
  }[];
}): ModelSizeOption[] {
  const options: ModelSizeOption[] = [];
  for (const group of items.allOf ?? []) {
    for (const entry of group.then?.oneOf ?? []) {
      const match =
        typeof entry.title === "string" ? /^(\S+)\s+\(([^)]+)\)$/.exec(entry.title) : null;
      const tier = coerceTier(match?.[1]);
      const ratio = match?.[2] ?? "";
      const width = entry.properties?.width?.const;
      const height = entry.properties?.height?.const;
      if (
        tier === null ||
        ratio === "" ||
        typeof width !== "number" ||
        typeof height !== "number"
      ) {
        continue;
      }
      options.push({ ratio, width, height, tier });
    }
  }
  return options;
}

/** Derived options: standard ratios scaled to each tier inside the bounds. */
function deriveSizeOptions(width: SchemaProperty, height: SchemaProperty): ModelSizeOption[] {
  const min = { w: width.minimum ?? 128, h: height.minimum ?? 128 };
  const max = { w: width.maximum ?? 2048, h: height.maximum ?? 2048 };
  const multipleOf = Math.max(
    1,
    Math.trunc(width.multipleOf ?? height.multipleOf ?? DEFAULT_MULTIPLE_OF),
  );
  const options: ModelSizeOption[] = [];
  for (const tier of TIER_ORDER) {
    const targetArea = TIER_TARGET_AREA[tier];
    for (const [rw, rh] of DERIVED_RATIOS) {
      const scale = Math.sqrt(targetArea / (rw * rh));
      const w = clamp(snapDown(rw * scale, multipleOf), min.w, max.w);
      const h = clamp(snapDown(rh * scale, multipleOf), min.h, max.h);
      if (w < min.w || h < min.h) continue;
      const ratio = `${rw}:${rh}`;
      if (options.some((option) => option.ratio === ratio && option.tier === tier)) continue;
      options.push({ ratio, width: w, height: h, tier });
    }
  }
  return options;
}

function dedupeOptions(options: ModelSizeOption[]): ModelSizeOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = `${option.tier ?? ""}:${option.ratio}:${option.width}x${option.height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Recursively collects schema defaults into a plain object (port of the
 *  reference implementation): a property's own `default` wins, otherwise
 *  nested object properties contribute their defaults — this is where
 *  providerSettings.google.safetyTolerance="none" and friends come from. */
function collectDefaults(node: unknown): Record<string, unknown> | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const properties = (node as { properties?: Record<string, unknown> }).properties;
  if (typeof properties !== "object" || properties === null) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value !== "object" || value === null) continue;
    if (Object.hasOwn(value, "default") && (value as { default?: unknown }).default !== null) {
      out[key] = (value as { default?: unknown }).default;
      continue;
    }
    const nested = collectDefaults(value);
    if (nested !== undefined && Object.keys(nested).length > 0) out[key] = nested;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeResolutionMap(
  properties: SchemaProperties,
): Partial<Record<ResolutionTier, string>> | undefined {
  const values = properties.resolution?.enum;
  if (!Array.isArray(values)) return undefined;
  const map: Partial<Record<ResolutionTier, string>> = {};
  for (const value of values) {
    if (typeof value !== "string") continue;
    const tier = coerceTier(value);
    if (tier !== null && map[tier] === undefined) map[tier] = value;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

function pricingFromInfo(info: RunwareModelSchema["info"]): ModelCapabilities["pricing"] {
  const lines: {
    unit: string;
    costUsd: number;
    width?: number;
    height?: number;
    variant?: string;
  }[] = [];
  // Shape 1 — measured configurations ("1024×1024" → price), z-image style.
  for (const entry of info["x-pricing"]?.measured ?? []) {
    if (typeof entry.price !== "number" || typeof entry.configuration !== "string") continue;
    const match = /^(\d+)\s*[x×]\s*(\d+)$/.exec(entry.configuration.trim());
    if (match === null) continue;
    lines.push({
      unit: "configuration",
      costUsd: entry.price,
      width: Number(match[1]),
      height: Number(match[2]),
    });
  }
  if (lines.length > 0) return lines;
  // Shape 2 — per-tier output rates ("1K" → $/run), Google image style.
  for (const rate of info["x-pricing"]?.rates ?? []) {
    if (typeof rate.amount !== "number" || rate.unit !== "output") continue;
    lines.push({
      unit: "image",
      costUsd: rate.amount,
      ...(rate.label === undefined ? {} : { variant: rate.label }),
    });
  }
  return lines.length > 0 ? lines : undefined;
}

export interface DeriveInput {
  readonly schema: RunwareModelSchema;
  readonly sha256: string | null;
  readonly fetchedAt: string;
  readonly providerId: string;
}

/** Derives the per-model capability snapshot from a published schema, or
 *  returns null when the document is not a recognizable request schema. */
/** Neutral contract for models whose slug/schema can't be resolved (new
 *  provider releases, docs catalog lag, or a blocked docs fetch — owner
 *  report 2026-10-08 on arenaofstars: qwen-image@3.0-pro and
 *  nano-banana@2-lite 404'd while z-image turbo, whose slug is in the known
 *  map, kept working). Runware's imageInference needs only model + prompt +
 *  dimensions, all of which buildImageInferenceTask already falls back on —
 *  so an unknown model must degrade to a labeled "preset" contract, never
 *  disappear behind MEDIA_MODEL_UNKNOWN. Sizes are standard Runware-safe
 *  buckets; nothing vendor-specific is invented. */
export function fallbackModelCapabilities(model: string, providerId: string): ModelCapabilities {
  const now = new Date().toISOString();
  return {
    providerId,
    model,
    displayName: model,
    sizeOptions: [
      { ratio: "1:1", width: 1024, height: 1024, tier: null },
      { ratio: "3:2", width: 1216, height: 832, tier: null },
      { ratio: "2:3", width: 832, height: 1216, tier: null },
      { ratio: "16:9", width: 1280, height: 720, tier: null },
      { ratio: "9:16", width: 720, height: 1280, tier: null },
    ],
    requestProfile: {
      dimensionMode: "widthHeight",
      sendSteps: false,
      sendCfgScale: false,
      sendScheduler: false,
      sendSeed: true,
      sendStrength: false,
      maxReferenceImages: 0,
    },
    maxCount: 4,
    supportsNegativePrompt: true,
    source: "preset",
    schemaSha256: null,
    lastSyncedAt: now,
  };
}

export function deriveModelCapabilities(input: DeriveInput): ModelCapabilities | null {
  const { schema, sha256, fetchedAt, providerId } = input;
  const items = schema.components?.schemas?.RequestBody?.items as
    | (SchemaProperty & {
        readonly properties?: SchemaProperties;
        readonly allOf?: readonly {
          readonly then?: {
            readonly oneOf?: readonly { title?: string; properties?: SchemaProperties }[];
          };
        }[];
      })
    | undefined;
  const properties = items?.properties;
  if (properties === undefined) return null;

  const width = properties.width;
  const height = properties.height;
  const presets = items === undefined ? [] : presetsFromAllOf(items);
  const derived =
    presets.length > 0 || width === undefined || height === undefined
      ? []
      : deriveSizeOptions(width, height);
  const sizeOptions = dedupeOptions([...presets, ...derived]);

  const inputs = properties.inputs as { readonly properties?: SchemaProperties } | undefined;
  const referenceImages = inputs?.properties?.referenceImages;
  const maxReferenceImages =
    typeof referenceImages?.maxItems === "number"
      ? referenceImages.maxItems
      : inputs?.properties?.seedImage !== undefined
        ? 1
        : 0;

  const resolutionMap = normalizeResolutionMap(properties);
  const providerSettingsDefaults = collectDefaults(properties.providerSettings);
  const settingsDefaults = collectDefaults(properties.settings);
  const requestProfile: ModelRequestProfile = {
    dimensionMode: properties.resolution !== undefined ? "resolutionOrWidthHeight" : "widthHeight",
    ...(resolutionMap === undefined ? {} : { resolutionMap }),
    sendSteps: properties.steps !== undefined,
    sendCfgScale: properties.CFGScale !== undefined,
    sendScheduler: properties.scheduler !== undefined,
    sendSeed: properties.seed !== undefined,
    sendStrength: properties.strength !== undefined,
    maxReferenceImages,
    ...(providerSettingsDefaults === undefined
      ? {}
      : { providerSettings: providerSettingsDefaults }),
    ...(settingsDefaults === undefined ? {} : { settings: settingsDefaults }),
  };

  const numberResultsMax = properties.numberResults?.maximum;
  const pricing = pricingFromInfo(schema.info);
  const displayName =
    typeof schema.info?.title === "string"
      ? schema.info.title.replace(/^Runware API\s*-\s*/i, "").trim() ||
        (schema.info["x-air-id"] ?? "")
      : (schema.info?.["x-air-id"] ?? "");

  return {
    providerId,
    model: schema.info?.["x-air-id"] ?? "",
    displayName,
    sizeOptions,
    requestProfile,
    maxCount:
      typeof numberResultsMax === "number" && numberResultsMax >= 1
        ? Math.trunc(numberResultsMax)
        : 4,
    supportsNegativePrompt: properties.negativePrompt !== undefined,
    ...(pricing === undefined ? {} : { pricing }),
    source: "schema",
    schemaSha256: sha256,
    lastSyncedAt: fetchedAt,
  };
}
