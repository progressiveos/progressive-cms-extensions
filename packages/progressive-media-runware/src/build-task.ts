// Pure task builder for the Runware imageInference call (PCMS-PRE-RESEARCH
// A3; Image Generation v2 plan T1.3). common fields + model-schema-driven
// capability gating + operator model_params passthrough. v2 adds: multipleOf
// snapping (schema multipleOf 16 with odd aspect tables produced formally
// invalid requests), resolution-or-widthHeight dimension modes per the
// model's request profile, typed model_params validation (enum/min/max —
// previously only key presence was checked), and request-profile defaults
// for providerSettings/settings. Kept side-effect free so all shipped model
// contracts (Z-Image, FLUX.2 Pro, GPT-Image Flare, Google image) are
// unit-testable without network.
import type { GenerationRequest, ModelRequestProfile, ResolutionTier } from "@pcms/media";
import { ProviderError } from "@pcms/media";

export interface BuiltTask {
  readonly task: Record<string, unknown>;
  readonly width: number | null;
  readonly height: number | null;
  readonly count: number;
  readonly model: string;
}

const COMMON_DIMENSION_BOUNDS = { min: 128, max: 2048 };
const DEFAULT_MULTIPLE_OF = 1;

interface NumericBounds {
  min: number;
  max: number;
  multipleOf: number;
}

function schemaBounds(properties: Record<string, unknown> | null, key: string): NumericBounds {
  const bounds = properties?.[key] as
    | { minimum?: number; maximum?: number; multipleOf?: number }
    | undefined;
  if (typeof bounds !== "object" || bounds === null) {
    return { ...COMMON_DIMENSION_BOUNDS, multipleOf: DEFAULT_MULTIPLE_OF };
  }
  return {
    min: bounds.minimum ?? COMMON_DIMENSION_BOUNDS.min,
    max: bounds.maximum ?? COMMON_DIMENSION_BOUNDS.max,
    multipleOf: Math.max(1, Math.trunc(bounds.multipleOf ?? DEFAULT_MULTIPLE_OF)),
  };
}

function snapDown(value: number, multipleOf: number): number {
  return multipleOf <= 1 ? Math.trunc(value) : Math.trunc(value / multipleOf) * multipleOf;
}

function dimension(
  requested: number | null | undefined,
  fallback: number,
  bounds: NumericBounds,
): number {
  const snapped = snapDown(requested ?? fallback, bounds.multipleOf);
  const clamped = Math.min(Math.max(snapped, bounds.min), bounds.max);
  // Clamping to a non-multiple bound (e.g. max 3840 with multipleOf 16 is
  // fine, but a max of 2050 would not be) — re-snap inside bounds.
  return snapDown(clamped, bounds.multipleOf) >= bounds.min
    ? snapDown(clamped, bounds.multipleOf)
    : bounds.min;
}

/** Resolves the provider-native resolution value ("1k" → "1K") when the
 *  model's contract prefers a resolution preset over explicit dimensions. */
export function resolutionFor(
  request: GenerationRequest,
  profile: ModelRequestProfile | null,
  properties: Record<string, unknown> | null,
): string | null {
  const wanted = request.resolution;
  if (typeof wanted !== "string" || wanted.length === 0) return null;
  if (profile === null || profile.dimensionMode !== "resolutionOrWidthHeight") return null;
  if (properties !== null && !("resolution" in properties)) return null;
  const mapped = profile.resolutionMap?.[wanted.toLowerCase() as ResolutionTier];
  return typeof mapped === "string" ? mapped : null;
}

/** Typed validation of a model_params value against its schema property:
 *  enum membership, numeric bounds, recursive for objects. Unknown keys are
 *  rejected by the caller before reaching here. */
export function validateParamValue(
  key: string,
  value: unknown,
  schema: unknown,
  path: string,
): void {
  if (typeof schema !== "object" || schema === null) return;
  const bound = schema as {
    enum?: readonly unknown[];
    minimum?: number;
    maximum?: number;
    type?: string;
    properties?: Record<string, unknown>;
  };
  if (Array.isArray(bound.enum)) {
    if (!bound.enum.includes(value)) {
      throw new ProviderError(
        "PROVIDER_INVALID_REQUEST",
        `runware: model_params "${path || key}" must be one of ${bound.enum.map((entry) => JSON.stringify(entry)).join(", ")}, got ${JSON.stringify(value)}`,
      );
    }
    return;
  }
  if (typeof value === "number") {
    if (typeof bound.minimum === "number" && value < bound.minimum) {
      throw new ProviderError(
        "PROVIDER_INVALID_REQUEST",
        `runware: model_params "${path || key}" must be ≥ ${bound.minimum}, got ${value}`,
      );
    }
    if (typeof bound.maximum === "number" && value > bound.maximum) {
      throw new ProviderError(
        "PROVIDER_INVALID_REQUEST",
        `runware: model_params "${path || key}" must be ≤ ${bound.maximum}, got ${value}`,
      );
    }
    return;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const nested = bound.properties;
    if (typeof nested !== "object" || nested === null) return;
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (!(childKey in nested)) {
        throw new ProviderError(
          "PROVIDER_INVALID_REQUEST",
          `runware: model_params "${path ? `${path}.${childKey}` : `${key}.${childKey}`}" is not accepted by the model schema`,
        );
      }
      validateParamValue(
        key,
        childValue,
        nested[childKey],
        path ? `${path}.${childKey}` : `${key}.${childKey}`,
      );
    }
  }
}

