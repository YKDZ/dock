import "./keep-worker-alive.mjs";
import { file } from "@dock/reference-file";
import { binding, defineConfig } from "@dock/sdk";

import { directReference } from "./direct-declaration.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("direct-binding", [directReference])],
  baseline: "direct.baseline.json",
});
