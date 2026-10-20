// Runware model schema resolver (PCMS-PRE-RESEARCH A3). Runware publishes a
// per-model JSON schema at docs/models/<slug>/schema.json; request fields that
// differ between models (steps/CFGScale on Z-Image, providerSettings.bfl on
// FLUX.2, settings.* on GPT-Image) are read from that schema instead of being
// hardcoded per model. The resolver is best-effort: a docs-endpoint outage
// must never block generation — the in-memory last-known-good stays usable
// (marked stale), and with no cache at all the adapter falls back to the
// common-field defaults.
import { createHash } from "node:crypto";

export interface RunwareModelSchema {
  readonly info: {
    readonly title?: string;
    readonly "x-air-id"?: string;
    readonly "x-model-id"?: string;
    readonly "x-status"?: string;
    readonly "x-capabilities"?: readonly string[];
    readonly "x-pricing"?: {
      readonly currency?: string;
      readonly measured?: readonly { readonly configuration?: string; readonly price?: number }[];
      readonly rates?: readonly {
        readonly amount?: number;
        readonly unit?: string;
        readonly label?: string;
      }[];
    };
  };
  readonly components?: {
    readonly schemas?: {
      readonly RequestBody?: {
        readonly items?: {
          readonly properties?: Record<string, unknown>;
          readonly required?: readonly string[];
        };
      };
    };
  };
}

export interface ResolvedModelSchema {
  readonly schema: RunwareModelSchema | null;
  readonly source: "fetched" | "cache" | "last-known-good" | "none";
  readonly fetchedAt: string | null;
  readonly sha256: string | null;
}

interface CacheEntry {
  readonly slug: string;
  readonly schema: RunwareModelSchema;
  readonly fetchedAt: string;
  readonly sha256: string;
  /** True once TTL expired — still served, but flagged as last-known-good. */
  stale: boolean;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const SCHEMA_HOST_SUFFIX = "runware.ai";

/** Known model page slugs for the first-party supported models. */
const KNOWN_SLUGS: ReadonlyMap<string, string> = new Map([
  ["runware:z-image@turbo", "alibaba-z-image-turbo"],
  ["bfl:5@1", "bfl-flux-2-pro"],
  ["openai:gpt-image@2.5-flare", "openai-gpt-image-2-5-flare"],
]);

export function modelSchemaUrl(model: string, slug?: string | null): string | null {
  const known = slug ?? KNOWN_SLUGS.get(model);
  if (known === undefined || known.length === 0) return null;
  return `https://runware.ai/docs/models/${known}/schema.json`;
}

function parseSchema(text: string, fetchedAt: string): CacheEntry {
  const schema = JSON.parse(text) as RunwareModelSchema;
  return {
    slug: schema.info?.["x-model-id"] ?? "unknown",
    schema,
    fetchedAt,
    sha256: createHash("sha256").update(text).digest("hex"),
    stale: false,
  };
}

const cache = new Map<string, CacheEntry>();

export function resetModelSchemaCacheForTests(): void {
  cache.clear();
}

/** Marks every cached entry stale (test hook: simulates TTL expiry). */
export function expireModelSchemaCacheForTests(): void {
  for (const entry of cache.values()) entry.stale = true;
}

/** Request-body properties for a model, or null when no schema is available. */
export function schemaRequestProperties(
  resolved: ResolvedModelSchema,
): Record<string, unknown> | null {
  const properties = resolved.schema?.components?.schemas?.RequestBody?.items?.properties;
  return typeof properties === "object" && properties !== null ? properties : null;
}

/**
 * Resolves the model schema: fresh fetch → cached entry → stale
 * last-known-good → none. Network failures degrade; they never throw.
 * `slug` is the runware.ai docs page slug (not the air-id).
 */
export async function resolveModelSchema(
  slug: string,
  fetchJson: (url: string, timeoutMs: number) => Promise<unknown>,
): Promise<ResolvedModelSchema> {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) {
    return { schema: null, source: "none", fetchedAt: null, sha256: null };
  }
  const url = `https://runware.ai/docs/models/${slug}/schema.json`;
  const cached = cache.get(slug);
  if (cached !== undefined && !cached.stale) {
    return {
      schema: cached.schema,
      source: "cache",
      fetchedAt: cached.fetchedAt,
      sha256: cached.sha256,
    };
  }
  try {
    const fetched = (await fetchJson(url, FETCH_TIMEOUT_MS)) as RunwareModelSchema;
    const entry = parseSchema(JSON.stringify(fetched), new Date().toISOString());
    cache.set(slug, entry);
    return {
      schema: entry.schema,
      source: "fetched",
      fetchedAt: entry.fetchedAt,
      sha256: entry.sha256,
    };
  } catch {
    if (cached !== undefined) {
      cached.stale = true;
      return {
        schema: cached.schema,
        source: "last-known-good",
        fetchedAt: cached.fetchedAt,
        sha256: cached.sha256,
      };
    }
    return { schema: null, source: "none", fetchedAt: null, sha256: null };
  }
}

/** Host allowlist for the docs endpoint (same pinning style as downloads). */
export function assertSchemaHost(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid schema URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`schema URL must be https: ${url}`);
  }
  if (!(parsed.host === SCHEMA_HOST_SUFFIX || parsed.host.endsWith(`.${SCHEMA_HOST_SUFFIX}`))) {
    throw new Error(`unexpected schema host: ${parsed.host}`);
  }
}
