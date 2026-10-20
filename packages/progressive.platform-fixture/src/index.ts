// Platform Surface Contract fixture (CORE-SHOP-01 acceptance; ADR-0018).
// Data lives in the package's own table so the transaction/audit/outbox and
// media-delete gates are exercised for real. Mutations go through
// platform.transaction() — SQL, audit and outbox join ONE transaction.
import type { ExtensionTransactionContext } from "@pcms/extensions";

interface ItemRow extends Record<string, unknown> {
  slug: string;
  title: string;
  media_id: string | null;
  generation: number;
}

const ENTITY_TYPE = "progressive.platform-fixture/item";
const SITE = { key: "default", defaultLocale: "en" };

export async function widgetPage(call: {
  params: { slug: string };
  locale: string;
  canonicalUrl: string;
  canonicalPath: string;
  platform: {
    db: {
      query: <T extends Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ) => Promise<{ rows: T[] }>;
    };
  };
}) {
  const found = await call.platform.db.query<ItemRow>(
    "SELECT slug, title, media_id, generation FROM platform_fixture_items WHERE slug = $1",
    [call.params.slug],
  );
  const item = found.rows[0];
  if (item === undefined) return { status: 404 };
  return {
    status: 200,
    view: {
      id: "widget",
      model: { slug: item.slug, title: item.title, locale: call.locale },
      head: {
        title: item.title,
        robots: "index, follow",
        json_ld: [
          JSON.stringify({
            "@type": "Thing",
            name: item.title,
            url: `${call.canonicalUrl}${item.slug}/`,
          }),
        ],
      },
      media_ids: item.media_id === null ? [] : [item.media_id],
    },
  };
}

async function upsertItem(
  tx: ExtensionTransactionContext,
  input: { slug: string; title: string; media_id?: string | undefined },
): Promise<void> {
  await tx.query(
    `INSERT INTO platform_fixture_items (slug, title, media_id, generation)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (slug) DO UPDATE
       SET title = EXCLUDED.title, media_id = EXCLUDED.media_id,
           generation = platform_fixture_items.generation + 1`,
    [input.slug, input.title, input.media_id ?? null],
  );
  tx.audit("PLATFORM_FIXTURE_ITEM_UPSERTED", { type: "extension_entity", id: input.slug }, {
    title: input.title,
  });
  tx.outbox.append(`${"progressive.platform-fixture"}/EntityChanged`, {
    entityType: ENTITY_TYPE,
    entityId: input.slug,
    generation: 1,
  });
}

export async function createWidget(call: {
  body?: unknown;
  platform: {
    authorize: (permission: string) => Promise<void>;
    transaction: <R>(run: (tx: ExtensionTransactionContext) => Promise<R>) => Promise<R>;
  };
}) {
  const input = (call.body ?? {}) as { slug?: string; title?: string; media_id?: string };
  if (typeof input.slug !== "string" || typeof input.title !== "string") {
    return { status: 422, json: { error: "slug and title are required" } };
  }
  await call.platform.authorize("platform.test.write");
  const result = await call.platform.transaction(async (tx) => {
    await upsertItem(tx, {
      slug: input.slug as string,
      title: input.title as string,
      ...(input.media_id === undefined ? {} : { media_id: input.media_id }),
    });
    return { created: input.slug };
  });
  return { status: 200, json: result };
}

export async function createItemOperation(call: {
  input: { slug: string; title: string; media_id?: string; fail_after_write?: boolean };
  platform: { transaction: <R>(run: (tx: ExtensionTransactionContext) => Promise<R>) => Promise<R> };
}) {
  const input = call.input;
  return call.platform.transaction(async (tx) => {
    await upsertItem(tx, {
      slug: input.slug,
      title: input.title,
      ...(input.media_id === undefined ? {} : { media_id: input.media_id }),
    });
    if (input.fail_after_write === true) {
      throw new Error("FIXTURE_INTENTIONAL_ROLLBACK");
    }
    return { created: input.slug };
  });
}

export async function sitemapWidgets(ctx: {
  platform: {
    db: {
      query: <T extends Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ) => Promise<{ rows: T[] }>;
    };
  };
}) {
  const rows = await ctx.platform.db.query<ItemRow>(
    "SELECT slug FROM platform_fixture_items ORDER BY slug",
  );
  return {
    items: rows.rows.map((row) => ({
      path: `/widgets/${row.slug}/`,
      lastmod: new Date().toISOString(),
      noindex: false,
    })),
    cursor: null,
  };
}

/** Public guest mutation (PREPUBLIC §5): the platform enforces origin,
 * rate limits, guest identity and durable Idempotency-Key replay; the
 * handler validates input and writes through platform.transaction. */
