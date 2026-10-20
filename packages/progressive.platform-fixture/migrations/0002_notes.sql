-- PREPUBLIC §5: guest mutation surface — notes left by site visitors.
CREATE TABLE platform_fixture_notes (
    id         text        PRIMARY KEY,
    guest_id   text        NOT NULL,
    slug       text        NOT NULL,
    body       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_fixture_notes_slug_idx ON platform_fixture_notes (slug);
