---
name: custom-blocks
description: Build or modify a custom-block frontend inside a Notion Worker. Use only when root instructions describe the capability and the user confirms the target workspace is enrolled in the private alpha.
user-invocable: false
---

# Custom blocks

## Access gate

Read the project's root `AGENTS.md` before doing anything. Continue only when it describes the custom-block capability and the user confirms that the target workspace is enrolled in the worker custom-block alpha. If access is unknown, ask before changing code. If root instructions say the capability is unavailable, stop.

Custom blocks are a private alpha. The `ntn workers new --alpha` flag, installed SDK, and this skill do not grant workspace entitlement.

## Architecture

A worker custom block has two SDK surfaces:

- `@notionhq/workers` declares the block's build source and expected data-source schemas in `src/index.ts`.
- `@notionhq/custom-blocks` runs inside the sandboxed iframe and exposes the host through React hooks.

Keep one package at the worker root. Put frontend source under `views/<key>/`, but do not create a nested `package.json`. Install frontend dependencies in the worker's existing root package. Build and deploy through the worker tooling; do not run `ncblock connect` or `ncblock deploy`.

## Read current SDK documentation

Install `@notionhq/custom-blocks`, then start with its shipped README:

- `node_modules/@notionhq/custom-blocks/README.md`

Read `docs/lifecycle.md` and `docs/manifest.md` while scaffolding. Read the task-relevant document before using data sources, block location, pages, users, or structured errors. The SDK is pre-release: treat its installed docs and `.d.ts` files as authoritative when they differ from examples here. For the `worker.customBlock()` declaration, use the installed `@notionhq/workers` types as the authority.

## Create a project-backed block

Install dependencies from the worker root:

```shell
npm install @notionhq/custom-blocks
npm install --save-dev react react-dom @types/react @types/react-dom vite @vitejs/plugin-react
```

Use this shape:

```text
views/<key>/
  custom_blocks.json
  index.html
  tsconfig.json
  vite.config.ts
  src/
    index.tsx
```

The HTML must mount the app at `<div id="root"></div>`. Configure Vite with the SDK plugin:

```ts
import { notionCustomBlock } from "@notionhq/custom-blocks/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), notionCustomBlock()],
});
```

The worker's root TypeScript config does not cover frontend files. Give the view this dedicated `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["vite/client"],
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "jsx": "react-jsx"
  },
  "include": ["src", "vite.config.ts"]
}
```

Declare the block in `src/index.ts`. `path` is relative to the worker root, and `command` runs inside that directory:

```ts
worker.customBlock("issueBoard", {
  path: "./views/issue-board",
  command: "npx vite build",
  version: 1,
  dataSources: {
    issues: {
      name: "Issues",
      description: "Rows shown by the issue board",
      properties: {
        title: { name: "Title", type: "title" },
        status: { name: "Status", type: "status" },
      },
    },
  },
});
```

The `dataSources` declaration is a schema, not a binding to a concrete database. Semantic data-source and property keys are author-defined and become the keys used by the iframe SDK. Concrete bindings are selected when a block instance is configured.

For local Vite development, keep `views/<key>/custom_blocks.json` equivalent to the worker declaration:

```json
{
  "version": 1,
  "dataSources": {
    "issues": {
      "name": "Issues",
      "description": "Rows shown by the issue board",
      "properties": {
        "title": { "name": "Title", "type": "title" },
        "status": { "name": "Status", "type": "status" }
      }
    }
  }
}
```

Use `{ "version": 1, "dataSources": {} }` when the block reads no host data. The Vite plugin serves this file during development; worker deployment uses the `worker.customBlock()` declaration.

Use `type: "static"` only when `path` already contains built browser assets:

```ts
worker.customBlock("issueBoard", {
  type: "static",
  path: "./views/issue-board/dist",
});
```

## Initialize the iframe SDK

Wrap the application in `<NotionCustomBlock>`. It performs the host handshake and provides auto-resizing by default:

```tsx
import { NotionCustomBlock } from "@notionhq/custom-blocks/react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <NotionCustomBlock>
    <App />
  </NotionCustomBlock>,
);
```

Inside the wrapper, use hooks from `@notionhq/custom-blocks/react`. Never call `window.parent.postMessage` directly. For declared data, call `useDataSource("<semantic-key>")`, validate values read from `propertiesByKey`, and surface loading, empty, and error states. Use each row's `update` helper when a row is already available. Read `docs/data-sources.md` for current result and value shapes before implementing this code.

## Sandbox and layout constraints

- No direct network requests. Data and mutations cross the host bridge through SDK APIs.
- No top-level navigation, `window.open`, or authentication redirects.
- The host owns iframe width and height. Avoid hard-coded widths and `100vh`.
- Prefer intrinsic height and container queries. `<NotionCustomBlock>` auto-resizes `#root`; use `autoResize={false}` only for intentional full-bleed layouts.
- Keep interactive UI keyboard-reachable and expose loading and failures accessibly.

## Develop and verify

Start Vite from the view directory so it finds the local manifest while resolving dependencies from the worker root:

```shell
cd views/<key>
npx vite
```

Preview either in a live Notion custom block pointed at the Vite URL or against the custom-block SDK's mock host. Before deployment:

```shell
cd views/<key> && npx vite build
cd ../.. && npx tsc --noEmit -p views/<key>/tsconfig.json
npm run check
ntn workers deploy
```

Do not use `ntn workers exec` for a custom block; it is a build-time/deploy-time capability and has no `execute` handler.

Deployment creates or updates the custom-block definition; it does not create a block instance on a page. After deploying:

1. Run `ntn workers capabilities list --json` and find the custom block's definition ID.
2. Create a `custom_block` under the target page through the Notion UI or Public API.
3. Update that block with the definition ID and concrete `data_sources` bindings required by the declared semantic keys.

Use the current Public API request shapes rather than guessing them. A definition without a block instance, or an instance without required data-source bindings, is not a complete verification.
