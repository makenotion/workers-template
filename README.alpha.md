# Notion Workers [beta]

A worker is a small Node/TypeScript program hosted by Notion that you can use
to build tool calls for Notion custom agents, sync external data into Notion databases, and receive webhook events from external services.

> [!NOTE]
>
> Notion Workers is currently in beta. APIs, CLI commands, templates, and
> hosting behavior may continue to evolve.

## Quick Start

Install the `ntn` CLI:

```shell
curl -fsSL https://ntn.dev | bash
```

Scaffold a new worker:

```shell
ntn workers new
# Follow the prompts to scaffold your worker
cd my-worker
```

You'll find a `Hello, world` example in `src/index.ts`:

```ts
import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

worker.tool("sayHello", {
	title: "Say Hello",
	description: "Returns a friendly greeting for the given name.",
	schema: j.object({
		name: j.string().describe("The name to greet."),
	}),
	execute: ({ name }) => `Hello, ${name}!`,
});
```

Deploy your worker:

```shell
ntn workers deploy
```

In Notion, add the tool call to your agent:

![Adding a custom tool to your Notion agent](docs/custom-tool.png)

## Syncing External Data

Workers can sync data from any external source into Notion databases. Each sync creates and maintains a database that stays up to date automatically.

```ts
import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

worker.sync("issuesSync", {
	primaryKeyProperty: "Issue ID",
	schema: {
		defaultName: "Issues",
		properties: {
			Title: Schema.title(),
			"Issue ID": Schema.richText(),
		},
	},
	execute: async () => {
		const issues = await fetchIssues(); // your data source
		return {
			changes: issues.map((issue) => ({
				type: "upsert" as const,
				key: issue.id,
				properties: {
					Title: Builder.title(issue.title),
					"Issue ID": Builder.richText(issue.id),
				},
			})),
			hasMore: false,
		};
	},
});
```

After deploying, your sync runs automatically on a schedule (default: every 30 minutes). Monitor it with:

```shell
ntn workers sync status
```

> [!NOTE]
> Deploying does **not** reset sync state — syncs resume from their last cursor position. To restart a sync from scratch, use `ntn workers sync state reset <key>`.

## Webhooks quickstart

A webhook exposes an HTTP endpoint that external services (GitHub, Stripe, etc.) can call to push events into your worker:

```ts
import { Worker } from "@notionhq/workers";

const worker = new Worker();
export default worker;

worker.webhook("onExternalEvent", {
	title: "External Event Handler",
	description: "Processes incoming webhook requests",
	execute: async (events) => {
		for (const event of events) {
			console.log("Delivery:", event.deliveryId);
			console.log("Method:", event.method);
			console.log("Body:", event.body);
		}
	},
});
```

Deploy and grab the webhook URL to give to the external service:

```shell
ntn workers deploy
ntn workers webhooks list
```

## Webhooks reference

### The event object

The `execute` function receives an array of `WebhookEvent` objects:

| Property | Type | Description |
| :-- | :-- | :-- |
| `deliveryId` | `string` | Unique ID for this delivery, stable across retries. |
| `body` | `Record<string, unknown>` | Parsed JSON body (`{}` if not a JSON object). |
| `rawBody` | `string` | Original request body as a string. Use for signature verification. |
| `headers` | `Record<string, string>` | Request headers (lowercased names). |
| `method` | `string` | HTTP method (webhook URLs accept `POST`). |

### Verifying requests

Most webhook providers sign requests with a shared secret. Verify using `event.rawBody` and `event.headers`, and throw `WebhookVerificationError` when verification fails:

```ts
import * as crypto from "node:crypto";
import { WebhookVerificationError, Worker } from "@notionhq/workers";

const worker = new Worker();
export default worker;

function verifyGitHubSignature(
	rawBody: string,
	headers: Record<string, string>,
): void {
	const secret = process.env.GITHUB_WEBHOOK_SECRET;
	if (!secret) {
		throw new WebhookVerificationError("GITHUB_WEBHOOK_SECRET not configured");
	}

	const signature = headers["x-hub-signature-256"];
	if (!signature?.startsWith("sha256=")) {
		throw new WebhookVerificationError("Invalid GitHub signature");
	}

	const expected = `sha256=${crypto
		.createHmac("sha256", secret)
		.update(rawBody)
		.digest("hex")}`;

	if (
		signature.length !== expected.length ||
		!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
	) {
		throw new WebhookVerificationError("Invalid GitHub signature");
	}
}

worker.webhook("onGithubPush", {
	title: "GitHub Push Webhook",
	description: "Handles push events from GitHub repositories",
	execute: async (events) => {
		for (const event of events) {
			verifyGitHubSignature(event.rawBody, event.headers);
			console.log("Verified GitHub event:", event.body);
		}
	},
});
```

