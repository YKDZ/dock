import { file } from "@dock/reference-file";
import { binding, defineConfig } from "@dock/sdk";
import { dependencyReference } from "current-config-declarations";

export default defineConfig({
  plugins: [file],
  bindings: [binding("dependency-binding", [dependencyReference])],
  baseline: "dependency-binding.baseline.json",
});
