import { binding, defineConfig } from "@ykdz/dock";
import { defineVitestRun, vitest, vitestStatus } from "@ykdz/dock/vitest";

const run = defineVitestRun("user config run", {
  testRoot: "../config-workspace",
  files: ["selected.test.mts"],
});

export default defineConfig({
  root: "maintenance-root",
  plugins: [vitest],
  bindings: [
    binding("user config status", [
      vitestStatus("config passed", run, {
        file: "selected.test.mts",
        name: "config passed",
      }),
    ]),
    binding("out of scope status", [
      vitestStatus("out of scope test", run, {
        file: "selected.test.mts",
        name: "out of scope test",
      }),
    ]),
  ],
});
