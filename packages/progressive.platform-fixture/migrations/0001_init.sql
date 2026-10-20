CREATE TABLE IF NOT EXISTS platform_fixture_items (
    slug       text        PRIMARY KEY,
    title      text        NOT NULL,
    media_id   text        NULL,
    generation integer     NOT NULL DEFAULT 1
);