function mergeDefaults(
  task: Record<string, unknown>,
  key: "providerSettings" | "settings",
  profile: ModelRequestProfile | null,
  modelParams: Record<string, unknown>,
): void {
  const defaults = profile?.[key];
  if (defaults === undefined || task[key] !== undefined) return;
  // Operator model_params always win over schema-derived defaults.
  const override = modelParams[key];
  if (override !== undefined) return;
  task[key] = defaults;
}

export function buildImageInferenceTask(input: {
  request: GenerationRequest;
  model: string;
  modelParams: Record<string, unknown>;
  /** Request-body properties from the model schema, null when unavailable. */
  properties: Record<string, unknown> | null;
  schemaSource: string;
  schemaFetchedAt: string | null;
  /** Request profile derived from the schema/catalog (v2). */
  profile?: ModelRequestProfile | null;
  fallbackDimensions?: { width: number; height: number } | null;
  maxCount: number;
}): BuiltTask {
  const { request, model, modelParams, properties, schemaSource, schemaFetchedAt } = input;
  const profile = input.profile ?? null;

  const widthBounds = schemaBounds(properties, "width");
  const heightBounds = schemaBounds(properties, "height");
  const fallback = input.fallbackDimensions ?? { width: 1024, height: 1024 };

  const resolution = resolutionFor(request, profile, properties);
  const useDimensions = resolution === null;
  const width = useDimensions ? dimension(request.width, fallback.width, widthBounds) : null;
  const height = useDimensions ? dimension(request.height, fallback.height, heightBounds) : null;

  const schemaNumberResultsMax = (properties?.numberResults as { maximum?: number } | undefined)
    ?.maximum;
  const count = Math.min(
    Math.max(request.count, 1),
    Math.min(input.maxCount, schemaNumberResultsMax ?? input.maxCount),
  );

  const task: Record<string, unknown> = {
    taskType: "imageInference",
    taskUUID: crypto.randomUUID(),
    positivePrompt: request.prompt,
    model,
    numberResults: count,
  };
  if (resolution !== null) {
    task.resolution = resolution;
  } else {
    task.width = width;
    task.height = height;
  }
  // negativePrompt and seed are model capabilities, not universal fields —
  // FLUX.2 Pro and GPT-Image schemas omit them; only send what the model
  // declares (or what the common contract allowed before schemas existed).
  if (request.negativePrompt && (properties === null || "negativePrompt" in properties)) {
    task.negativePrompt = request.negativePrompt;
  }
  if (
    request.seed !== null &&
    request.seed !== undefined &&
    (properties === null || "seed" in properties)
  ) {
    task.seed = request.seed;
  }
  // Reference images: model-dependent input path (inputs.referenceImages vs
  // legacy seedImage) is the caller's concern; here they ride as given.
  if (request.referenceImages !== undefined && request.referenceImages.length > 0) {
    const usesArray =
      properties === null ||
      (properties.inputs as { properties?: Record<string, unknown> } | undefined)?.properties
        ?.referenceImages !== undefined;
    const images = request.referenceImages.map((reference) => reference.dataUri);
    if (usesArray) {
      task.inputs = { referenceImages: images };
    } else {
      task.inputs = { seedImage: images[0] };
    }
  }
  // Model-specific operator passthrough. Unknown keys and out-of-contract
  // values fail HERE with a typed error naming the key — not upstream with
  // an opaque 400.
  for (const [key, value] of Object.entries(modelParams)) {
    if (properties !== null && !(key in properties)) {
      throw new ProviderError(
        "PROVIDER_INVALID_REQUEST",
        `runware: model "${model}" does not accept the configured model_params key "${key}" (schema ${schemaSource}${schemaFetchedAt ? `, fetched ${schemaFetchedAt}` : ""})`,
      );
    }
    if (properties !== null) {
      validateParamValue(key, value, properties[key], key);
    }
    task[key] = value;
  }
  // Schema-derived providerSettings/settings defaults, when the operator
  // has not set (or defaulted) them via model_params above.
  mergeDefaults(task, "providerSettings", profile, modelParams);
  mergeDefaults(task, "settings", profile, modelParams);
  return { task, width, height, count, model };
}
