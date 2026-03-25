---
name: sync-guide
description: Comprehensive guide to building Notion Workers syncs — covers modes (replace vs incremental), pagination, bi-modal cursor design (backfill vs delta), backfill-to-delta transitions, consistency buffers, deletion strategies, and common pitfalls. Auto-loads when sync-related work is detected.
user-invocable: false
---

## What is a Sync?

A sync is a recurring `execute` function that returns data changes to populate a Notion database. The runtime calls `execute` in a loop:

```ts
worker.sync("mySync", {
  primaryKeyProperty: "ID",
  schema: {
    defaultName: "My Data",
    properties: {
      Name: Schema.title(),
      ID: Schema.richText(),
    },
  },
  execute: async (state, { notion }) => ({
    changes: [
      { type: "upsert", key: "1", properties: { Name: Builder.title("Item 1"), ID: Builder.richText("1") } },
    ],
    hasMore: false,
    nextState: undefined,
  }),
});
```

Each call returns `{ changes, hasMore, nextState }`. If `hasMore` is `true`, the runtime calls `execute` again with `nextState`. This continues until `hasMore` is `false`, completing a **cycle**. The next cycle begins at the scheduled interval with the state from the end of the previous cycle.

**Imports:**
```ts
import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
```

## Decision Framework

### Step 1: Choose a Mode

| Condition | Mode |
|---|---|
| Total records < 10k | `replace` |
| API has no `updated_at` or change feed | `replace` |
| Records > 10k AND API has good change tracking | `incremental` |

**`replace`**: Each cycle returns the full dataset. After the final `hasMore: false`, any records not seen during that cycle are deleted automatically. Simpler — no backfill/delta distinction.

**`incremental`**: Each cycle returns only changes since the last run. The cursor persists across cycles indefinitely. Deletions must be explicit via `{ type: "delete", key: "..." }`.

### Step 2: Understand Your API's Pagination

Most APIs require paginating through results. Return batches of ~100 changes. Returning too many changes in one `execute` call will fail.

**Backfill pagination** (initial full dataset load):
1. **Opaque cursor token** — GraphQL `endCursor`, Stripe `starting_after`
2. **Page number / offset** — `?page=N&limit=100`
3. **Keyset (timestamp + id)** — `WHERE created_at > X OR (created_at = X AND id > Y)` — the gold standard for timestamp-sorted mutable data

**Delta pagination** (subsequent change-only loads, incremental mode):
1. **Timestamp cursor** — `?updated_since=<cursor>` with consistency buffer
2. **Keyset on updated_at + id** — same keyset pattern on the modification timestamp
3. **Event/changelog feed** — `GET /events?after=<eventId>`
4. **Same opaque cursor** — when the API sorts by `updated_at`, the backfill cursor works for delta too

### Step 3: Understand the Bi-Modal Nature of Syncs

In incremental mode, a sync is a state machine with two phases:

1. **Backfill** (first run): paginate through the entire dataset
2. **Delta** (subsequent runs): fetch only what changed since the last run

These phases often use different pagination strategies and different cursor shapes. The state should be a discriminated union:

```ts
type State =
  | { phase: "backfill"; cursor: string | null; backfillStartedAt: string }
  | { phase: "delta"; cursor: string };
```

In replace mode, there is no backfill/delta distinction. Each cycle re-fetches everything. State is just within-cycle pagination.

### Step 4: Handle the Transition and Edge Cases

**Backfill-to-delta transition** — The most common source of bugs. Three strategies:
1. **Event anchor:** Before backfill starts (first `execute` call), capture the latest event ID. When backfill completes, seed delta from that anchor.
2. **Timestamp overlap:** Seed delta cursor to `backfillStartedAt - 5 minutes` to avoid missing records that arrived during the backfill.
3. **Cursor carry-forward:** If backfill and delta use the same cursor type (e.g., API sorts by `updated_at`), just keep the cursor.

**Consistency buffer** — APIs tend to be eventually consistent. A record that was just written or updated may not appear in query results immediately. Since the cursor never resets in incremental mode, if it advances past a record that hasn't been indexed yet, that record is skipped permanently. Lag the cursor 10-60 seconds behind "now":

```ts
const bufferMs = 15_000;
const maxCursor = new Date(Date.now() - bufferMs).toISOString();
const nextCursor = records.length > 0
  ? min(lastRecord.updatedAt, maxCursor)
  : maxCursor;
```

**Deletion strategies:**
1. **Replace mode:** free — unseen records auto-delete each cycle
2. **Incremental with delete API:** emit `{ type: "delete", key }` markers. If the delete signal comes from a separate endpoint (audit log, archived filter), use the **flip-flop pattern**: run the main delta stream until caught up (`hasMore: false`), then switch to the delete stream for a cycle, then back. Both cursors persist in state independently.
3. **No delete API:** consider replace mode, or accept stale records

## Replace Mode

Simple: fetch everything, return it all, let the runtime handle deletes.

```ts
worker.sync("mySync", {
  mode: "replace",
  primaryKeyProperty: "ID",
  schema: {
    defaultName: "Records",
    properties: { Name: Schema.title(), ID: Schema.richText() },
  },
  execute: async (state) => {
    const page = state?.page ?? 1;
    const { items, totalPages } = await fetchPage(page, 100);
    const hasMore = page < totalPages;
    return {
      changes: items.map((item) => ({
        type: "upsert" as const,
        key: item.id,
        properties: { Name: Builder.title(item.name), ID: Builder.richText(item.id) },
      })),
      hasMore,
      nextState: hasMore ? { page: page + 1 } : undefined,
    };
  },
});
```

