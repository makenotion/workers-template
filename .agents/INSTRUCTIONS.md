# Repository Guidelines

## Project Structure & Module Organization
- `src/index.ts` defines the worker and capabilities.
- `.examples/` has focused samples (sync, tool, automation, OAuth).
- Generated: `dist/` build output, `workers.json` CLI config.

## Worker & Capability API (SDK)
`@notionhq/workers` provides `Worker`, schema helpers, and builders; the `ntn` CLI powers worker management.

### Agent tool calls

```ts
import { Worker } from "@notionhq/workers";

const worker = new Worker();
export default worker;

worker.tool("sayHello", {
	title: "Say Hello",
	description: "Return a greeting",
	schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
	execute: ({ name }, _context) => `Hello, ${name}`,
});
```

A worker with one or more tools is attachable to Notion agents. Each `tool` becomes a callable function for the agent:
- `title` and `description` are used both in the Notion UI as well as a helpful description to your agent.
- `schema` specifies what data the agent must supply.

### OAuth

```
const myOAuth = worker.oauth("myOAuth", {
	name: "my-provider",
	authorizationEndpoint: "https://provider.example.com/oauth/authorize",
	tokenEndpoint: "https://provider.example.com/oauth/token",
	scope: "read write",
	clientId: "1234567890",
	clientSecret: process.env.MY_CUSTOM_OAUTH_CLIENT_SECRET ?? "",
	authorizationParams: {
		access_type: "offline",
		prompt: "consent",
	},
});
```

The OAuth capability allows you to perform the three legged OAuth flow after specifying parameters of your OAuth client: `name`, `authorizationEndpoint`, `tokenEndpoint`, `clientId`, `clientSecret`, and `scope` (optional: `authorizationParams`, `callbackUrl`, `accessTokenExpireMs`).

After deploying a worker with an OAuth capability, the user must configure their OAuth provider's redirect URL to match the one assigned by Notion. Run `ntn workers oauth show-redirect-url` to get the redirect URL, then set it in the provider's OAuth app settings. **Always remind the user of this step after deploying any OAuth capability.**

### Other capabilities

There are additional capability types in the SDK but these are restricted to a private alpha. Only Agent tools and OAuth are generally available.

| Capability | Availability |
|------------|--------------|
| Agent tools | Generally available |
| OAuth (user-managed) | Generally available |
| OAuth (Notion-managed) | Private alpha |
| Syncs | Private alpha |
| Automations | Private alpha |

## Build, Test, and Development Commands
- Node >= 22 and npm >= 10.9.2 (see `package.json` engines).
- `npm run build`: compile TypeScript to `dist/`.
- `npm run check`: type-check only (no emit).
- `ntn login`: connect to a Notion workspace.
- `ntn workers deploy`: build and publish capabilities.
- `ntn workers exec <capability> -d '<json>'`: run a sync or tool. Run after `deploy` or with `--local`.

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

**Print out CLI configuration debug overview (Markdown):**
```shell
ntn debug
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
