import { file } from "@dock/reference-file";
import { binding, defineConfig } from "@dock/sdk";

import { isolationOneReference } from "./isolation-one-declaration.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("isolation-binding", [isolationOneReference])],
  baseline: "isolation-one.baseline.json",
});
