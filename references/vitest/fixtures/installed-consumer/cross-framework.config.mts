import { binding, defineConfig } from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@ykdz/dock-reference-node-test";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@ykdz/dock-reference-vitest";

const identity = "同一运行身份";
const files = ["test/shared.test.mts"] as const;
const testRoot = "../cross-framework-workspace";
const nodeRun = defineNodeTestRun(identity, { files, testRoot });
const vitestRun = defineVitestRun(identity, { files, testRoot });
const nodeReference = nodeTestStatus("Node 状态", nodeRun, {
  file: files[0],
  name: "跨框架测试通过",
});
const vitestReference = vitestStatus("Vitest 状态", vitestRun, {
  file: files[0],
  name: "跨框架测试通过",
});

export default defineConfig({
  root: "maintenance-root",
  plugins: [nodeTest, vitest],
  bindings: [
    binding("Node 运行", [nodeReference]),
    binding("Vitest 运行", [vitestReference]),
  ],
});
