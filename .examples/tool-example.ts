/**
 * Tools are generally available.
 */

import { Worker } from "@notionhq/workers";

const worker = new Worker();
export default worker;

worker.tool<
	{ query?: string | null; limit?: number | null },
	{ results: string[] }
>("myTool", {
	title: "My Tool",
	// Description of what this tool does - shown to the AI agent
	description: "Search for items by keyword or ID",
	// JSON Schema for the input the tool accepts
	schema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				nullable: true,
				description: "The search query",
			},
			limit: {
				type: "number",
				nullable: true,
				description: "Maximum number of results",
			},
		},
		required: [],
		additionalProperties: false,
	},
	// Optional: JSON Schema for the output the tool returns
	outputSchema: {
		type: "object",
		properties: {
			results: {
				type: "array",
				items: { type: "string" },
			},
		},
		required: ["results"],
		additionalProperties: false,
	},
	// The function that executes when the tool is called
	execute: async (input, { notion: _notion }) => {
		// Destructure input with default values
		const { query: _query, limit: _limit = 10 } = input;

		// Perform your logic here
		// Example: search your data source using the query and limit
		const results: string[] = [];

		// Return data matching your outputSchema (if provided)
		return { results };
	},
});