Store the signing secret before deploying:

```shell
ntn workers env set GITHUB_WEBHOOK_SECRET=your-secret
```

> [!WARNING]
> After 5 consecutive `WebhookVerificationError` failures, Notion blocks the webhook. Redeploy the worker to reset the counter.

### Webhook URLs

Each webhook gets a unique URL that acts as a shared secret:

```text
https://www.notion.so/webhooks/worker/{spaceId}/{workerId}/{uniqueWebhookId}/{webhookName}
```

Use the CLI to view URLs:

```shell
ntn workers webhooks list
```

> [!WARNING]
> Treat webhook URLs as secrets. Anyone with the full URL can send events unless you add signature verification.

### Execution and retries

Webhook requests are acknowledged with `202 Accepted` and your handler runs asynchronously. If your handler throws a non-verification error, Notion retries the run up to 3 times. `WebhookVerificationError` is never retried.

### Webhook CLI commands

```shell
ntn workers webhooks list              # show webhook URLs
```

## Authentication & Secrets

If your worker needs to access third-party systems, use secrets for API keys and OAuth for user authorization flows.

### Secrets

Store API keys and credentials with the `secrets` command:

```shell
ntn workers env set TWILIO_AUTH_TOKEN=your-token-here
ntn workers env set OPENWEATHER_API_KEY=abc123
```

For local development, pull the secrets to a `.env` file:

```shell
ntn workers env pull
```

Access them in your code via `process.env`:

```ts
const apiKey = process.env.OPENWEATHER_API_KEY;
```

### OAuth

For services requiring user authorization (GitHub, Google, etc.), set up OAuth:

```ts
worker.oauth("githubAuth", {
	name: "github-oauth",
	authorizationEndpoint: "https://github.com/login/oauth/authorize",
	tokenEndpoint: "https://github.com/login/oauth/access_token",
	scope: "repo user",
	clientId: process.env.GITHUB_CLIENT_ID ?? "",
	clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
});
```

After deploying, get your redirect URL and add it to your OAuth provider's app settings:

```shell
ntn workers oauth show-redirect-url
```

Then start the OAuth flow:

```shell
ntn workers oauth start githubAuth
```

Use the token in your tools:

```ts
worker.tool("getGitHubRepos", {
	title: "Get GitHub Repos",
	description: "Fetch user's GitHub repositories",
	schema: j.object({}),
	execute: async () => {
		const token = await githubAuth.accessToken();
		const response = await fetch("https://api.github.com/user/repos", {
			headers: { Authorization: `Bearer ${token}` },
		});
		return response.json();
	},
});
```

## What you can build

<details open>
<summary><strong>Sync external data into Notion</strong></summary>

```ts
worker.sync("customersSync", {
	primaryKeyProperty: "Customer ID",
	schema: {
		defaultName: "Customers",
		properties: {
			Name: Schema.title(),
			"Customer ID": Schema.richText(),
			Email: Schema.richText(),
		},
	},
	execute: async (state) => {
		const page = state?.page ?? 1;
		const { customers, hasMore } = await fetchCustomers(page);
		return {
			changes: customers.map((c) => ({
				type: "upsert" as const,
				key: c.id,
				properties: {
					Name: Builder.title(c.name),
					"Customer ID": Builder.richText(c.id),
					Email: Builder.richText(c.email),
				},
			})),
			hasMore,
			nextState: hasMore ? { page: page + 1 } : undefined,
		};
	},
});
```

</details>

<details>
<summary><strong>Give Agents a phone with Twilio</strong></summary>

