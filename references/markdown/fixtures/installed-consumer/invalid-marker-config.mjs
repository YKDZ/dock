import { binding, defineConfig } from "@ykdz/dock";
import { markdown } from "@ykdz/dock-reference-markdown";

const reference = markdown
  .from("guide.md")
  .marker("")
  .reference("empty-marker");

export default defineConfig({
  plugins: [markdown],
  bindings: [binding("invalid-marker", [reference])],
  baseline: "markdown.baseline.json",
});
