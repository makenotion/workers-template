# Repository Guidelines

## Project Structure & Module Organization

- `src/index.ts` defines the worker and capabilities.
- `.examples/` has focused samples (sync, tool, automation, OAuth).
- Generated: `dist/` build output, `workers.json` CLI config.

## Worker & Capability API (SDK)

`@project-ajax/sdk` provides `Worker`, schema helpers, and builders; the `ntn` CLI powers worker management.

### Agent tool calls

```ts
import { Worker } from "@project-ajax/sdk";

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
- `schema` is a JSON schema that specifies what data the agent must supply.

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
- No test runner configured; validate with `npm run check` and a deploy/exec loop.

## Commit & Pull Request Guidelines
- Messages typically use `feat(scope): ...`, `TASK-123: ...`, or version bumps.
- PRs should describe changes, list commands run, and update examples if behavior changes.
