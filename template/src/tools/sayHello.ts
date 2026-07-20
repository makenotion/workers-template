import { createTool } from "@notionhq/workers/alpha/tool";
import * as Schema from "@notionhq/workers/alpha/schema-builder";

export default createTool({
  title: "Say Hello",
  description: "A simple tool that says hello to the user.",
  schema: Schema.object({
    name: Schema.string().describe("The name of the user to greet."),
  }),
  hints: {
    readOnlyHint: true,
  },
  execute: async ({ name }) => {
    return `Hello, ${name}!`;
  },
});
