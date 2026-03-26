# Repository Guidelines

## Project Structure & Module Organization
- `src/index.ts` defines the worker and capabilities.
- `.examples/` has focused samples (sync, tool, automation, OAuth, AI connector).
- Shared agent skills live in `.agents/skills/`. `.claude/skills` is kept as a compatibility symlink for Claude-specific discovery.
- Generated: `dist/` build output, `workers.json` CLI config.

## Worker & Capability API (SDK)
- `@notionhq/workers` provides `Worker`, schema helpers, and builders; the `ntn` CLI powers worker management.
- Capability keys are unique strings used by the CLI (e.g., `ntn workers exec tasksSync`).

```ts
import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

worker.sync("tasksSync", {
	primaryKeyProperty: "ID",
	schema: { defaultName: "Tasks", properties: { Name: Schema.title(), ID: Schema.richText() } },
	execute: async (_state, { notion }) => ({
		changes: [{ type: "upsert", key: "1", properties: { Name: Builder.title("Write docs"), ID: Builder.richText("1") } }],
		hasMore: false,
	}),
});

worker.tool("sayHello", {
	title: "Say Hello",
	description: "Return a greeting",
	schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
	execute: ({ name }, { notion }) => `Hello, ${name}`,
});

worker.automation("sendWelcomeEmail", {
	title: "Send Welcome Email",
	description: "Runs from a database automation",
	execute: async (event, { notion }) => {},
});

worker.oauth("googleAuth", { name: "my-google-auth", provider: "google" });

worker.aiConnector("discordChat", {
	aiConnectorId: process.env.AI_CONNECTOR_ID!,
	archetype: "chat",
	schedule: "15m",
	execute: async (state) => {
		const { records, nextCursor } = await fetchRecords(state?.cursor);
		return { records, hasMore: Boolean(nextCursor), nextState: nextCursor ? { cursor: nextCursor } : undefined };
	},
	executePermissions: async (state) => {
		const { members, nextCursor } = await fetchMembers(state?.cursor);
		return {
			userMappings: members.map((m) => ({ notion_user_id: m.notionId, third_party_user_id: m.externalId })),
			groupMappings: members.map((m) => ({ third_party_user_id: m.externalId, third_party_group_ids: m.groups })),
			hasMore: Boolean(nextCursor),
			nextState: nextCursor ? { cursor: nextCursor } : undefined,
		};
	},
});
```

- All `execute` handlers receive a Notion SDK client in the second argument as `context.notion`.

- For user-managed OAuth, supply `name`, `authorizationEndpoint`, `tokenEndpoint`, `clientId`, `clientSecret`, and `scope` (optional: `authorizationParams`, `callbackUrl`, `accessTokenExpireMs`).
- After deploying a worker with an OAuth capability, the user must configure their OAuth provider's redirect URL to match the one assigned by Notion. Run `ntn workers oauth show-redirect-url` to get the redirect URL, then set it in the provider's OAuth app settings. **Always remind the user of this step after deploying any OAuth capability.**
- **OAuth setup order:** Deploy → `ntn workers env push` → set redirect URL → `ntn workers oauth start`. Secrets must be pushed before starting the OAuth flow because the deployed worker needs the client secret to exchange the authorization code for tokens.

### Sync
#### Strategy and Pagination

Syncs run in a "sync cycle": a back-to-back chain of `execute` calls that starts at a scheduled trigger and ends when an execution returns `hasMore: false`. By default, syncs run every 30 minutes. Set `schedule` to an interval like `"15m"`, `"1h"`, `"1d"` (min `"1m"`, max `"7d"`), or `"continuous"` to run as fast as possible.

- Always use pagination, when available. Returning too many changes in one execution will fail. Start with batch sizes of ~100 changes.
- `mode=replace` is simpler — use it when the API has no change tracking (no `updated_at` filter, no event feed)
- Use `mode=incremental` when the API supports change tracking (e.g. `updated_since`, event streams), which enterprise APIs like Salesforce, Stripe, and Linear typically do
- When using `mode=incremental`, emit delete markers as needed if easy to do (below)

