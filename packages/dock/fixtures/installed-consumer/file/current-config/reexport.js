import { binding, defineConfig, file } from "@ykdz/dock";

import { reexportReference } from "./reexport.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("reexport-binding", [reexportReference])],
  baseline: "reexport-binding.baseline.json",
});
