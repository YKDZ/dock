import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@ykdz/dock/vitest";

const run = defineVitestRun("single test with same flattened title", {
  files: ["test/group-collision.test.mts"],
  testRoot: "../test-workspace",
});
const ambiguous = vitestStatus("ambiguous-flat-title", run, {
  file: "test/group-collision.test.mts",
  name: "outer > nested > child > same",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "group-collision-single.baseline.json",
  plugins: [vitest],
  bindings: [binding("title matching multiple paths", [ambiguous])],
});
