import { binding, defineConfig, type ReferenceValue } from "@ykdz/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
  vitestStatus,
  vitestSuite,
} from "@ykdz/dock-reference-vitest";

const settings = defineVitestObservation("preview-settings", {
  mode: "auto",
  theme: "light",
});
const steps = defineVitestObservation("render-steps", ["resolve", "render"]);
const run = defineVitestRun("组成员类型", {
  files: ["test/groups.test.mts"],
  observations: [settings, steps],
});
const suite = vitestSuite(
  "preview-group",
  run,
  { file: "test/groups.test.mts", suitePath: ["preview config"] },
  [settings, steps],
);
const single = vitestObservation(
  "preview-settings-single",
  run,
  {
    file: "test/groups.test.mts",
    name: "preview config > keeps query defaults",
  },
  settings,
);
const status = vitestStatus("preview-status", run, {
  file: "test/groups.test.mts",
  name: "preview config > keeps query defaults",
});
const member: ReferenceValue<typeof suite> = [
  { key: "preview-settings", value: { mode: "auto", theme: "light" } },
  { key: "render-steps", value: ["resolve", "render"] },
];
void member;

export default defineConfig({
  plugins: [vitest],
  bindings: [binding("组和单测共享运行", [suite, single, status])],
});
