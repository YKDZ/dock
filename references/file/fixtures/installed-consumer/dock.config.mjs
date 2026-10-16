import { file } from "@dock/reference-file";
import { binding, defineConfig } from "@dock/sdk";

import { target } from "./declarations.mjs";

export default defineConfig({
  plugins: [file],
  bindings: [binding("guide-policy", [file.from(target).reference("guide")])],
});
