import { binding, defineConfig } from "@boringparts/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@boringparts/dock/vitest";

const run = defineVitestRun("multiple non-passing statuses", {
  files: ["test/statuses.test.mts"],
  testRoot: "../test-workspace",
});
const skipped = vitestStatus("skipped", run, {
  file: "test/statuses.test.mts",
  name: "statuses > skipped",
});
const todo = vitestStatus("todo", run, {
  file: "test/statuses.test.mts",
  name: "statuses > todo",
});
const cancelled = vitestStatus("dynamically cancelled", run, {
  file: "test/statuses.test.mts",
  name: "statuses > dynamically skipped",
});
const missing = vitestStatus("not executed", run, {
  file: "test/statuses.test.mts",
  name: "statuses > nonexistent test",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [
    binding("skipped status", [skipped]),
    binding("todo status", [todo]),
    binding("dynamically skipped status", [cancelled]),
    binding("missing status", [missing]),
  ],
});
