import "./keep-worker-alive.mjs";
import { binding, defineConfig, file } from "@ykdz/dock";

import { directReference } from "./direct-declaration.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("direct-binding", [directReference])],
  baseline: "direct.baseline.json",
});
