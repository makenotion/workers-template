---
name: sync
description: Scaffold a new sync capability with guided setup — asks about data source, mode, pagination, and cursor design, then generates working code
user-invocable: true
disable-model-invocation: true
allowed-tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "Agent"]
---

## Instructions

You are helping the user create a new sync capability for their Notion Worker. Walk through each step, asking questions and making recommendations. Generate working code at the end.

Before you begin, read these reference files to understand sync patterns:
- `.claude/skills/sync-guide/SKILL.md` — concepts, modes, patterns, common mistakes
- `.claude/skills/sync-guide/api-pagination-patterns.md` — real-world API strategies
- `.claude/skills/sync-guide/examples/` — working code templates

Also read the current `src/index.ts` to understand what already exists.

### Step 1: Understand the Data Source

Ask the user:
- What data are you syncing? (e.g., "Jira issues", "Stripe customers", "ServiceNow tickets")

If they name a well-known API, look up its pagination mechanism and change-tracking capabilities (does it have `updated_at`? an events endpoint? cursor-based pagination?).

### Step 2: Determine the Right Mode

Based on what you know about the data source, make a recommendation. Consider:
- **Expected volume:** A team roster is probably <100 records (replace). A CRM's
  contacts or a ticketing system's issues could be 10k-1M+ (incremental).
  Use your knowledge of the API to estimate — don't ask the user unless unsure.
- **Change tracking:** Does the API have `updated_at`, an events endpoint, or a
  changelog? If not, replace mode is the only practical option regardless of volume.

Recommend a mode with a brief explanation:
- **replace** if: <10k records, no good change tracking, or simplicity is preferred.
  Simpler (no backfill/delta), auto-handles deletes, but re-fetches everything each cycle.
- **incremental** if: >10k records AND the API has change tracking.
  Efficient for large datasets but requires bi-modal cursor design and explicit delete handling.

Let the user override if they disagree.

### Step 3: Design the Schema

Based on the API's response shape, propose a schema. Look up what fields the
API returns and map the most useful ones to Schema types. Don't ask the user
to enumerate fields — propose a sensible default and let them adjust.

For example, if syncing Jira issues, propose:
```ts
properties: {
  "Issue Key": Schema.richText(),    // primaryKeyProperty — the unique ID
  "Summary": Schema.title(),         // the main display field
  "Status": Schema.select([...]),    // mapped from Jira statuses
  "Assignee": Schema.richText(),     // or Schema.people() if email available
  "Updated": Schema.date(),
}
```

Guidelines:
- Every schema needs exactly one `Schema.title()` — pick the most descriptive field
- Use `Schema.richText()` for the primary key property (the unique ID)
- Use `Schema.url()`, `Schema.email()`, `Schema.date()`, `Schema.number()`,
  `Schema.checkbox()`, `Schema.select()` where the data type fits
- Use `Schema.relation("otherSyncKey")` for cross-sync relations
- Start with 10-20 properties — be generous, include most useful fields from the API
- See the full type list in `.claude/skills/sync-guide/SKILL.md` under "Schema Reference"

Present the proposed schema to the user and ask if they want to add, remove,
or change any fields before generating code.

### Step 4: Design the State Machine

Research the API to determine its pagination and change-tracking mechanisms.
Do NOT ask the user about pagination details — figure it out from the API docs,
your knowledge of the API, or by looking up the API. The user shouldn't need
to know whether their API uses opaque cursors vs page numbers.

You need to determine:
1. **How the API paginates list results** (opaque cursor, page number, offset, keyset)
2. **Whether the API has change tracking** (updated_at field, events endpoint, changelog)
3. **Whether the API has deletion signals** (archived filter, audit log, delete events)

Then design the state accordingly:

**For replace-mode syncs:** State is just within-cycle pagination.
- Opaque cursor: `{ cursor: string | null }`
- Page number: `{ page: number }`

**For incremental-mode syncs:** The sync is bi-modal — backfill and delta
often use different pagination strategies. Design both:

- **Backfill cursor:** How to paginate the full dataset (usually the API's
  native list pagination — opaque cursor, offset, or keyset)
