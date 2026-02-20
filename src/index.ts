import { Worker } from "@notionhq/workers";
import * as J from "@notionhq/workers/json-schema-builder";

const worker = new Worker();
export default worker;

// Example agent tool that returns a greeting
// Delete this when you're ready to start building your own tools.
const helloSchema = J.object({
	name: J.string({ description: "The name to greet." }),
});

worker.tool<J.Infer<typeof helloSchema>, string>("sayHello", {
	title: "Say Hello",
	description: "Returns a friendly greeting for the given name.",
	schema: helloSchema,
	execute: ({ name }) => `Hello, ${name}!`,
});
