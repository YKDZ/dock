import { binding, defineConfig } from "@ykdz/dock";
import { file } from "@ykdz/dock-reference-file";

import { reexportReference } from "./reexport.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("reexport-binding", [reexportReference])],
  baseline: "reexport-binding.baseline.json",
});