- **Delta cursor:** How to track changes (usually timestamp-based, event ID,
  or the same opaque cursor if the API sorts by `updated_at`)
- **Transition:** How to seed the delta cursor when backfill completes
  (event anchor captured before backfill, or `backfillStartedAt - 5 minutes`)

State shape for bi-modal:
```ts
type State =
  | { phase: "backfill"; cursor: string | null; backfillStartedAt: string }
  | { phase: "delta"; cursor: string };
```

If the API has no change tracking, go back and recommend replace mode instead.

**Deletion handling (incremental only):**
- If the API naturally includes delete signals in its change feed (e.g., Stripe
  events with `*.deleted` types): emit `{ type: "delete", key }` markers — easy.
- If deletes require a separate endpoint (audit log, archived filter): this adds
  complexity (flip-flop pattern). Ask the user whether delete detection matters
  for their use case — it depends on the domain. Suggest they can always add it later.
- If the API has no delete signal at all, or the source data is rarely deleted
  in practice: mention this to the user. They can skip delete handling for now
  and add it later, or switch to replace mode if stale records become a problem.

Present your state design to the user as a brief summary (e.g., "This API uses
cursor-based pagination and has an `updated_at` field, so I'll use a bi-modal
state with opaque cursor for backfill and timestamp keyset for delta"). Let
them confirm or adjust before generating code.

### Step 5: Set Up Authentication

Before generating code, determine what auth the API needs and set it up so
you can test locally.

There are two patterns:

**Pattern A: Static API token/key**
For APIs where the user has a personal token or API key (e.g., Jira API token,
GitHub PAT, simple API keys).

Ask the user for their token and add it to `.env`:
```
JIRA_API_TOKEN=...
JIRA_EMAIL=user@example.com
```
If `.env` doesn't exist, create it. The `.env` file is automatically loaded
during local execution (`--local` flag).

**Pattern B: OAuth**
For APIs that require OAuth (e.g., Google, Salesforce, HubSpot). This has
two parts:

1. **Client credentials** — the OAuth app's client ID and secret. These go in `.env`:
   ```
   MY_OAUTH_CLIENT_ID=...
   MY_OAUTH_CLIENT_SECRET=...
   ```

2. **User token** — obtained through the OAuth flow *after* deploying. This is
   handled by the runtime automatically via `worker.oauth()` and `.accessToken()`.

For OAuth syncs, you'll add a `worker.oauth()` call in the generated code:
```ts
const myAuth = worker.oauth("myAuth", {
  name: "my-provider",
  authorizationEndpoint: "https://provider.example.com/oauth/authorize",
  tokenEndpoint: "https://provider.example.com/oauth/token",
  scope: "read write",
  clientId: process.env.MY_OAUTH_CLIENT_ID ?? "",
  clientSecret: process.env.MY_OAUTH_CLIENT_SECRET ?? "",
});
```

Then use `await myAuth.accessToken()` in the execute function instead of
reading a static token from `process.env`.

Note: OAuth syncs can't be fully tested locally since the OAuth flow requires
a deployed worker. Local testing will fail at the `.accessToken()` call. This
is fine — proceed to deploy and test via dry-run (Step 8).

### Step 6: Generate the Code

Write the sync into `src/index.ts`. Use the closest example from `.claude/skills/sync-guide/examples/` as a starting point:
- `replace-simple.ts` — static data, no API
- `replace-paginated.ts` — paginated replace mode
- `incremental-basic.ts` — single cursor serves both phases
- `incremental-bimodal.ts` — full bi-modal state machine
- `incremental-events.ts` — event-anchor backfill + event-feed delta

Include in the generated code:
- Proper imports (`Worker`, `Builder`, `Schema`)
- The state type (explicitly typed, discriminated union if bi-modal)
- The schema definition with all requested properties
- The `execute` function with phase handling
- The backfill-to-delta transition (if bi-modal)
- A consistency buffer (if the API is eventually consistent)
- Inline comments explaining *why* each design choice was made
- API calls using `fetch` with auth from `process.env`

### Step 7: Test Locally

Test the sync before deploying. This catches bugs early without a deploy cycle.

**For syncs using static API tokens (Pattern A):**

1. Run `npm run check` to verify TypeScript types compile. Fix any errors.

2. Run `ntn workers exec <key> --local` to execute the sync locally.
   This runs the execute function on your machine with `.env` loaded.
   - Check: does it return data? Are properties populated correctly?
   - Check: does `hasMore` look right? Does the cursor advance?

3. If it returns `hasMore: true`, test the next page:
   `ntn workers exec <key> --local -d '<nextState from previous output>'`

4. If there are errors (auth failures, wrong field mappings, crashes):
   fix the code and re-run — no deploy needed, iteration is fast.

5. Write a test file (`test.ts`) that exercises the sync. Import the worker
   directly and call its `.run()` method.

   If the user has API credentials in `.env`, write a test that hits the real
   API — this is the most valuable test because it validates actual field
   mappings, pagination behavior, and auth against the real service. If
   credentials aren't available, stub the HTTP calls instead.

   **Integration test (preferred when credentials are available):**
   ```ts
   import "dotenv/config"; // load .env
   import worker from "./src/index.ts";
   import assert from "node:assert";

   async function test() {
     // First page (backfill start, no prior state)
     const page1 = await worker.run("mySync", undefined, { concreteOutput: true });
     console.log(`Page 1: ${page1.changes.length} records, hasMore: ${page1.hasMore}`);
     assert(page1.changes.length > 0, "Should return records");

     // Verify fields are populated
     const first = page1.changes[0];
     assert(first.key, "Record should have a key");
     console.log("Sample record:", JSON.stringify(first, null, 2));

     // Test pagination
     if (page1.hasMore) {
       const page2 = await worker.run("mySync", page1.nextState, { concreteOutput: true });
       console.log(`Page 2: ${page2.changes.length} records, hasMore: ${page2.hasMore}`);
       assert(page2.changes.length > 0, "Second page should return records");
     }

     console.log("All tests passed!");
   }

   test().catch((err) => { console.error(err); process.exit(1); });
   ```

   Run with `npx tsx test.ts`. Adapt to the specific sync: use the actual
   capability key, add assertions for specific field values, verify phase
   transitions for bi-modal syncs, etc.

**For syncs using OAuth (Pattern B):**
Local execution won't work because `.accessToken()` requires a deployed worker
with a completed OAuth flow. Skip to Step 8 (deploy + dry-run) instead.
You can still run `npm run check` to verify types compile.

### Step 8: Deploy and Validate with Dry-Run

Once local testing passes (or immediately for OAuth syncs), deploy and test remotely.

If secrets need to be available at deploy time (e.g., OAuth `clientSecret` read
from `process.env` during capability registration), create the worker and push
secrets first:
1. `ntn workers create --name <name>` — create the worker without deploying
2. `ntn workers env push` — push `.env` secrets to remote
3. `ntn workers deploy` — now deploy with secrets available

Otherwise, the simpler flow:
1. `ntn workers deploy` — build and publish
2. `ntn workers env push` — push `.env` secrets to remote

Then, if the sync uses OAuth, complete the OAuth flow before dry-running:
   - `ntn workers oauth show-redirect-url` — get the redirect URL
   - Tell the user to configure this URL in their OAuth provider's app settings
   - `ntn workers oauth start <oauthKey>` — opens browser to complete the OAuth flow
4. `ntn workers sync dry-run <syncKey>` — execute remotely without writing to Notion
   - Inspect the output: record count, property values, hasMore status
   - If `hasMore: true`, continue: `ntn workers sync dry-run <syncKey> --context '<nextState>'`
5. If the dry-run shows issues, fix the code and redeploy (go back to step 1)

### Step 9: Go Live

When the dry-run looks good:

1. `ntn workers sync force-run <key>` — trigger a real sync
2. `ntn workers sync status` — check that the sync is running and progressing
3. `ntn workers runs list` then `ntn workers runs logs <runId>` — check for errors
4. Run `ntn workers sync status` again to confirm progress (record count increasing, no errors)

Tell the user: the first sync run is the backfill, which may take a while
depending on dataset size. They should periodically run `ntn workers sync status`
to monitor progress until the initial backfill completes. After that, the sync
runs automatically on its configured schedule.