**Sync strategy (`mode`):**
- `replace`: each sync cycle must return the full dataset. After the final `hasMore: false`, any records not seen during that cycle are deleted.
- `incremental`: each sync cycle returns a subset of the full dataset (usually the changes since the last run). Deletions must be explicit via `{ type: "delete", key: "..." }`. Records not mentioned are left unchanged.

**How pagination works:**
1. Return a batch of changes with `hasMore: true` and a `nextState` value
2. The runtime calls `execute` again with that state
3. Continue until you return `hasMore: false`

**Example replace sync:**

```ts
worker.sync("paginatedSync", {
	mode: "replace",
	primaryKeyProperty: "ID",
	schema: { defaultName: "Records", properties: { Name: Schema.title(), ID: Schema.richText() } },
	execute: async (state, { notion }) => {
		const page = state?.page ?? 1;
		const pageSize = 100;
		const { items, hasMore } = await fetchPage(page, pageSize);
		return {
			changes: items.map((item) => ({
				type: "upsert",
				key: item.id,
				properties: { Name: Builder.title(item.name), ID: Builder.richText(item.id) },
			})),
			hasMore,
			nextState: hasMore ? { page: page + 1 } : undefined,
		};
	},
});
```

**State types:** The `nextState` can be any serializable value—a cursor string, page number, timestamp, or complex object. Type your execute function's `state` to match.

**Incremental example (changes only, with deletes):**
```ts
worker.sync("incrementalSync", {
	primaryKeyProperty: "ID",
	mode: "incremental",
	schema: { defaultName: "Records", properties: { Name: Schema.title(), ID: Schema.richText() } },
	execute: async (state, { notion }) => {
		const { upserts, deletes, nextCursor } = await fetchChanges(state?.cursor);
		return {
			changes: [
				...upserts.map((item) => ({
					type: "upsert",
					key: item.id,
					properties: { Name: Builder.title(item.name), ID: Builder.richText(item.id) },
				})),
				...deletes.map((id) => ({ type: "delete", key: id })),
			],
			hasMore: Boolean(nextCursor),
			nextState: nextCursor ? { cursor: nextCursor } : undefined,
		};
	},
});
```

#### Relations

Two syncs can relate to one another using `Schema.relation(relatedSyncKey)` and `Builder.relation(primaryKey)` entries inside an array.

```ts
worker.sync("projectsSync", {
	primaryKeyProperty: "Project ID",
	...
});

// Example sync worker that syncs sample tasks to a database
worker.sync("tasksSync", {
	primaryKeyProperty: "Task ID",
	...
	schema: {
		...
		properties: {
			...
			Project: Schema.relation("projectsSync", {
				// Optionally configure a two-way relation. This will automatically create the
				// "Tasks" property on the project synced database: there is no need
				// to configure "Tasks" on the projectSync capability.
				twoWay: true, relatedPropertyName: "Tasks"
			}),
		},
	},

	execute: async () => {
		// Return sample tasks as database entries
		const tasks = fetchTasks()
		const changes = tasks.map((task) => ({
			type: "upsert" as const,
			key: task.id,
			properties: {
				...
				Project: [Builder.relation(task.projectId)],
			},
		}));

		return {
			changes,
			hasMore: false,
		};
	},
});
```

### Sync Management (CLI)

**Monitor sync status:**
```shell
ntn workers sync status              # live-updating watch mode (polls every 5s)
ntn workers sync status <key>        # filter to a specific sync capability
ntn workers sync status --no-watch   # print once and exit
ntn workers sync status --interval 10 # custom poll interval in seconds
```

Status labels:
- **HEALTHY** — last run succeeded
- **INITIALIZING** — deployed but hasn't succeeded yet
- **WARNING** — 1–2 consecutive failures
- **ERROR** — 3+ consecutive failures
- **DISABLED** — capability is disabled