export async function createNote(call: {
  params: { slug: string };
  body?: unknown;
  guestId: string | null;
  actor: { kind: string; id: string };
  platform: {
    transaction: <R>(
      run: (tx: {
        query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
        audit: (action: string, subject: { type: string; id: string }, metadata?: unknown) => void;
      }) => Promise<R>,
    ) => Promise<R>;
  };
}) {
  const input = (call.body ?? {}) as { body?: unknown };
  if (typeof input.body !== "string" || input.body.trim() === "" || input.body.length > 500) {
    return { status: 422, json: { error: "body is required (1..500 chars)" } };
  }
  const identity = call.guestId ?? `anon-${call.actor.id}`;
  return call.platform.transaction(async (tx) => {
    const noteId = `note-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await tx.query(
      "INSERT INTO platform_fixture_notes (id, guest_id, slug, body) VALUES ($1, $2, $3, $4)",
      [noteId, identity, call.params.slug, input.body as string],
    );
    // Audit/correlation (PREPUBLIC §5): the guest mutation leaves a GUEST
    // actor row joined to the same transaction as the write.
    tx.audit(
      "PLATFORM_FIXTURE_NOTE_CREATED",
      { type: "extension_entity", id: noteId },
      { slug: call.params.slug, guest: identity },
    );
    return { status: 200, json: { note_id: noteId, slug: call.params.slug, guest: identity } };
  });
}

/** Durable background job (PREPUBLIC §4): bumps the item generation inside
 * platform.transaction — proof that extension handlers execute on the SHARED
 * worker queue with retries and versioned payloads. */
export async function touchItemJob(
  ctx: {
    platform: {
    db: {
      query: <T extends Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ) => Promise<{ rows: T[] }>;
    };
    transaction: <R>(run: (tx: { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<R>) => Promise<R>;
  };
  },
  payload: { slug?: unknown },
  job: { attempts: number },
) {
  const slug = typeof payload?.slug === "string" ? payload.slug : "";
  if (slug === "") throw new Error("FIXTURE_JOB_PAYLOAD_INVALID: slug is required (v1 payload)");
  return ctx.platform.transaction(async (tx) => {
    const updated = await tx.query(
      "UPDATE platform_fixture_items SET generation = generation + 1 WHERE slug = $1 RETURNING slug, generation",
      [slug],
    );
    const row = updated.rows[0];
    if (row === undefined) throw new Error(`FIXTURE_JOB_TARGET_MISSING: ${slug}`);
    return { slug: row.slug as string, generation: row.generation as number, attempts: job.attempts };
  });
}

/** Admin operation: enqueue the touch-item job through platform.jobs. */
export async function enqueueTouchItem(call: {
  input: { slug?: string; idempotency_key?: string; delay_seconds?: number };
  platform: {
    authorize: (permission: string) => Promise<void>;
    jobs: {
      enqueue: (input: {
        job: string;
        payload?: unknown;
        idempotencyKey?: string;
        runAt?: Date;
      }) => Promise<void>;
    };
  };
}) {
  const slug = call.input.slug ?? "";
  if (slug === "") return { status: 422, json: { error: "slug is required" } };
  await call.platform.authorize("platform.test.write");
  await call.platform.jobs.enqueue({
    job: "touch-item",
    payload: { slug },
    ...(call.input.idempotency_key === undefined ? {} : { idempotencyKey: call.input.idempotency_key }),
    ...(call.input.delay_seconds === undefined
      ? {}
      : { runAt: new Date(Date.now() + call.input.delay_seconds * 1000) }),
  });
  return { enqueued: slug, job: "touch-item" };
}

/** Full-reindex enumeration (PREPUBLIC §2 Source Contract): cursor/batch
 * page of ids — cursor = last slug while the page filled up, null = done. */
export async function searchItemIds(
  ctx: {
    platform: {
    db: {
      query: <T extends Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ) => Promise<{ rows: T[] }>;
    };
  };
  },
  cursor: string | null,
  limit: number,
) {
  const rows = await ctx.platform.db.query<{ slug: string }>(
    "SELECT slug FROM platform_fixture_items WHERE ($1::text IS NULL OR slug > $1) ORDER BY slug LIMIT $2",
    [cursor, limit],
  );
  const ids = rows.rows.map((row) => row.slug);
  return {
    ids,
    cursor: ids.length > 0 && ids.length >= limit ? (ids[ids.length - 1] as string) : null,
  };
}

export async function searchItem(
  ctx: {
    platform: {
    db: {
      query: <T extends Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ) => Promise<{ rows: T[] }>;
    };
  };
  },
  entityId: string,
) {
  const found = await ctx.platform.db.query<ItemRow>(
    "SELECT slug, title, generation FROM platform_fixture_items WHERE slug = $1",
    [entityId],
  );
  const item = found.rows[0];
  if (item === undefined) return null;
  return {
    entity_type: ENTITY_TYPE,
    entity_id: item.slug,
    context: "default",
    site_id: SITE.key,
    locale: SITE.defaultLocale === "x-default" ? "en" : SITE.defaultLocale,
    content_type: "platform-fixture/item",
    revision_id: `fixture-${item.generation}`,
    generation: item.generation,
    title: item.title,
    summary: `Fixture widget ${item.slug}`,
    structured_text: item.title,
    body_text: item.title,
    aux_text: "",
    route: `/widgets/${item.slug}/`,
    published_at: new Date().toISOString(),
    modified_at: new Date().toISOString(),
  };
}

export async function mediaUsage(
  ctx: {
    platform: {
    db: {
      query: <T extends Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ) => Promise<{ rows: T[] }>;
    };
  };
  },
  mediaId: string,
) {
  const rows = await ctx.platform.db.query<ItemRow>(
    "SELECT slug FROM platform_fixture_items WHERE media_id = $1",
    [mediaId],
  );
  return rows.rows.map((row) => ({
    source_id: `${ENTITY_TYPE}/${row.slug}`,
    source_path: "/media_id",
  }));
}
