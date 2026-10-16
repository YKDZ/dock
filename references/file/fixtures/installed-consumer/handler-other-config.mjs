import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  binding,
  createReference,
  defineConfig,
  definePlugin,
} from "@dock/sdk";

const reader = definePlugin({
  id: "@fixture/same-target-reader",
  validate(reference) {
    if (typeof reference.target !== "string") {
      throw new TypeError("目标必须是路径文本。");
    }
  },
  async collect(reference, context) {
    return {
      kind: "value",
      value: await readFile(resolve(context.root, reference.target), "utf8"),
    };
  },
});

export default defineConfig({
  plugins: [reader],
  bindings: [
    binding("handler-policy", [
      createReference(reader.id, "handler-reference", "copy.md"),
    ]),
  ],
  baseline: "handler-identity.baseline.json",
});
