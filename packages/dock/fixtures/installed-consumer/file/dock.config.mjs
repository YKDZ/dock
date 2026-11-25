import { binding, defineConfig, file } from "@ykdz/dock";

import { target } from "./declarations.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("guide-policy", [file.from(target).reference("guide")])],
});
