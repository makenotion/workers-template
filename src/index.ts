import { Worker } from "@notionhq/workers";

const worker = new Worker();
export default worker;

type HelloInput = { name: string };

// Example agent tool that returns a greeting
// Delete this when you're ready to start building your own tools.
worker.tool<HelloInput, string>("sayHello", {
	title: "Say Hello",
	description: "Returns a friendly greeting for the given name.",
	schema: {
		type: "object",
		properties: {
			name: {
				type: "string",
				description: "The name to greet.",
			},
		},
		required: ["name"],
		additionalProperties: false,
	},
	execute: ({ name }) => `Hello, ${name}!`,
});
