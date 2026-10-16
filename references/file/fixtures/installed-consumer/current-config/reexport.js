import { file } from "@dock/reference-file";
import { binding, defineConfig } from "@dock/sdk";

import { reexportReference } from "./reexport.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("reexport-binding", [reexportReference])],
  baseline: "reexport-binding.baseline.json",
});
