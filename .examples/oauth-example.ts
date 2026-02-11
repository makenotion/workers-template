import { Worker } from "@notionhq/workers";

const worker = new Worker();
export default worker;

/**
 * OAuth capabilities let your worker access third-party APIs.
 *
 * After deploying your worker, start OAuth from the CLI:
 *
 *   ntn workers oauth start <capabilityKey>
 *
 * Where `capabilityKey` is the OAuth capability's key (see `ntn workers capabilities list`).
 * Once OAuth completes, the worker runtime exposes the access token via an
 * environment variable and `accessToken()` reads it for you.
 */

// Option 1: Notion-managed provider (recommended when available).
// Notion owns the OAuth app credentials and the backend has pre-configured provider settings.
// Notion-managed providers are only available in a private alpha.
const googleAuth = worker.oauth("googleAuth", {
	name: "google-calendar",
	provider: "google",
});

// Option 2: User-managed provider (you own the OAuth app credentials).
// Keep client credentials in worker secrets and read them from `process.env`.
// Generally available.
const myCustomAuth = worker.oauth("myCustomAuth", {
	name: "my-custom-provider",
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

// Use the OAuth handles in your capabilities
worker.sync("googleCalendarSync", {
	primaryKeyProperty: "eventId",
	schema: {
		defaultName: "Calendar Events",
		properties: {
			eventId: { type: "text" },
			title: { type: "title" },
		},
	},
	execute: async () => {
		// Get the OAuth access token
		const token = await googleAuth.accessToken();

		// Use token to fetch from Google Calendar API
		console.log("Using Google token:", `${token.slice(0, 10)}...`);

		return { changes: [], hasMore: false };
	},
});

worker.tool("customApiTool", {
	title: "Custom API Tool",
	description: "Calls a custom API using OAuth",
	schema: {
		type: "object",
		properties: {},
		required: [],
		additionalProperties: false,
	},
	execute: async () => {
		const token = await myCustomAuth.accessToken();
		console.log("Using custom provider token:", `${token.slice(0, 10)}...`);
		return { success: true };
	},
});
