/**
 * Webhooks are only available in a private alpha.
 */

import { Worker } from "@notionhq/workers";

const worker = new Worker();
export default worker;

/**
 * Example webhook that receives inbound HTTP requests and logs them.
 *
 * After deploying, the CLI prints the webhook URL. Register it with
 * any external service that supports outgoing webhooks.
 *
 * The execute handler receives an array of events (currently always
 * one, but the interface supports future batching).
 */
worker.webhook("onExternalEvent", {
	title: "External Event Webhook",
	description: "Handles inbound webhook events from an external service",
	execute: async (events, { notion }) => {
		for (const event of events) {
			console.log(`Received ${event.method} request`, event.body);

			// Example: create a Notion page for each webhook event
			// await notion.pages.create({
			//   parent: { database_id: "your-database-id" },
			//   properties: {
			//     Name: { title: [{ text: { content: "New event received" } }] },
			//   },
			// });
		}
	},
});
