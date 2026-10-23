import { readFile } from "node:fs/promises";

import { binding, check, defineConfig, readReference } from "@ykdz/dock";
import { markdown } from "@ykdz/dock-reference-markdown";

import config, { sample, whole } from "./inline-script-config.mjs";

const source = await readFile("inline-script-guide.md", "utf8");
let selected;
try {
  selected = { kind: "value", ...(await readReference(config, sample)) };
} catch (error) {
  selected = { kind: "error", code: error.code };
}
const report = await check(
  defineConfig({
    root: process.cwd(),
    plugins: [markdown],
    bindings: [binding("inline-script-policy", [sample])],
  }),
);
const full = await readReference(config, whole);
process.stdout.write(
  `${JSON.stringify({ source, selected, checked: report.bindings[0], whole: full.value })}\n`,
);
