import { binding, defineConfig, file } from "@boringparts/dock";

import { transitiveReference } from "./transitive-middle.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("transitive-binding", [transitiveReference])],
  baseline: "transitive-binding.baseline.json",
});
