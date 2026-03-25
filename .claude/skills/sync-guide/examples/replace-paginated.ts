/**
 * Replace mode — paginated API.
 *
 * Fetches all records page by page. Each cycle re-fetches everything.
 * The runtime deletes any records not seen during the cycle.
 *
 * Key points:
 * - State is just within-cycle pagination: { page: number }
 * - State effectively resets between cycles (each cycle starts from page 1)
 * - hasMore: true while there are more pages to fetch
 * - Batch size ~100 to avoid overloading a single execute call
 */

import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

// State is simple — just track which page we're on within this cycle
type PaginationState = { page: number };

worker.sync("productsSync", {
	mode: "replace",
	primaryKeyProperty: "Product ID",
	schema: {
		defaultName: "Products",
		properties: {
			Name: Schema.title(),
			"Product ID": Schema.richText(),
		},
	},
	execute: async (state: PaginationState | undefined) => {
		const page = state?.page ?? 1;
		const pageSize = 100;

		// Fetch one page from the API
		const response = await fetch(
			`https://api.example.com/products?page=${page}&limit=${pageSize}`,
			{ headers: { Authorization: `Bearer ${process.env.API_TOKEN}` } },
		);
		const data = await response.json();

		const hasMore = data.products.length === pageSize;

		return {
			changes: data.products.map(
				(product: { id: string; name: string }) => ({
					type: "upsert" as const,
					key: product.id,
					properties: {
						Name: Builder.title(product.name),
						"Product ID": Builder.richText(product.id),
					},
				}),
			),
			hasMore,
			// Next page, or undefined if done (cycle complete)
			nextState: hasMore ? { page: page + 1 } : undefined,
		};
	},
});
