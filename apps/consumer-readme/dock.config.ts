import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { binding, defineConfig } from "@ykdz/dock";
import { markdown } from "@ykdz/dock-reference-markdown";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@ykdz/dock-reference-node-test";

const root = dirname(fileURLToPath(import.meta.resolve("dock/README.md")));
const consumer = dirname(fileURLToPath(import.meta.url));

export const readme = markdown.from("README.md");
export const exampleTest = {
  file: relative(root, join(consumer, "scripts/readme.test.ts")),
  name: "README 示例完成检查与基线更新",
};

const run = defineNodeTestRun("README 示例", {
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
