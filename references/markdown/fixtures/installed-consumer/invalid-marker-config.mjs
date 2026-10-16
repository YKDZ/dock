import { markdown } from "@dock/reference-markdown";
import { binding, defineConfig } from "@dock/sdk";

const reference = markdown
  .from("guide.md")
  .marker("")
  .reference("empty-marker");

export default defineConfig({
  plugins: [markdown],
  bindings: [binding("invalid-marker", [reference])],
  baseline: "markdown.baseline.json",
});
