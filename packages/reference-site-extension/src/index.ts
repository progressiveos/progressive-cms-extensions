// Reference site extension (PCMS-EXT-T018) — the executable artifact of a
// trusted deployment. It imports ONLY the public versioned contracts of
// @pcms/extensions (plus @pcms/core types for the pool), never private
// paths of any subsystem: site custom logic is added without patching Core.
//
// The exported factory is called once by the composition root (the trusted
// deployment path) with the dependencies the extension is allowed to see —
// its own pool handle, nothing else. No internal service locator, no global
// mutable hooks, no DB superuser, no secrets beyond what the operator puts
// into the extension's own namespaced config.
import type { DbPool } from "@pcms/core";
import type { ExtensionEventView } from "@pcms/extensions";

export interface ReferenceSiteExtensionConfig {
  readonly note_template?: string;
}

export interface PublicationValidationInput {
  readonly candidates: readonly {
    readonly candidateIndex?: number;
    readonly title?: string;
  }[];
}

export interface PublicationValidationIssue {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly candidateIndex?: number;
}

export interface ReferenceSiteExtensionHandlers {
  /** Subscription handler for EntryPublished — writes a note in its own table. */
  readonly onEntryPublished: (event: ExtensionEventView) => Promise<void>;
  /**
   * Synchronous contribution to the "publication" validator point: a plain
   * (input) → issues function; the registration descriptor in the manifest
   * supplies the identity.
   */
  readonly validatePublication: (
    input: PublicationValidationInput,
  ) => readonly PublicationValidationIssue[];
}

export function createReferenceSiteExtensionModule(input: {
  readonly pool: DbPool;
  readonly config?: ReferenceSiteExtensionConfig;
}): ReferenceSiteExtensionHandlers {
  const { pool } = input;
  const noteTemplate = input.config?.note_template ?? "published: {title}";

  const onEntryPublished = async (event: ExtensionEventView): Promise<void> => {
    const payload = (event.payload ?? {}) as { title?: string };
    const title = typeof payload.title === "string" ? payload.title : "";
    // Idempotent by event id: the consumption ledger guarantees one call,
    // and the primary key below makes even a ledger-bypass replay harmless.
    const note = noteTemplate.replaceAll("{title}", title);
    await pool.query(
      `INSERT INTO com_example_reference_site_notes (id, entry_id, note)
       VALUES (($1::text)::uuid, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [event.id, event.aggregateId, note],
    );
  };

  const validatePublication = (
    input: PublicationValidationInput,
  ): readonly PublicationValidationIssue[] =>
    input.candidates
      .filter((candidate) => (candidate.title ?? "").trim() === "")
      .map((candidate) => ({
        code: "REFERENCE_SITE_TITLE_REQUIRED",
        severity: "warning" as const,
        message: "site policy: published entries should carry a title",
        ...(candidate.candidateIndex === undefined
          ? {}
          : { candidateIndex: candidate.candidateIndex }),
      }));

  return { onEntryPublished, validatePublication };
}
