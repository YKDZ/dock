import { file } from "@dock/reference-file";
import { binding, defineConfig } from "@dock/sdk";

import { isolationTwoReference } from "./isolation-two-declaration.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("isolation-binding", [isolationTwoReference])],
  baseline: "isolation-two.baseline.json",
});
