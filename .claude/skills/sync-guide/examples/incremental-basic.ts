/**
 * Incremental mode — single opaque cursor for both backfill and delta.
 *
 * For APIs where one cursor serves both phases. This works when the API
 * sorts results by updated_at and returns an opaque pagination cursor.
 * The same cursor naturally transitions from "paginate everything" to
 * "paginate only new changes" — no explicit phase tracking needed.
 *
 * Example: Shopify GraphQL (sortKey: UPDATED_AT), any API with opaque
 * cursor pagination that returns results in modification order.
 *
 * Key points:
 * - State is just { cursor: string | null } — no phase discrimination
 * - First run: cursor is null, starts from the beginning
 * - Subsequent runs: cursor picks up where the last cycle left off
 * - The cursor never resets in incremental mode — it persists forever
 * - Cursor preservation: if the API returns no endCursor (empty page at
 *   frontier), keep the existing cursor rather than regressing to null
 */

import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

type CursorState = { cursor: string | null };

worker.sync("ordersSync", {
	mode: "incremental",
	primaryKeyProperty: "Order ID",
	schema: {
		defaultName: "Orders",
		properties: {
			Title: Schema.title(),
			"Order ID": Schema.richText(),
		},
	},
	execute: async (state: CursorState | undefined) => {
		const cursor = state?.cursor ?? null;

		// GraphQL query with Relay-style pagination, sorted by UPDATED_AT
		const query = `
      query ($after: String) {
        orders(first: 100, sortKey: UPDATED_AT, after: $after) {
          edges { node { id name } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

		const response = await fetch("https://shop.example.com/admin/api/graphql.json", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Access-Token": process.env.SHOP_TOKEN ?? "",
			},
			body: JSON.stringify({ query, variables: { after: cursor } }),
		});
		const { data } = await response.json();
		const { edges, pageInfo } = data.orders;

		return {
			changes: edges.map((edge: { node: { id: string; name: string } }) => ({
				type: "upsert" as const,
				key: edge.node.id,
				properties: {
					Title: Builder.title(edge.node.name),
					"Order ID": Builder.richText(edge.node.id),
				},
			})),
			hasMore: pageInfo.hasNextPage,
			nextState: {
				// Preserve existing cursor if API returns null (empty frontier)
				cursor: pageInfo.endCursor ?? cursor,
			},
		};
	},
});
