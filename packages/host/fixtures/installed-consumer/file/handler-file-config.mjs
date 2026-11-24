import { binding, defineConfig, file } from "@ykdz/dock";

export default defineConfig({
  plugins: [file],
  bindings: [
    binding("handler-policy", [
      file.from("copy.md").reference("handler-reference"),
    ]),
  ],
  baseline: "handler-identity.baseline.json",
});
