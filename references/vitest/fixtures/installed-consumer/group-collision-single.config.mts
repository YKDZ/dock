import { defineVitestRun, vitest, vitestStatus } from "@dock/reference-vitest";
import { binding, defineConfig } from "@dock/sdk";

const run = defineVitestRun("展开标题相同的单测", {
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
  bindings: [binding("标题对应多个路径", [ambiguous])],
});