**Dry-run a sync (preview without writing):**
```shell
ntn workers sync dry-run <key>                   # run execute, show objects, don't write to the database
ntn workers sync dry-run <key> --context '{"page":2}'  # resume from a previous dry-run's nextContext
```
Dry-run calls your sync's `execute` function and shows the objects it would produce, but **does not write anything to the Notion database**. Use it to verify your sync logic and inspect the data before committing to a real run. When piped, outputs raw JSON.

**Force-run a sync (write immediately, bypass schedule):**
```shell
ntn workers sync force-run <key>
```
Force-run triggers a **real** sync cycle that writes to the database, bypassing the normal schedule. Use it to push changes immediately rather than waiting for the next scheduled run.

**Reset sync state (restart from scratch):**
```shell
ntn workers sync state reset <key>
```
Clears the cursor and stats so the next run starts from the beginning.

**Enable / disable a sync:**
```shell
ntn workers capabilities list            # show all capabilities
ntn workers capabilities disable <key>   # pause a sync
ntn workers capabilities enable <key>    # resume a sync
```

> **Note:** `ntn workers deploy` does **not** reset sync state. Syncs resume from their last cursor position after a deploy. Use `ntn workers sync state reset <key>` to explicitly restart from scratch.

### AI Connector

AI Connectors integrate third-party services (e.g. Discord, Slack, Jira) into Notion's search and knowledge graph. Unlike syncs, connectors do not create Notion databases; they feed records and permission mappings directly to Notion's connector infrastructure.

#### Key concepts

- **`aiConnectorId`**: The unique identifier for the connector instance, typically provided via environment variable.
- **`archetype`**: Determines the record shape the connector produces. Current archetypes: `"chat"` (for messaging platforms) and `"project"` (for project management tools).
- **`schedule`**: How often the connector runs. Same format as syncs: `"15m"`, `"1h"`, `"1d"`, or `"continuous"`. Defaults to `"30m"`.
- **`execute`**: Fetches data records from the third-party service. Supports cursor-based pagination via `hasMore` / `nextState`, identical to syncs.
- **`executePermissions`**: Fetches user and group permission mappings so Notion can enforce access control. Also supports pagination.

#### Record shape

Records returned from `execute` are plain objects whose fields depend on the archetype. For `"chat"`, typical fields include `channel_id`, `channel_name`, `external_url`, `messages`, `permissions_space`, `permissions_users`, and `permissions_groups`.

#### Permissions

`executePermissions` returns two kinds of mappings:
- **`userMappings`**: Links a Notion user ID to a third-party user ID.
- **`groupMappings`**: Links a third-party user ID to the group IDs they belong to.

#### Example

```ts
worker.aiConnector("discordChat", {
	aiConnectorId: process.env.AI_CONNECTOR_ID!,
	archetype: "chat",
	schedule: "15m",

	execute: async (state) => {
		const cursor = state?.cursor;
		const { messages, nextCursor } = await fetchDiscordMessages(cursor);

		const records = messages.map((msg) => ({
			channel_id: msg.channel_id,
			channel_name: msg.channel_name,
			external_url: msg.permalink,
			chat_type: "channel",
			created_at: msg.created_at,
			updated_at: msg.updated_at,
			messages: msg.thread.map((m) => ({
				id: m.id,
				content: m.content,
				author: { id: m.author.id, username: m.author.username },
				timestamp: m.timestamp,
			})),
			permissions_space: msg.is_public,
			permissions_users: msg.member_ids.map((id) => ({
				id, type: "third_party_user",
			})),
			permissions_groups: [],
		}));

		return {
			records,
			hasMore: Boolean(nextCursor),
			nextState: nextCursor ? { cursor: nextCursor } : undefined,
		};
	},

	executePermissions: async (state) => {
		const after = state?.memberCursor;
		const { members, nextCursor } = await fetchDiscordMembers(after);

		return {
			userMappings: members.map((m) => ({
				notion_user_id: resolveNotionUser(m.email),
				third_party_user_id: m.user.id,
			})),
			groupMappings: members.map((m) => ({
				third_party_user_id: m.user.id,
				third_party_group_ids: m.roles,
			})),
			hasMore: Boolean(nextCursor),
			nextState: nextCursor ? { memberCursor: nextCursor } : undefined,
		};
	},
});
```

