import { binding, defineConfig } from "@ykdz/dock";
import { file } from "@ykdz/dock-reference-file";

import { transitiveReference } from "./transitive-middle.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("transitive-binding", [transitiveReference])],
  baseline: "transitive-binding.baseline.json",
});
