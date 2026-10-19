import { binding, defineConfig } from "@ykdz/dock";
import { file } from "@ykdz/dock-reference-file";
import { dependencyReference } from "current-config-declarations";

export default defineConfig({
  plugins: [file],
  bindings: [binding("dependency-binding", [dependencyReference])],
  baseline: "dependency-binding.baseline.json",
});
