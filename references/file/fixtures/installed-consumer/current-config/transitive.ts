import { file } from "@dock/reference-file";
import { binding, defineConfig } from "@dock/sdk";

import { transitiveReference } from "./transitive-middle.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("transitive-binding", [transitiveReference])],
  baseline: "transitive-binding.baseline.json",
});
