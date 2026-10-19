import { binding, defineConfig } from "@ykdz/dock";
import { file } from "@ykdz/dock-reference-file";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestObservation,
} from "@ykdz/dock-reference-node-test";

import { numericObservation } from "./observations.config.mts";

const run = defineNodeTestRun("失败读取运行", {
  files: ["test/failed-read.test.mts"],
  testRoot: "secondary/test-workspace",
  observations: [numericObservation],
});
const value = nodeTestObservation(
  "失败前业务值",
  run,
  {
    file: "test/failed-read.test.mts",
    name: "读取后业务断言失败",
  },
  numericObservation,
);

export default defineConfig({
  plugins: [file, nodeTest],
  baseline: "failed-read.baseline.json",
  bindings: [binding("读取后的业务断言", [value])],
});
