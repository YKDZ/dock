import { readFile } from "node:fs/promises";

import { readReference } from "@ykdz/dock";
import { markdown } from "@ykdz/dock-reference-markdown";

import config, { sample, whole } from "./inline-script-config.mjs";

const source = await readFile("inline-script-guide.md", "utf8");
let selected;
try {
  selected = { kind: "value", ...(await readReference(config, sample)) };
} catch (error) {
  selected = { kind: "error", code: error.code };
}
const collected = await markdown.collect(sample, { root: process.cwd() });
const full = await readReference(config, whole);
process.stdout.write(
  `${JSON.stringify({ source, selected, collected, whole: full.value })}\n`,
);
