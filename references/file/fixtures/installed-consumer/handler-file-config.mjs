import { binding, defineConfig } from "@ykdz/dock";
import { file } from "@ykdz/dock-reference-file";

export default defineConfig({
  plugins: [file],
  bindings: [
    binding("handler-policy", [
      file.from("copy.md").reference("handler-reference"),
    ]),
  ],
  baseline: "handler-identity.baseline.json",
});
