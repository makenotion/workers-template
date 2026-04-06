# Notion Workers [alpha]

A worker is a small Node/TypeScript program hosted by Notion that you can use
to build tool calls for Notion custom agents and sync external data into Notion databases.

> [!WARNING]
>
> This is an **extreme pre-release alpha** of Notion Workers. You probably
> shouldn't use it for anything serious just yet. Also, it'll only be helpful
> if you have access to Notion Custom Agents (and a workspace admin [opts in](https://www.notion.so/?target=ai)). We are still making breaking
> changes to Notion Workers CLI, templates, and more. We aim to minimize
> friction, but expect things to go wrong.

## Quick Start

Install the `ntn` CLI:

```shell
npm i -g ntn
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

## Have a question?

Join the [Notion Dev Slack](https://join.slack.com/t/notiondevs/shared_invite/zt-3r1aq1t1s-hM2har7iqfOfHJRrH9PHww)!
