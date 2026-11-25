import { binding, defineConfig, file } from "@boringparts/dock";

import { isolationTwoReference } from "./isolation-two-declaration.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("isolation-binding", [isolationTwoReference])],
  baseline: "isolation-two.baseline.json",
});
