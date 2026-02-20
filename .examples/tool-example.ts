/**
 * Tools are generally available.
 */

import { Worker } from "@notionhq/workers";
import * as J from "@notionhq/workers/json-schema-builder";

const worker = new Worker();
export default worker;

// JSON Schema for the input the tool accepts
const inputSchema = J.object({
	query: J.nullable(J.string({ description: "The search query" })),
	limit: J.nullable(J.number({ description: "Maximum number of results" })),
});

// Optional: JSON Schema for the output the tool returns
const outputSchema = J.object({
	results: J.array(J.string()),
});

worker.tool<J.Infer<typeof inputSchema>, J.Infer<typeof outputSchema>>(
	"myTool",
	{
		title: "My Tool",
		// Description of what this tool does - shown to the AI agent
		description: "Search for items by keyword or ID",
		schema: inputSchema,
		outputSchema: outputSchema,
		// The function that executes when the tool is called
		execute: async (input, { notion: _notion }) => {
			// Destructure input with default values
			const { query: _query, limit: _limit } = input;

			// Perform your logic here
			// Example: search your data source using the query and limit
			const results: string[] = [];

			// Return data matching your outputSchema (if provided)
			return { results };
		},
	},
);
