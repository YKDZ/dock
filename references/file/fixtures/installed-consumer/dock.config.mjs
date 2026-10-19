import { binding, defineConfig } from "@ykdz/dock";
import { file } from "@ykdz/dock-reference-file";

import { target } from "./declarations.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("guide-policy", [file.from(target).reference("guide")])],
});
