# API Pagination & Cursor Strategy Reference

Strategies drawn from production syncs with Salesforce, Stripe, HubSpot, GitHub, and ServiceNow. Intended as a reference for building Notion Workers syncs.

---

## The Universal Contract

```
execute(state) → { changes, hasMore, nextState }
```

The cursor lives in `nextState`. The runtime calls `execute` again with that state until `hasMore` is `false`, completing a **cycle**. The next cycle starts with the state from the end of the previous cycle.

**Critical:** In incremental mode, state is never reset. The cursor persists across cycles indefinitely. When a cycle ends (`hasMore: false`), the next cycle begins with the same `nextState`. This means:
- Records behind the cursor are never re-fetched (unless you explicitly move the cursor backwards)
- A consistency buffer isn't about "catching up next time" — it's about ensuring the cursor never advances past records that haven't been indexed by the source API yet
- If a record is missed because the cursor passed it, it's missed permanently

In replace mode, the runtime handles deletion detection. Each cycle must return the complete dataset. State is only used for within-cycle pagination and is effectively reset between cycles.

---

## Source 1: Salesforce

**API type:** REST + SOQL queries
**Pagination:** Keyset on `(timestamp, id)`

### Backfill

Uses `ORDER BY CreatedDate, Id LIMIT N` with a keyset `WHERE` clause:

```sql
WHERE CreatedDate > :cursorTimestamp
   OR (CreatedDate = :cursorTimestamp AND Id > :cursorId)
```

This is the gold standard for paginating mutable datasets by timestamp. The `Id` column breaks ties when multiple records share the same `CreatedDate`, preventing both skips and duplicates.

### Delta (Incremental)

