import { markdown } from "@dock/reference-markdown";
import { binding, defineConfig } from "@dock/sdk";

const target = process.env.DOCK_MARKDOWN_SCOPE_TARGET ?? "scope-old.md";
const reference = markdown.from(target).reference("scope-markdown");

export default defineConfig({
  baseline: "scope.baseline.json",
  plugins: [markdown],
  bindings: [binding("scope-markdown-policy", [reference])],
});
