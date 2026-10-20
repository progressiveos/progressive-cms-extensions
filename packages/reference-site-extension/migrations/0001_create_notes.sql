-- Reference site extension state (PCMS-EXT-T018).
-- Namespace policy: every table owned by this extension is prefixed with
-- the deterministic, collision-safe form of its extension id
-- ("com.example.reference-site" → "com_example_reference_site_").
-- Extension-owned tables never touch Core tables.

CREATE TABLE IF NOT EXISTS com_example_reference_site_notes (
  id         uuid        PRIMARY KEY,
  entry_id   text        NOT NULL,
  note       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