```ts
worker.tool("sendSMS", {
	title: "Send SMS",
	description: "Send a text message to a phone number",
	schema: j.object({
		to: j.string().describe("Phone number in E.164 format"),
		message: j.string().describe("Message to send"),
	}),
	execute: async ({ to, message }) => {
		const response = await fetch(
			`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
			{
				method: "POST",
				headers: {
					Authorization: `Basic ${Buffer.from(
						`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`,
					).toString("base64")}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					To: to,
					From: process.env.TWILIO_PHONE_NUMBER ?? "",
					Body: message,
				}),
			},
		);

		if (!response.ok) throw new Error(`Twilio API error: ${response.statusText}`);
		return "Message sent successfully";
	},
});
```

</details>

<details>
<summary><strong>Post to Discord, WhatsApp, and Teams</strong></summary>

```ts
worker.tool("postToDiscord", {
	title: "Post to Discord",
	description: "Send a message to a Discord channel",
	schema: j.object({
		message: j.string().describe("Message to post"),
	}),
	execute: async ({ message }) => {
		const response = await fetch(process.env.DISCORD_WEBHOOK_URL ?? "", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: message }),
		});

		if (!response.ok) throw new Error(`Discord API error: ${response.statusText}`);
		return "Posted to Discord";
	},
});
```

</details>

<details>
<summary><strong>Turn a Notion Page into a Podcast with ElevenLabs</strong></summary>

```ts
worker.tool("createPodcast", {
	title: "Create Podcast from Page",
	description: "Convert page content to audio using ElevenLabs",
	schema: j.object({
		content: j.string().describe("Page content to convert"),
		voiceId: j.string().describe("ElevenLabs voice ID"),
	}),
	execute: async ({ content, voiceId }) => {
		const response = await fetch(
			`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
			{
				method: "POST",
				headers: {
					"xi-api-key": process.env.ELEVENLABS_API_KEY ?? "",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ text: content, model_id: "eleven_monolingual_v1" }),
			},
		);

		if (!response.ok) throw new Error(`ElevenLabs API error: ${response.statusText}`);
		const audioBuffer = await response.arrayBuffer();
		return `Generated ${audioBuffer.byteLength} bytes of audio`;
	},
});
```

</details>

<details>
<summary><strong>Get live stocks, weather, and traffic</strong></summary>

```ts
worker.tool("getWeather", {
	title: "Get Weather",
	description: "Get current weather for a location",
	schema: j.object({
		location: j.string().describe("City name or zip code"),
	}),
	execute: async ({ location }) => {
		const response = await fetch(
			`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${process.env.OPENWEATHER_API_KEY}&units=metric`,
		);

		if (!response.ok) throw new Error(`Weather API error: ${response.statusText}`);

		const data = await response.json();
		return `${data.name}: ${data.main.temp}°C, ${data.weather[0].description}`;
	},
});
```
</details>

## Helpful CLI commands

```shell
# Deploy your worker to Notion
ntn workers deploy

# Test a tool locally
ntn workers exec <toolName>

# Monitor sync status (live-updating)
ntn workers sync status

# Preview sync output without writing to the database
ntn workers sync trigger <syncKey> --preview

# Trigger a real sync immediately (writes to the database, bypasses schedule)
ntn workers sync trigger <syncKey>

# Reset sync state (restart from scratch)
ntn workers sync state reset <syncKey>

# List all capabilities
ntn workers capabilities list

# Pause / resume a sync
ntn workers capabilities disable <syncKey>
ntn workers capabilities enable <syncKey>

# List webhook URLs
ntn workers webhooks list

# Manage authentication
ntn login
ntn logout

# Store API keys and secrets
ntn workers env set API_KEY=your-secret

# View execution logs
ntn workers runs logs <runId>

# Start OAuth flow
ntn workers oauth start <oauthName>

# Show OAuth redirect URL (set this in your provider's app settings)
ntn workers oauth show-redirect-url

# Display help for all commands
ntn --help
```

## Local Development

```shell
npm run check # type-check
npm run build # emit dist/
```

Store secrets in `.env` for local development:

```shell
ntn workers env pull
```

## Learn more

Read the full [Workers documentation](https://developers.notion.com/workers/get-started/overview) or join the [Notion Dev Slack](https://join.slack.com/t/notiondevs/shared_invite/zt-3r1aq1t1s-hM2har7iqfOfHJRrH9PHww).
