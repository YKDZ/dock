import "./keep-worker-alive.mjs";
import { binding, defineConfig } from "@ykdz/dock";
import { file } from "@ykdz/dock-reference-file";

import { directReference } from "./direct-declaration.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("direct-binding", [directReference])],
  baseline: "direct.baseline.json",
});
