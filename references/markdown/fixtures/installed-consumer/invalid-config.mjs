import { markdown } from "@dock/reference-markdown";
import { binding, defineConfig } from "@dock/sdk";

const invalid = markdown
  .from("guide.md")
  .node({ type: "paragraph", language: "ts" })
  .reference("invalid");

export default defineConfig({
  plugins: [markdown],
  bindings: [binding("markdown-policy", [invalid])],
  baseline: "markdown.baseline.json",
});
