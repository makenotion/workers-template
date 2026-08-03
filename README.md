# Workflows in Notion Workers

> [!WARNING]
> Workflows are a very early alpha feature of Notion Workers. The SDK is under heavy development. Expect breaking changes. A deployed Worker that uses Workflows may stop working without warning.

Workflows are part of Notion Workers. They let your Worker run an automation when an event happens. The event that starts a Workflow is called a **trigger**.

A Workflow can use the same range of triggers as a Notion Custom Agent. For example, a Workflow can start when:

- a schedule runs;
- a Slack message is posted;
- a Gmail message arrives;
- a Notion page changes;
- a calendar event changes; or
- another supported Custom Agent trigger fires.

Workflows are **durable**. If a run fails, Notion automatically retries it up to two times. When a step has already finished, Notion saves its result. A retry uses the saved result instead of running that step again.

## Create a Workflow

Put each Workflow in a TypeScript file directly inside `src/workflows/`. The file name becomes the Workflow key.

This Workflow starts when a page is added to a Notion database. It sends the page to another service:

```ts
import { triggers } from "@notionhq/workers/alpha/triggers";
import { createWorkflow } from "@notionhq/workers/alpha/workflow";

export default createWorkflow({
  title: "Send new page",
  description: "Sends each new database page to another service.",
  triggers: [triggers.notionPageCreated()],
  handler: async (event, context) => {
    const payload = {
      url: event.url,
      content: event.content,
    };

    await context.step("Send page to service", async ({ id }) => {
      const serviceUrl = process.env.SERVICE_URL;
      if (!serviceUrl) {
        throw new Error("SERVICE_URL is required");
      }

      const response = await fetch(serviceUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": id,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }

      return { status: response.status };
    });
  },
});
```

The `triggers` list says what can start the Workflow. TypeScript uses this list to learn the shape of `event`. The `handler` holds the code that runs for each event.

The example reads `SERVICE_URL` from the environment. Do not put secrets or private URLs in source code. For local work, place them in `.env`. After deployment, push them with:

```shell
ntn workers env push
```

## Steps

A step is a named part of a Workflow. Create one with `context.step(name, callback)` and always wait for it with `await`.

Steps give Workflows their durability. After a step finishes, Notion saves its result. If a later part fails, a retry can use that saved result and continue. It does not need to repeat the finished work.

Use a step for work that reads changing data or causes an outside effect. This includes:

- calling an API;
- reading or writing a Notion page;
- sending a Slack message or email;
- creating or updating a record;
- reading the current time; and
- making a random value or ID.

Code that only changes values already in memory can stay outside a step. In the example, building `payload` from the event is safe outside the step. The network request belongs inside the step.

Steps are not required by the TypeScript API. A handler can run code without them. However, code outside a step does not get saved results. It may run again after a failure. Use steps for any work that must be safe during a retry.

Follow these rules when you add steps:

1. Give every step a unique and stable name.
2. Keep steps in the same order on every attempt.
3. Return only JSON-safe values, such as strings, numbers, arrays, plain objects, `true`, `false`, or `null`.
4. Return any value that later code needs. Do not depend on a change made only in memory inside a step.
5. Let real failures throw an error so Notion can mark the run as failed and retry it.
6. Make outside writes safe to repeat.

The callback receives an `id`. When an outside service supports idempotency keys, send this ID with the request. An idempotency key helps the service reject a duplicate write.

This matters because an outside request can succeed just before the step reports a failure. In that case, a retry may send the request again. If the service does not support idempotency keys, use another check, such as a stable record ID or an upsert.

## Execution guarantees

Notion makes an effort to run each Workflow and each step as close to one time as possible. If a Workflow runs to completion before its retries are exhausted, the guarantee is **at least once**. This means it may run more than once. Workflows do not have an exactly-once guarantee.

A failed run may have up to two automatic retries. These are more attempts of the same run. A completed step is not run again during an automatic retry because its saved result is used.

Do not build a Workflow that depends on exactly-once delivery. Make important writes safe to repeat, and check the final state when a missed or repeated action would be harmful.

## Notion and Custom Agent APIs

A Workflow can call the Notion API. It can also call Custom Agents if you have access to the Custom Agents API.

Both the Workflows API and the Custom Agents API are in alpha and under heavy development. Their names, types, behavior, and access rules may change. Code that uses either API may need updates at any time.

Use the least access your Workflow needs. Never log access tokens, email bodies, Slack messages, or other private data unless you have a clear reason and permission to do so.

## Build, deploy, and configure

Check and build the Worker before deployment:

```shell
npm run check
npm run build
```

Then sign in and deploy it:

```shell
ntn login
ntn workers deploy
ntn workers env push
```

Deployment does not finish setup. After every Workflow deployment, go to [app.notion.com/developers/workers](https://app.notion.com/developers/workers) and configure the Workflow. Choose its trigger details, connect the needed accounts, add access to the right Notion content, and confirm any required environment settings.

Run the Workflow with a test event before using it for important work.

## Debug a run

Use the run history and logs to find the first error and the last completed step:

```shell
ntn workers runs list
ntn workers runs logs <run-id>
```
