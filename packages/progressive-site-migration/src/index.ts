// Progressive Site Migration — trusted first-party artifact with no runtime
// registrations of its own: the migration machinery is engine-side
// (packages/routing/src/import.ts + packages/routing/src/migration/modx3.ts,
// surfaced over REST/CLI/MCP). The artifact exists so the capability is
// visible and installable in the Admin "Расширения" section with its
// permission set declared, and so operators have one place describing the
// workflow. See docs/migration/modx3-site-migration.md.

/** Declares the surface this artifact's permissions back; nothing to call. */
export const SITE_MIGRATION_EXTENSION = {
  id: "progressive.site-migration",
  surfaces: {
    rest: ["POST /routing/redirect-imports/validate", "POST /routing/redirect-imports/apply"],
    cli: ["cms redirects validate", "cms redirects apply"],
    mcp: ["cms_validate_redirect_import", "cms_apply_redirect_import", "cms_import_media_url"],
    connector: ["scripts/migration/modx3-redirects.mts"],
  },
} as const;