See `examples/replace-simple.ts` and `examples/replace-paginated.ts` for complete working examples.

## Incremental Mode

The execute function must handle both phases:

```ts
worker.sync("mySync", {
  mode: "incremental",
  primaryKeyProperty: "ID",
  schema: {
    defaultName: "Records",
    properties: { Name: Schema.title(), ID: Schema.richText() },
  },
  execute: async (state: State | undefined) => {
    if (!state || state.phase === "backfill") {
      // Backfill: paginate full dataset
      const startedAt = state?.backfillStartedAt ?? new Date().toISOString();
      const { items, nextCursor } = await fetchAll(state?.cursor);
      const done = !nextCursor;

      return {
        changes: items.map(toUpsert),
        hasMore: !done,
        nextState: done
          ? { phase: "delta", cursor: subtractMinutes(startedAt, 5) }
          : { phase: "backfill", cursor: nextCursor, backfillStartedAt: startedAt },
      };
    }

    // Delta: fetch only changes since cursor
    const bufferTs = new Date(Date.now() - 15_000).toISOString();
    const { items, nextCursor } = await fetchChanges(state.cursor);
    const done = !nextCursor;

    return {
      changes: items.map(toUpsert),
      hasMore: !done,
      nextState: {
        phase: "delta",
        cursor: done ? min(nextCursor ?? state.cursor, bufferTs) : nextCursor,
      },
    };
  },
});
```

See `examples/incremental-basic.ts`, `examples/incremental-bimodal.ts`, and `examples/incremental-events.ts` for complete patterns.

## Schema Reference

Define the Notion database shape with `Schema` types and build values with `Builder`:

| Schema type | Builder value | Notes |
|---|---|---|
| `Schema.title()` | `Builder.title("text")` | Primary display field. Every schema needs exactly one. |
| `Schema.richText()` | `Builder.richText("text")` | Text content, IDs |
| `Schema.url()` | `Builder.url("https://...")` | URL field |
| `Schema.email()` | `Builder.email("a@b.com")` | Email field |
| `Schema.phoneNumber()` | `Builder.phoneNumber("+1...")` | Phone field |
| `Schema.checkbox()` | `Builder.checkbox(true)` | Boolean |
| `Schema.file()` | `Builder.file("https://...", "name")` | File URL + optional display name |
| `Schema.number()` | `Builder.number(42)` | Number. Optional format: `Schema.number("percent")` |
| `Schema.date()` | `Builder.date("2024-01-15")` | Date (YYYY-MM-DD). Also: `Builder.dateTime("2024-01-15T10:30:00Z")`, `Builder.dateRange(start, end)` |
| `Schema.select([...])` | `Builder.select("Option A")` | Single select. Define options: `Schema.select([{ name: "A" }, { name: "B" }])` |
| `Schema.multiSelect([...])` | `Builder.multiSelect("A", "B")` | Multi select |
| `Schema.status(...)` | `Builder.status("Done")` | Status with groups |
| `Schema.people()` | `Builder.people("email@co.com")` | People by email |
| `Schema.place()` | `Builder.place({ latitude, longitude })` | Geographic location |
| `Schema.relation("syncKey")` | `[Builder.relation("pk")]` | Relation. Value is an **array**. |

Relations support two-way config:
```ts
Schema.relation("otherSync", { twoWay: true, relatedPropertyName: "Back Link" })
```

Row-level icons and page content:
```ts
changes: [{
  type: "upsert", key: "1",
  properties: { ... },
  icon: Builder.emojiIcon("🎯"),               // or Builder.notionIcon("rocket", "blue")
  pageContentMarkdown: "## Details\nSome text", // Markdown body for the page
}]
```

## Common Mistakes

1. **Treating the sync as single-mode** — writing one cursor strategy for both backfill and delta. These are typically different strategies with different cursor shapes.
2. **Missing the backfill-to-delta transition** — the delta cursor must be seeded from a marker captured *before* the backfill started. Otherwise changes during backfill are lost permanently.
3. **Not understanding state persistence** — in incremental mode, the cursor never resets. The next cycle starts exactly where the last one left off. Records behind the cursor are never re-fetched. A buffer that's too small or a transition that's off by one causes permanent data loss.
4. **Not paginating** — returning too many changes at once. Start with batches of ~100.
5. **Using replace mode for large datasets** (>10k records)
6. **Cursor that doesn't advance** — infinite loop. Ensure `nextState` changes between iterations.
7. **Missing consistency buffer** on eventually consistent APIs — the cursor will permanently skip records not yet indexed.
8. **Forgetting first-run handling** — `state` is `undefined` on first call. Use `state?.cursor ?? null`.

## CLI Commands for Sync Development

```shell
# Deploy
ntn workers deploy

# Dry-run (test without writing)
ntn workers sync dry-run <key>
ntn workers sync dry-run <key> --context '<json>'  # continue pagination

# Force a sync run
ntn workers sync force-run <key>

# Check sync status
ntn workers sync status

# View run logs
ntn workers runs list
ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}

# Reset state (full re-backfill)
ntn workers sync state reset <key>

# Manage secrets
ntn workers env set KEY=value
ntn workers env push
```

## API Patterns Reference

See [api-pagination-patterns.md](./api-pagination-patterns.md) for detailed strategies drawn from production syncs with Salesforce, Stripe, HubSpot, GitHub, and ServiceNow.
