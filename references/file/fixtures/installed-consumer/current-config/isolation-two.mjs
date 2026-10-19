import { binding, defineConfig } from "@ykdz/dock";
import { file } from "@ykdz/dock-reference-file";

import { isolationTwoReference } from "./isolation-two-declaration.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("isolation-binding", [isolationTwoReference])],
  baseline: "isolation-two.baseline.json",
});
