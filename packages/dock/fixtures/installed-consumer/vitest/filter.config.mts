import { binding, defineConfig } from "@boringparts/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@boringparts/dock/vitest";

const run = defineVitestRun("declared name filter", {
  files: ["test/filter.test.mts"],
  testRoot: "../filter-workspace",
});
const included = vitestStatus("filtered in", run, {
  file: "test/filter.test.mts",
  name: "filter > included status",
});
const excluded = vitestStatus("filtered out", run, {
  file: "test/filter.test.mts",
  name: "filter > excluded status",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [
    binding("retained status", [included]),
    binding("filtered status", [excluded]),
  ],
});
