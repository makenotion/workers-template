/**
 * Syncs are only available in a private alpha.
 */

import { Worker } from "@project-ajax/sdk";
import * as Builder from "@project-ajax/sdk/builder";
import * as Schema from "@project-ajax/sdk/schema";

const worker = new Worker();
export default worker;

const projectId = "project-1";
const projectName = "Example Project";

worker.sync("projectsSync", {
	// Which field to use in each object as the primary key. Must be unique.
	primaryKeyProperty: "Project ID",
	// The schema of the collection to create in Notion.
	schema: {
		// Name of the collection to create in Notion.
		defaultName: "Projects",
		properties: {
			// See `Schema` for the full list of possible column types.
			"Project Name": Schema.title(),
			"Project ID": Schema.richText(),
		},
	},
	execute: async () => {
		// Fetch and return data
		return {
			changes: [
				// Each change must match the shape of `properties` above.
				{
					type: "upsert" as const,
					key: projectId,
					properties: {
						"Project Name": Builder.title(projectName),
						"Project ID": Builder.richText(projectId),
					},
				},
			],
			hasMore: false,
		};
	},
});

worker.sync("mySync", {
	// Which field to use in each object as the primary key. Must be unique.
	primaryKeyProperty: "ID",
	// The schema of the collection to create in Notion.
	schema: {
		// Name of the collection to create in Notion.
		defaultName: "My Data",
		properties: {
			// See `Schema` for the full list of possible column types.
			Title: Schema.title(),
			ID: Schema.richText(),
			Project: Schema.relation("projectsSync"),
		},
	},
	execute: async (_state, { notion: _notion }) => {
		// Fetch and return data
		return {
			changes: [
				// Each change must match the shape of `properties` above.
				{
					type: "upsert" as const,
					key: "1",
					properties: {
						Title: Builder.title("Item 1"),
						ID: Builder.richText("1"),
						Project: [Builder.relation(projectId)],
					},
				},
			],
			hasMore: false,
		};
	},
});
