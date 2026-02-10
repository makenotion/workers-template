# Notion Workers [alpha]

A worker is a small Node/TypeScript program hosted by Notion that you can use
to build tool calls for Notion custom agents.

> [!WARNING]
>
> This is a **extreme pre-release alpha** of Notion Workers. You probably
> shouldn't use it for anything serious just yet. Also, it'll only be helpful
> if you have access to Notion custom agents.

## Quick Start

```shell
ntn workers new
# Follow the prompts to scaffold your worker
cd my-worker
```

You'll find a `Hello, world` example in `src/index.ts`:

```ts
import { Worker } from "@project-ajax/sdk";

const worker = new Worker();
export default worker;

worker.tool("sayHello", {
	title: "Say Hello",
	description: "Returns a friendly greeting for the given name.",
	schema: {
		type: "object",
		properties: {
			name: { type: "string", description: "The name to greet." },
		},
		required: ["name"],
		additionalProperties: false,
	},
	execute: ({ name }) => `Hello, ${name}!`,
});
```

Deploy your worker:

```shell
ntn workers deploy
```

In Notion, add the tool call to your agent:

![Adding a custom tool to your Notion agent](docs/custom-tool.png)

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

Start the OAuth flow:

```shell
ntn workers oauth start githubAuth
```

Use the token in your tools:

```ts
worker.tool("getGitHubRepos", {
	title: "Get GitHub Repos",
	description: "Fetch user's GitHub repositories",
	schema: {
		type: "object",
		properties: {},
		additionalProperties: false,
	},
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
<summary><strong>Give Agents a phone with Twilio</strong></summary>

```ts
worker.tool("sendSMS", {
	title: "Send SMS",
	description: "Send a text message to a phone number",
	schema: {
		type: "object",
		properties: {
			to: { type: "string", description: "Phone number in E.164 format" },
			message: { type: "string", description: "Message to send" },
		},
		required: ["to", "message"],
		additionalProperties: false,
	},
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
	schema: {
		type: "object",
		properties: {
			message: { type: "string", description: "Message to post" },
		},
		required: ["message"],
		additionalProperties: false,
	},
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
	schema: {
		type: "object",
		properties: {
			content: { type: "string", description: "Page content to convert" },
			voiceId: { type: "string", description: "ElevenLabs voice ID" },
		},
		required: ["content", "voiceId"],
		additionalProperties: false,
	},
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
	schema: {
		type: "object",
		properties: {
			location: { type: "string", description: "City name or zip code" },
		},
		required: ["location"],
		additionalProperties: false,
	},
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

# Manage authentication
ntn login
ntn logout

# Store API keys and secrets
ntn workers env set API_KEY=your-secret

# View execution logs
ntn workers runs logs <runId>

# Start OAuth flow
ntn workers oauth start <oauthName>

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
