import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@ykdz/dock/vitest";

const run = defineVitestRun("additional same-run selection", {
  files: [
    "test/additional-required.test.mts",
    "test/additional-extra.test.mts",
  ],
  testRoot: "../test-workspace",
  additionalTests: [
    {
      file: "test/additional-extra.test.mts",
      name: "additional test with different title",
    },
  ],
});
const required = vitestStatus("explicitly required status", run, {
  file: "test/additional-required.test.mts",
  name: "explicitly required test",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "additional-tests.baseline.json",
  plugins: [vitest],
  bindings: [binding("explicitly required status", [required])],
});
