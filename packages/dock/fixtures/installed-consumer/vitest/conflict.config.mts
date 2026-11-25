import { binding, defineConfig } from "@boringparts/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@boringparts/dock/vitest";

const firstRun = defineVitestRun("conflicting identity", {
  files: ["test/conflict-first.test.mts"],
  testRoot: "../test-workspace",
});
const secondRun = defineVitestRun("conflicting identity", {
  files: ["test/conflict-second.test.mts"],
  testRoot: "../test-workspace",
});
const first = vitestStatus("first conflict", firstRun, {
  file: "test/conflict-first.test.mts",
  name: "unstarted first",
});
const second = vitestStatus("second conflict", secondRun, {
  file: "test/conflict-second.test.mts",
  name: "unstarted second",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [
    binding("conflict first", [first]),
    binding("conflict second", [second]),
  ],
});
