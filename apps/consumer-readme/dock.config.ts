import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { binding, defineConfig } from "@boringparts/dock";
import { markdown } from "@boringparts/dock/markdown";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@boringparts/dock/node-test";

const root = dirname(fileURLToPath(import.meta.resolve("dock/README.md")));
const consumer = dirname(fileURLToPath(import.meta.url));

export const readme = markdown.from("README.md");
export const exampleTest = {
  file: relative(root, join(consumer, "scripts/readme.test.ts")),
  name: "README example completes check and baseline update",
};

const run = defineNodeTestRun("README example", {
  files: [exampleTest.file],
});
const example = nodeTestStatus("readme-example", run, exampleTest);

export default defineConfig({
  root,
  baseline: relative(root, join(consumer, "dock.baseline.json")),
  plugins: [markdown, nodeTest],
  bindings: [
    binding("readme-workflow", [
      readme.section("核心思想").reference("readme-concepts"),
      readme.section("如何使用").reference("readme-usage"),
      example,
    ]),
    binding("readme-extension", [
      readme.section("扩展").reference("readme-extension-guide"),
      example,
    ]),
  ],
});
