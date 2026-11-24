import { binding, defineConfig } from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@ykdz/dock/node-test";
import { defineVitestRun, vitest, vitestStatus } from "@ykdz/dock/vitest";

const identity = "shared run identity";
const files = ["test/shared.test.mts"] as const;
const testRoot = "../cross-framework-workspace";
const nodeRun = defineNodeTestRun(identity, { files, testRoot });
const vitestRun = defineVitestRun(identity, { files, testRoot });
const nodeReference = nodeTestStatus("Node status", nodeRun, {
  file: files[0],
  name: "cross-framework test passes",
});
const vitestReference = vitestStatus("Vitest status", vitestRun, {
  file: files[0],
  name: "cross-framework test passes",
});

export default defineConfig({
  root: "maintenance-root",
  plugins: [nodeTest, vitest],
  bindings: [
    binding("Node run", [nodeReference]),
    binding("Vitest run", [vitestReference]),
  ],
});