Identical keyset pattern but on `SystemModstamp` (Salesforce's last-modified timestamp) instead of `CreatedDate`. The cursor is buffered to **at most 15 seconds behind "now"** to guard against Salesforce's eventual consistency. This buffer is critical because the cursor never goes backwards — any record not yet visible when the cursor passes it is lost permanently.

### Cursor Design

Two separate cursor shapes, unified in a discriminated state:

```ts
type SalesforceState =
  | { phase: "backfill"; cursorTimestamp: string | null; cursorId: string | null; backfillStartedAt: string }
  | { phase: "delta"; cursorTimestamp: string; cursorId: string };
```

The `backfillStartedAt` marks when the backfill *began*. When the backfill completes, the delta cursor is initialized to `backfillStartedAt - 5 minutes`, ensuring overlap. This prevents the gap between "last record seen during backfill" and "first change detected by delta."

### Gotcha: Unreliable `done` Flag

Salesforce returns a `done` boolean in query results. It lies. The production code requires *both* `done == true` AND `records.length < limit` before treating a page as the last one. Neither signal alone is trustworthy.

### Workers Mapping

```ts
worker.sync("salesforceSync", {
  mode: "incremental",
  execute: async (state: SalesforceState | undefined) => {
    const phase = state?.phase ?? "backfill";
    const backfillStartedAt = state?.backfillStartedAt ?? new Date().toISOString();

    if (phase === "backfill") {
      // Keyset query: WHERE CreatedDate > X OR (CreatedDate = X AND Id > Y)
      // ORDER BY CreatedDate, Id LIMIT 100
      const records = await querySOQL(state?.cursorTimestamp, state?.cursorId);
      const last = records[records.length - 1];
      const done = records.length < 100;

      return {
        changes: records.map(toUpsert),
        hasMore: !done,
        // When backfill is done, transition to delta with overlap
        nextState: done
          ? { phase: "delta", cursorTimestamp: subtractMinutes(backfillStartedAt, 5), cursorId: "" }
          : { phase: "backfill", cursorTimestamp: last.CreatedDate, cursorId: last.Id, backfillStartedAt },
      };
    }

    // Delta: same keyset but on SystemModstamp, with 15s consistency buffer
    const bufferTs = new Date(Date.now() - 15_000).toISOString();
    const records = await querySOQL(state.cursorTimestamp, state.cursorId, "SystemModstamp");
    const last = records[records.length - 1];
    const done = records.length < 100;

    return {
      changes: records.map(toUpsert),
      hasMore: !done,
      nextState: {
        phase: "delta",
        cursorTimestamp: done ? min(last?.SystemModstamp ?? state.cursorTimestamp, bufferTs) : last.SystemModstamp,
        cursorId: last?.Id ?? state.cursorId,
      },
    };
  },
});
```

---

## Source 2: Stripe

**API type:** REST with cursor-based list pagination
**Pagination:** `starting_after` / `ending_before` + `has_more`

### Backfill

Standard Stripe list pagination: `GET /v1/customers?starting_after=cus_xyz&limit=100`. The cursor is the `id` of the last object on the page. Stripe's `has_more` boolean is reliable.

**Critical pre-step:** Before fetching any data page, the backfill captures the ID of the most recent event from `GET /v1/events?limit=1`. This "event anchor" is saved in the cursor so the delta phase knows exactly where to start.

### Delta (Event-Based)

Reads from `GET /v1/events` in reverse-chronological order. The cursor is an event ID. Events are filtered to only those at least **10 seconds old** — events younger than 10s are skipped. If all events on a page are too recent, the cursor does not advance. Since the cursor never resets, this buffer ensures the cursor doesn't permanently skip past late-arriving events.

### Nested Object Extraction

Stripe objects contain nested sub-objects (e.g., a `PaymentIntent` contains `payment_method`). The sync recursively walks payloads and extracts sub-objects. If a list field has `has_more: true`, it paginates that sub-list inline. This means one "page" of the sync may trigger many HTTP requests.

### Cursor Design

```ts
type StripeState =
  | { phase: "backfill"; cursor: string | null; eventAnchor: string | null; startedAt: string }
  | { phase: "delta"; cursor: string };
```

### Workers Mapping

```ts
worker.sync("stripeSync", {
  mode: "incremental",
  execute: async (state: StripeState | undefined) => {
    if (!state || state.phase === "backfill") {
      // First call: capture event anchor before fetching any data
      const eventAnchor = state?.eventAnchor ?? (await getLatestEventId());
      const cursor = state?.cursor ?? null;

      const { data, has_more } = await stripe.customers.list({
        starting_after: cursor ?? undefined,
        limit: 100,
      });
      const last = data[data.length - 1];

      return {
        changes: data.map(toUpsert),
        hasMore: has_more,
        // When backfill is done, transition to delta starting from the anchored event
        nextState: has_more
          ? { phase: "backfill", cursor: last.id, eventAnchor, startedAt: state?.startedAt ?? new Date().toISOString() }
          : { phase: "delta", cursor: eventAnchor },
      };
    }

    // Delta: read events, skip any < 10s old
    const { data: events, has_more } = await stripe.events.list({
      ending_before: state.cursor,
      limit: 100,
    });
    const safeEvents = events.filter(e => e.created < Date.now() / 1000 - 10);
    const changes = safeEvents.map(eventToChange); // map to upsert or delete
    const lastSafe = safeEvents[safeEvents.length - 1];

    return {
      changes,
      hasMore: has_more && safeEvents.length > 0,
      nextState: { phase: "delta", cursor: lastSafe?.id ?? state.cursor },
    };
  },
});
```

---

## Source 3: HubSpot

**API type:** REST (CRM v3 — both List and Search endpoints)
**Pagination:** Opaque `after` token (List) / timestamp cursor (Search)

### Backfill

Uses `GET /crm/v3/objects/{type}?limit=100&after=<token>`. The `after` token is opaque (HubSpot generates it). Completion is detected by the absence of the `paging` key in the response.

### Delta

Uses `POST /crm/v3/objects/{type}/search` with a `GTE` filter on `lastmodifieddate` (milliseconds). The cursor advances to `max(lastmodifieddate)` across the page. Capped to **10 seconds behind "now"** — since the cursor never resets, this ensures records still being indexed by HubSpot aren't permanently skipped.

### The Deadlock Problem

The most instructive edge case across all sources. HubSpot's Search API only sorts by one field. If >100 records share the same `lastmodifieddate`, the cursor can never advance past that timestamp — it's stuck returning the same 100 records forever.

**Detection:** If `records.length == page_limit` AND all records have the same timestamp → deadlock.

**Resolution:** Switch to a special deadlock-breaking mode that filters `lastmodifieddate EQ <stuck_timestamp>` and paginates by `hs_object_id > <last_seen_id>`. When the deadlock clears (empty page), resume normal search with cursor advanced by 1ms.

### Cursor Design

```ts
type HubSpotState =
  | { phase: "backfill"; afterToken: string | null; startedAt: number }
  | { phase: "delta"; cursorMs: number }
  | { phase: "deadlock"; deadlockMs: number; lastId: string; resumeCursorMs: number };
```

### Workers Mapping

```ts
worker.sync("hubspotSync", {
  mode: "incremental",
  execute: async (state: HubSpotState | undefined) => {
    if (!state || state.phase === "backfill") {
      const startedAt = state?.startedAt ?? Date.now();
      const { results, paging } = await hubspotList(state?.afterToken);
      const hasMore = Boolean(paging?.next?.after);

      return {
        changes: results.map(toUpsert),
        hasMore,
        nextState: hasMore
          ? { phase: "backfill", afterToken: paging.next.after, startedAt }
          : { phase: "delta", cursorMs: startedAt - 5 * 60 * 1000 }, // 5min overlap
      };
    }

    if (state.phase === "deadlock") {
      // Page through records at the stuck timestamp by ID
      const results = await hubspotSearch({
        filter: { lastmodifieddate: { eq: state.deadlockMs } },
        after: state.lastId, // hs_object_id > lastId
      });

      if (results.length === 0) {
        // Deadlock cleared — resume normal delta, advance cursor by 1ms
        return {
          changes: [],
          hasMore: true,
          nextState: { phase: "delta", cursorMs: state.resumeCursorMs + 1 },
        };
      }

      const lastId = results[results.length - 1].id;
      return {
        changes: results.map(toUpsert),
        hasMore: true,
        nextState: { phase: "deadlock", deadlockMs: state.deadlockMs, lastId, resumeCursorMs: state.resumeCursorMs },
      };
    }

    // Normal delta: search by lastmodifieddate >= cursorMs
    const bufferMs = Date.now() - 10_000;
    const results = await hubspotSearch({
      filter: { lastmodifieddate: { gte: state.cursorMs } },
      limit: 100,
    });

    // Deadlock detection
    const allSameTimestamp = results.length === 100 &&
      results.every(r => r.lastmodifieddate === results[0].lastmodifieddate);

    if (allSameTimestamp) {
      return {
        changes: results.map(toUpsert),
        hasMore: true,
        nextState: {
          phase: "deadlock",
          deadlockMs: results[0].lastmodifieddate,
          lastId: results[results.length - 1].id,
          resumeCursorMs: results[0].lastmodifieddate,
        },
      };
    }

    const maxTs = Math.max(...results.map(r => r.lastmodifieddate));
    const nextCursor = Math.min(maxTs, bufferMs);
    const done = results.length < 100;

    return {
      changes: results.map(toUpsert),
      hasMore: !done,
      nextState: { phase: "delta", cursorMs: done ? nextCursor : maxTs },
    };
  },
});
```

---

## Source 4: GitHub

**API type:** GraphQL (Relay-style connections)
**Pagination:** `endCursor` + `hasNextPage` from `pageInfo`

### Backfill

Standard Relay pagination: `first: 100, after: $cursor` → `pageInfo { endCursor, hasNextPage }`. The cursor is the opaque `endCursor` string.

### Two-Level Pagination

GitHub has nested collections (e.g., issues within repositories). The sync handles this with a two-level cursor:

1. **Outer level:** paginate over repositories using `endCursor`
2. **Inner level:** for each repository, track a separate `endCursor` in a `nestedCursors` map

When inner cursors exist, the next request only queries repos with more data. The overall `hasMore` is `outerHasMore || nestedCursors.size > 0`.

### Rate Limit Awareness

The GraphQL response includes `rateLimit { limit }`. This is stored in the cursor and used to configure request pacing on subsequent pages.

### Cursor Design

```ts
type GitHubState = {
  cursor: string | null;
  nestedCursors?: Record<string, string>; // repo → inner endCursor
};

// hasMore = Boolean(pageInfo.hasNextPage) || Object.keys(nestedCursors ?? {}).length > 0
```

### Workers Mapping

```ts
worker.sync("githubSync", {
  mode: "replace", // GitHub GraphQL has no good incremental signal without webhooks
  execute: async (state: GitHubState | undefined) => {
    // For flat collections (e.g., repos): simple Relay pagination
    const { data, pageInfo } = await graphql(query, { after: state?.cursor });

    return {
      changes: data.map(toUpsert),
      hasMore: pageInfo.hasNextPage,
      nextState: pageInfo.hasNextPage
        ? { cursor: pageInfo.endCursor }
        : undefined,
    };

    // For nested collections (e.g., issues across repos):
    // Track nestedCursors map, query only repos with hasNextPage,
    // hasMore = outerMore || Object.keys(nestedCursors).length > 0
  },
});
```

---

## Source 5: ServiceNow

**API type:** REST (Table API with SYSPARM query language)
**Pagination:** Keyset on `(sys_updated_on, sys_id)`

### Backfill & Delta

Same keyset pattern as Salesforce, using ServiceNow's query syntax:

```
sys_updated_on>{cursor}^NQsys_updated_on={cursor}^sys_id>{sys_id}
^ORDERBYsys_updated_on^ORDERBYsys_id
```

The `^NQ` is ServiceNow's OR operator. This is the `(timestamp, id)` keyset pattern again.

### Deletion via Audit Log

ServiceNow captures deletes in the `sys_audit` table (`fieldname=DELETED`). In the production system, this runs as a separate parallel stream using `(sys_created_on, sys_id)` keyset pagination.

**In Workers (single stream):** Model this as a flip-flop. The main delta stream runs until `hasMore: false` (caught up), then the state switches to the delete stream for a cycle, then back. See the "Stream Flip-Flop" pattern below.

### Completion Detection Difference

- **Backfill:** continues until an empty page (`records.length == 0`)
- **Delta:** stops when a page is not full (`records.length < limit`)

This is a subtle but important distinction. Backfill is exhaustive; delta assumes a non-full page means "caught up."

### Cursor Design

```ts
type ServiceNowState =
  | { phase: "backfill"; afterTimestamp: string | null; afterId: string | null; backfillStartedAt: string }
  | { phase: "delta"; afterTimestamp: string; afterId: string;
      deletesCursor?: { afterCreatedOn: string; afterId: string } }
  | { phase: "deletes"; afterCreatedOn: string; afterId: string;
      deltaCursor: { afterTimestamp: string; afterId: string } };
```

---

## APIs Without Change Tracking

Some APIs (Linear, Airtable) have no `updated_at`, no change feed, and no deletion webhook. For these, **use `mode: "replace"`**. The runtime handles the full sweep automatically: each cycle returns the complete dataset, and anything not returned gets deleted.

Replace mode is the right choice when:
- The API provides only opaque cursor pagination with no timestamp filtering
- Total records are manageable (< ~50k, depending on schedule interval)
- You need deletion detection but the API provides no delete signal

The state in replace mode is just within-cycle pagination (e.g., `{ offset: string }`) and effectively resets between cycles.

---

## Cross-Cutting Patterns

These patterns recur across multiple sources. They're the building blocks of cursor design.

### Pattern 1: Keyset Pagination `(timestamp, id)`

**Used by:** Salesforce, ServiceNow

The correct way to paginate a mutable dataset ordered by timestamp. Two columns form the cursor: the timestamp and a unique ID that breaks ties. The query uses an OR condition:

```
WHERE ts > :cursorTs OR (ts = :cursorTs AND id > :cursorId)
ORDER BY ts, id
```

**When to use:** Any API that lets you query with inequality filters on a timestamp and sort by it. Particularly important when multiple records can share the same timestamp (batch imports, bulk updates).

**Workers implementation:**

```ts
type KeysetCursor = { cursorTimestamp: string; cursorId: string };

const lastRecord = records[records.length - 1];
const nextState: KeysetCursor = {
  cursorTimestamp: lastRecord.updatedAt,
  cursorId: lastRecord.id,
};
```

### Pattern 2: Consistency Buffer

**Used by:** Salesforce (15s), Stripe (10s), HubSpot (10s)

Never advance the cursor to "now." Always leave a gap. Eventually consistent APIs may not surface recent writes in query results immediately. Because the cursor never resets in incremental mode, if it advances past a record that hasn't been indexed yet, that record is lost permanently.

The buffer ensures the cursor stays behind the API's consistency frontier.

**Workers implementation:**

```ts
const bufferMs = 15_000; // 15 seconds
const maxCursor = new Date(Date.now() - bufferMs).toISOString();
const nextCursor = records.length > 0
  ? min(lastRecord.updatedAt, maxCursor)
  : maxCursor;
```

### Pattern 3: Event Anchor (Backfill-to-Delta Transition)

**Used by:** Stripe, Salesforce, HubSpot

Before starting a backfill, snapshot the current position of the change feed (event ID, timestamp, etc.). After the backfill completes, start the delta from that snapshot — not from the end of the backfill data.

**Why:** The backfill may take hours. Records change during that time. Without the anchor, changes between "backfill started" and "backfill ended" are lost permanently (since the cursor never goes backwards).

**Workers implementation:**

```ts
// First execute call (state is undefined):
const eventAnchor = await getLatestEventId();
// ... fetch first page of backfill data ...
return {
  changes,
  hasMore: true,
  nextState: { phase: "backfill", cursor: lastId, eventAnchor },
};

// When backfill completes:
return {
  changes: lastPage,
  hasMore: true, // or false — either way, nextState persists
  nextState: { phase: "delta", cursor: state.eventAnchor },
};
```

### Pattern 4: Sweep = Replace Mode

When an API has no `updated_at`, no change feed, and no deletion signal, use `mode: "replace"`. The runtime handles the full sweep and deletion detection automatically. You just return all records each cycle.

### Pattern 5: Multi-Phase State Machine

**Used by:** HubSpot (deadlock handling), all incremental syncs (backfill/delta)

Model the state as a discriminated union:

```ts
type State =
  | { phase: "backfill"; cursor: string | null; startedAt: string }
  | { phase: "delta"; cursor: string }
  | { phase: "deadlock"; stuckAt: number; lastId: string; resumeCursor: string };
```

Each `execute` call checks `state.phase` and runs the appropriate logic. The simplest version is two phases (backfill + delta). More complex sources add phases for edge cases (deadlock, deletes).

### Pattern 6: Stream Flip-Flop (Single-Stream Delete Detection)

**Used by:** ServiceNow (adapted for single-stream Workers)

When an API exposes deletions through a separate endpoint (audit log, archived filter, trash), but you only have one `execute` function, alternate between streams:

1. Run the main delta stream until `hasMore: false` (caught up to present)
2. Switch to the delete-detection stream for one or more cycles
3. When the delete stream catches up, switch back to delta

The state carries cursors for both streams, plus which one is active:

```ts
type State =
  | { phase: "delta"; deltaCursor: string; deletesCursor?: string }
  | { phase: "deletes"; deltaCursor: string; deletesCursor: string };

// In execute:
if (state.phase === "delta") {
  const { records, hasMore } = await fetchChanges(state.deltaCursor);
  if (!hasMore) {
    // Delta caught up — flip to deletes on next cycle
    return {
      changes: records.map(toUpsert),
      hasMore: false,
      nextState: { phase: "deletes", deltaCursor: nextCursor, deletesCursor: state.deletesCursor ?? "" },
    };
  }
  // ... continue delta
}

if (state.phase === "deletes") {
  const { deletedIds, hasMore } = await fetchDeletedRecords(state.deletesCursor);
  if (!hasMore) {
    // Deletes caught up — flip back to delta
    return {
      changes: deletedIds.map(id => ({ type: "delete", key: id })),
      hasMore: false,
      nextState: { phase: "delta", deltaCursor: state.deltaCursor, deletesCursor: nextCursor },
    };
  }
  // ... continue deletes
}
```

The flip happens at cycle boundaries (`hasMore: false`). The next cycle picks up with the alternate stream. Both cursors advance independently and persist across cycles.

---

## Decision Tree: Choosing a Pagination Strategy

This tree applies to **backfill** pagination. Delta pagination often differs (see per-source sections).

```
Does the API provide pagination?
├─ No → Return all data in one batch (small datasets only)
│
├─ Yes, opaque cursor token (GraphQL endCursor, Stripe starting_after)
│  └─ Use the token directly in state
│     State: { cursor: string | null }
│
├─ Yes, page numbers or offsets
│  └─ Use page number in state
│     State: { page: number }
│
└─ Yes, timestamp-based query (updated_since, modified_after)
   ├─ Can multiple records share the same timestamp?
   │  ├─ No → Simple timestamp cursor
   │  │  State: { cursor: string }
   │  │
   │  └─ Yes → Keyset cursor (timestamp + id)
   │     State: { cursorTimestamp: string, cursorId: string }
   │
   └─ Always add a consistency buffer (10-60s behind now)
      APIs tend to be eventually consistent — safe default
```

For **delta** pagination, the main question is: does the API have a change feed?

```
Does the API have an events/changelog endpoint?
├─ Yes → Use event ID as delta cursor (Stripe pattern)
│  Anchor the latest event ID before backfill starts
│
├─ No, but has updated_at / modified_since filter
│  └─ Use timestamp (or keyset) as delta cursor (Salesforce pattern)
│     Apply consistency buffer
│
└─ No change tracking at all
   └─ Use replace mode instead of incremental
```

---

## Decision Tree: Choosing Replace vs Incremental Mode

```
How many records in total?
├─ < 10,000 → replace (simpler, auto-handles deletes)
│
├─ > 10,000
│  ├─ Does the API have updated_at / modified_since / change feed?
│  │  ├─ Yes → incremental
│  │  └─ No → replace (but set a longer schedule interval)
│  │
│  └─ Does the API support deletion detection?
│     ├─ Yes (archived filter, audit log, events) → incremental with flip-flop deletes
│     ├─ No, but deletions matter → replace (re-fetches everything, catches deletes)
│     └─ No, and deletions don't matter → incremental (accept stale records)
```

---

## Summary Table

| Source | API Type | Backfill Pagination | Delta Strategy | Key Pattern |
|---|---|---|---|---|
| Salesforce | REST/SOQL | Keyset (timestamp, id) | Keyset on SystemModstamp | Consistency buffer (15s), overlap transition |
| Stripe | REST | `starting_after` cursor | Event feed (10s buffer) | Event anchor before backfill |
| HubSpot | REST | Opaque `after` token | Search API + timestamp | Deadlock detection & resolution |
| GitHub | GraphQL | Relay `endCursor` | N/A (use replace mode) | Two-level nested pagination |
| ServiceNow | REST | Keyset (timestamp, id) | Same keyset | Flip-flop delete stream via audit log |
