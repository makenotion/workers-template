# Repository Guidelines

## Project Structure & Module Organization
- `src/index.ts` defines the worker and capabilities.
- `.examples/` has focused samples (sync, tool, automation, OAuth).
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
```

- All `execute` handlers receive a Notion SDK client in the second argument as `context.notion`.

- For user-managed OAuth, supply `name`, `authorizationEndpoint`, `tokenEndpoint`, `clientId`, `clientSecret`, and `scope` (optional: `authorizationParams`, `callbackUrl`, `accessTokenExpireMs`).

### Sync
#### Strategy and Pagination

Syncs run in a "sync cycle": a back-to-back chain of `execute` calls that starts at a scheduled trigger and ends when an execution returns `hasMore: false`. By default, syncs run every 30 minutes. Set `schedule` to an interval like `"15m"`, `"1h"`, `"1d"` (min `"1m"`, max `"7d"`), or `"continuous"` to run as fast as possible.

- Always use pagination, when available. Returning too many changes in one execution will fail. Start with batch sizes of ~100 changes.
- `mode=replace` is simpler, and fine for smaller syncs (<10k)
- Use `mode=incremental` when the sync could return a lot of data (>10k), eg for SaaS tools like Salesforce or Stripe
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

## Build, Test, and Development Commands
- Node >= 22 and npm >= 10.9.2 (see `package.json` engines).
- `npm run build`: compile TypeScript to `dist/`.
- `npm run check`: type-check only (no emit).
- `ntn login`: connect to a Notion workspace.
- `ntn workers deploy`: build and publish capabilities.
- `ntn workers exec <capability>`: run a sync or tool.

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

## Coding Style & Naming Conventions
- TypeScript with `strict` enabled; keep types explicit when shaping I/O.
- Use tabs for indentation; capability keys in lowerCamelCase.

## Testing Guidelines
- No test runner configured; validate with `npm run check` and end-to-end testing via `ntn workers exec`.
- Write a test script (e.g. `test.sh`) that exercises each tool capability using `ntn workers exec`. Use the `--local` flag for local execution or omit it to run against the deployed worker.

**Local execution** runs your worker code directly on your machine. Any `.env` file in the project root is automatically loaded, so secrets and config values are available via `process.env`.

**Remote execution** (without `--local`) runs against the deployed worker. Any required secrets must be pushed to the remote environment first using `ntn workers env push`.

**Example test script (`test.sh`):**
```shell
#!/usr/bin/env bash
set -euo pipefail

# Run locally (uses .env automatically):
ntn workers exec sayHello --local -d '{"name": "World"}'

# Or run against the deployed worker (requires `ntn workers deploy` and `ntn workers env push` first):
# ntn workers exec sayHello -d '{"name": "World"}'
```

Use this pattern to build up a suite of exec calls that covers each tool with representative inputs. Run `npm run check` first to catch type errors, then run your test script to verify end-to-end behavior.

## Commit & Pull Request Guidelines
- Messages typically use `feat(scope): ...`, `TASK-123: ...`, or version bumps.
- PRs should describe changes, list commands run, and update examples if behavior changes.
