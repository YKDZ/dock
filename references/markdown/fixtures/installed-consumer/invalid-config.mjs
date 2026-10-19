import { binding, defineConfig } from "@ykdz/dock";
import { markdown } from "@ykdz/dock-reference-markdown";

const invalid = markdown
  .from("guide.md")
  .node({ type: "paragraph", language: "ts" })
  .reference("invalid");

export default defineConfig({
  plugins: [markdown],
  bindings: [binding("markdown-policy", [invalid])],
  baseline: "markdown.baseline.json",
});