See `.examples/connector-example.ts` for a complete runnable example with placeholder API functions.

## Build, Test, and Development Commands
- Node >= 22 and npm >= 10.9.2 (see `package.json` engines).
- `npm run build`: compile TypeScript to `dist/`.
- `npm run check`: type-check only (no emit).
- `ntn login`: connect to a Notion workspace.
- `ntn workers deploy`: build and publish capabilities. Does not reset sync state.
- `ntn workers exec <capability>`: run a sync or tool.
- `ntn workers sync status`: monitor sync health (live-updating).
- `ntn workers sync dry-run <key>`: preview sync output without writing to the database.
- `ntn workers sync force-run <key>`: trigger a real sync immediately (writes to the database).

## Debugging & Monitoring Runs
Use `ntn workers runs` to inspect run history and logs.

**List recent runs:**
```shell
ntn workers runs list
```

**Get logs for a specific run:**
```shell
ntn workers runs logs <runId>
```

**Get logs for the latest run (any capability):**
```shell
ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
```

**Get logs for the latest run of a specific capability:**
```shell
ntn workers runs list --plain | grep tasksSync | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
```

The `--plain` flag outputs tab-separated values without formatting, making it easy to pipe to other commands.

### Debugging Syncs

**Check sync health:**
```shell
ntn workers sync status
```
Look at failure counts, error messages, and last succeeded times.

**Sync not running?** Check if the capability is disabled:
```shell
ntn workers capabilities list
```

**Preview what a sync would produce (without writing):**
```shell
ntn workers sync dry-run <key>
```

**Retry a failed sync (writes to the database):**
```shell
ntn workers sync force-run <key>
```

**Sync in a bad state?** Reset the cursor and restart:
```shell
ntn workers sync state reset <key>
```

## Coding Style & Naming Conventions
- TypeScript with `strict` enabled; keep types explicit when shaping I/O.
- Use tabs for indentation; capability keys in lowerCamelCase.

## Testing Guidelines
- No test runner configured; validate with `npm run check` and end-to-end testing via `ntn workers exec`.
- Write a test script that exercises each tool capability using `ntn workers exec`. This can be a bash script (`test.sh`) or a TypeScript script (`test.ts`, run via `npx tsx test.ts`). Use the `--local` flag for local execution or omit it to run against the deployed worker.

**Local execution** runs your worker code directly on your machine. Any `.env` file in the project root is automatically loaded, so secrets and config values are available via `process.env`.

**Remote execution** (without `--local`) runs against the deployed worker. Any required secrets must be pushed to the remote environment first using `ntn workers env push`.

**Example bash test script (`test.sh`):**
```shell
#!/usr/bin/env bash
set -euo pipefail

# Run locally (uses .env automatically):
ntn workers exec sayHello --local -d '{"name": "World"}'

# Or run against the deployed worker (requires `ntn workers deploy` and `ntn workers env push` first):
# ntn workers exec sayHello -d '{"name": "World"}'
```

**Example TypeScript test script (`test.ts`, run with `npx tsx test.ts`):**
```ts
import { execSync } from "child_process";

function exec(capability: string, input: Record<string, unknown>) {
	const result = execSync(
		`ntn workers exec ${capability} --local -d '${JSON.stringify(input)}'`,
		{ encoding: "utf-8" },
	);
	console.log(result);
}

exec("sayHello", { name: "World" });
```

Use this pattern to build up a suite of exec calls that covers each tool with representative inputs.

## Commit & Pull Request Guidelines
- Messages typically use `feat(scope): ...`, `TASK-123: ...`, or version bumps.
- PRs should describe changes, list commands run, and update examples if behavior changes.
