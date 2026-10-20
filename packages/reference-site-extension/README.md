# Reference Site Extension (PCMS-EXT-T018)

A complete, working example of a site-specific extension built only on the
public M14 extension contracts — **client logic is added without patching
Core**. Use it as the template for real site modules
(`Progressive_CMS_Extensions_Compatibility_Updates_v1_Spec.md` §34).

## What it demonstrates

| Piece | Where | Notes |
|---|---|---|
| Manifest v1 | `manifest.json` | validated by `@pcms/extensions`; capability `requires`/`provides`, config schema, migration declaration, registrations |
| Config | `manifest.json` → `config_schema` | typed; secret slots would use `format: "secret-ref"` |
| Namespaced migration | `migrations/0001_create_notes.sql` | extension-owned ledger (never the core `14xx` range); table prefix is the deterministic form of the extension id |
| Event subscription | `src/index.ts` `onEntryPublished` | consumes the M07 `EntryPublished` fact through the shared worker fanout; idempotent (consumption ledger + primary key) |
| Explicit validator point | `src/index.ts` `validatePublication` | typed contribution to the `publication` validator point — no monkey hooks |
| Data policy | `manifest.json` `data_policy: "retain"` | uninstall never drops the notes table |

## Deployment model (trusted artifacts)

The extension is a **trusted deployment artifact**, not a database record
and not an Admin upload:

```ts
import { createExtensionCatalog, defineExtensionArtifact } from "@pcms/extensions";
import { createReferenceSiteExtensionModule } from "./src/index.js"; // trusted path binds the module
import manifest from "./manifest.json";

const catalog = createExtensionCatalog();
catalog.register(
  defineExtensionArtifact({
    manifest,
    module: createReferenceSiteExtensionModule({ pool }),
    migrationsDir: "extensions/reference-site-extension/migrations",
  }),
);
```

`defineExtensionArtifact` is the only supported path from a manifest
document to a catalog artifact. There is no API that loads code from a
path, the database or an Admin action.

## Lifecycle (vertical slice)

`deploy → install (applies the extension migration) → enable → capability
visible → event/validator contributions active → disable (contributions
gone) → uninstall with retain (data preserved)`. The executable proof lives
in `tests/extensions/reference-site-extension.test.ts`.

## Boundaries

* imports: `@pcms/extensions` public surface and `@pcms/core` types only;
* DB: only its own `com_example_reference_site_*` tables — Core tables are
  never modified (Core-table mutation is not a documented API);
* runtime context: the extension receives a pool handle and its own config;
  no secret store, no environment, no actor privileges;
* versions: SemVer; the extension id is a stable public identity.
