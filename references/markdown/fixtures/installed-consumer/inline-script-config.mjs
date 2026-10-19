import { binding, defineConfig } from "@ykdz/dock";
import { markdown } from "@ykdz/dock-reference-markdown";

export const sample = markdown
  .from("inline-script-guide.md")
  .marker("sample")
  .reference("sample");
export const whole = markdown.from("inline-script-guide.md").reference("whole");

export const config = defineConfig({
  root: process.cwd(),
  plugins: [markdown],
  bindings: [binding("inline-script-policy", [sample])],
  baseline: "inline-script.baseline.json",
});

export default config;
