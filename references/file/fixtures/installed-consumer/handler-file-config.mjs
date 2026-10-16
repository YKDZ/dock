import { file } from "@dock/reference-file";
import { binding, defineConfig } from "@dock/sdk";

export default defineConfig({
  plugins: [file],
  bindings: [
    binding("handler-policy", [
      file.from("copy.md").reference("handler-reference"),
    ]),
  ],
  baseline: "handler-identity.baseline.json",
});
