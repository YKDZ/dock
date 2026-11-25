import { binding, defineConfig, file } from "@boringparts/dock";
import { dependencyReference } from "current-config-declarations";

export default defineConfig({
  plugins: [file],
  bindings: [binding("dependency-binding", [dependencyReference])],
  baseline: "dependency-binding.baseline.json",
});
