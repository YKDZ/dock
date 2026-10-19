import { binding, defineConfig } from "@ykdz/dock";
import { file } from "@ykdz/dock-reference-file";

import { isolationOneReference } from "./isolation-one-declaration.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("isolation-binding", [isolationOneReference])],
  baseline: "isolation-one.baseline.json",
});
