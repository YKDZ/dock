import { binding, defineConfig, file } from "@ykdz/dock";

import { isolationOneReference } from "./isolation-one-declaration.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("isolation-binding", [isolationOneReference])],
  baseline: "isolation-one.baseline.json",
});
