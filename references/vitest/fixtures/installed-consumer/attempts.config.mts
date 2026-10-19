import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestObservation,
  vitest,
  vitestObservation,
  defineVitestRun,
} from "@ykdz/dock-reference-vitest";

const value = defineVitestObservation("multi-file-value", "");
const run = defineVitestRun("多文件观察", {
  files: ["test/attempt-first.test.mts", "test/attempt-second.test.mts"],
  testRoot: "../test-workspace",
  configFile: "../test-workspace/vitest.shared.config.mjs",
  observations: [value],
});
const first = vitestObservation(
  "第一文件观察",
  run,
  { file: "test/attempt-first.test.mts", name: "第一文件观察" },
  value,
);
const second = vitestObservation(
  "第二文件观察",
  run,
  { file: "test/attempt-second.test.mts", name: "第二文件观察" },
  value,
);

export default defineConfig({
  root: "maintenance-root",
  plugins: [vitest],
  bindings: [binding("多文件观察记录", [first, second])],
});
