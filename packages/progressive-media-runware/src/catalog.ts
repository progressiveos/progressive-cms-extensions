// Runware model catalog (Image Generation v2, plan T1.4): setup-time model
// discovery over the native `modelSearch` task plus the docs catalog that
// maps air-ids to schema.json slugs (modelSearch results carry no slug —
// the air↔slug pair only exists on runware.ai/docs/models `data-model`
// attributes). Legacy `queryModels` no longer exists; do not reintroduce it.
// Known API/doc drift (verified 2026-09-28): the docs page promises
// source:"featured" while the API accepts curated|community|merged — the
// API's typed error listing allowedValues is parsed, surfaced, and treated
// as the authority.
import { ProviderError } from "@pcms/media";
import type { ProviderModelSummary } from "@pcms/media";

const _API_BASE = "https://api.runware.ai/v1";
const DOCS_CATALOG_URL = "https://runware.ai/docs/models";
export const DOCS_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export interface RunwareModelSearchQuery {
  readonly search?: string;
  readonly capabilities?: readonly string[];
  readonly source?: "curated" | "community" | "merged";
  readonly limit?: number;
  readonly offset?: number;
}

interface RunwareErrorEntry {
  readonly code?: string;
  readonly message?: string;
  readonly parameter?: string;
  readonly allowedValues?: readonly unknown[];
}

/** POST envelope: tasks come back in `data`, contract errors in `errors`. */
export type RunwarePost = (body: readonly Record<string, unknown>[]) => Promise<{
  data?: readonly (Record<string, unknown> | null)[];
  errors?: readonly RunwareErrorEntry[];
}>;

export function modelSearchTask(query: RunwareModelSearchQuery): Record<string, unknown> {
  return {
    taskType: "modelSearch",
    taskUUID: crypto.randomUUID(),
    ...(query.search === undefined ? {} : { search: query.search }),
    ...(query.capabilities === undefined ? {} : { capabilities: [...query.capabilities] }),
    ...(query.source === undefined ? {} : { source: query.source }),
    ...(query.offset === undefined ? {} : { offset: query.offset }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}

function throwProviderErrors(errors: readonly RunwareErrorEntry[] | undefined): void {
  const first = errors?.[0];
  if (first === undefined) return;
  const allowed =
    first.allowedValues !== undefined && first.allowedValues.length > 0
      ? ` (allowed: ${first.allowedValues.map((value) => JSON.stringify(value)).join(", ")})`
      : "";
  throw new ProviderError(
    "PROVIDER_INVALID_REQUEST",
    `runware modelSearch failed: ${first.code ?? "unknown"} — ${first.message ?? "no message"}${allowed}`,
  );
}

interface ModelSearchResultItem {
  readonly air?: string;
  readonly name?: string;
  readonly capabilities?: readonly string[];
  readonly heroImage?: string;
  readonly status?: string;
  readonly source?: string;
  readonly category?: string;
}

export interface ModelSearchPage {
  readonly totalResults: number;
  readonly results: readonly ProviderModelSummary[];
}

export async function runwareModelSearch(
  post: RunwarePost,
  query: RunwareModelSearchQuery,
): Promise<ModelSearchPage> {
  const response = await post([modelSearchTask(query)]);
  throwProviderErrors(response.errors);
  const taskResult = (response.data ?? []).find((entry) => entry?.taskType === "modelSearch");
  if (taskResult === undefined || taskResult === null) {
    throw new ProviderError("PROVIDER_FAILED", "runware modelSearch returned no task result");
  }
  const items = Array.isArray(taskResult.results) ? taskResult.results : [];
  const results: ProviderModelSummary[] = [];
  for (const item of items as readonly ModelSearchResultItem[]) {
    if (typeof item.air !== "string" || item.air.length === 0) continue;
    results.push({
      model: item.air,
      displayName: item.name ?? item.air,
      capabilities: Array.isArray(item.capabilities) ? item.capabilities : [],
      thumbnail: typeof item.heroImage === "string" ? item.heroImage : null,
      status: null,
    });
  }
  return {
    totalResults:
      typeof taskResult.totalResults === "number" ? taskResult.totalResults : results.length,
    results,
  };
}

// ---- docs catalog (air-id ↔ schema slug) -----------------------------------

export interface DocsCatalogEntry {
  readonly air: string;
  readonly slug: string;
  readonly title: string | null;
  readonly status: string | null;
  readonly capabilities: readonly string[];
}

/** Parses `data-model="…"` attributes from the docs models page HTML. */
export function parseDocsCatalog(html: string): DocsCatalogEntry[] {
  const entries: DocsCatalogEntry[] = [];
  const attributePattern = /data-model="([^"]+)"/g;
  for (const match of html.matchAll(attributePattern)) {
    const raw = match[1];
    if (raw === undefined) continue;
    try {
      const decoded = JSON.parse(
        raw.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&"),
      ) as {
        model?: string;
        air?: string;
        title?: string;
        status?: string;
        capabilities?: readonly string[];
      };
      if (typeof decoded.air !== "string" || typeof decoded.model !== "string") continue;
      entries.push({
        air: decoded.air,
        slug: decoded.model,
        title: typeof decoded.title === "string" ? decoded.title : null,
        status: typeof decoded.status === "string" ? decoded.status : null,
        capabilities: Array.isArray(decoded.capabilities) ? decoded.capabilities : [],
      });
    } catch {
      // A malformed attribute must never break the whole catalog.
    }
  }
  return entries;
}

export interface DocsCatalog {
  readonly entries: readonly DocsCatalogEntry[];
  readonly fetchedAt: string;
}

export async function fetchDocsCatalog(
  fetchText: (url: string) => Promise<string>,
  previous?: DocsCatalog,
): Promise<DocsCatalog> {
  const html = await fetchText(DOCS_CATALOG_URL);
  const entries = parseDocsCatalog(html);
  if (entries.length === 0) {
    // Keep the previous catalog on an unusable response — stale beats empty.
    if (previous !== undefined && previous.entries.length > 0) return previous;
    throw new ProviderError("PROVIDER_FAILED", "runware docs catalog parse produced no models");
  }
  return { entries, fetchedAt: new Date().toISOString() };
}

export function slugForAir(catalog: DocsCatalog | null, air: string): string | null {
  return catalog?.entries.find((entry) => entry.air === air)?.slug ?? null;
}
