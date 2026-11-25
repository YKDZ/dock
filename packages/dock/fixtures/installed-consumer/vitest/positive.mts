import { binding, defineConfig, type ReferenceValue } from "@boringparts/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
  vitestStatus,
} from "@boringparts/dock/vitest";
import type { VitestTestSelection } from "@boringparts/dock/vitest";

const run = defineVitestRun("installed status check", {
  files: ["test/retry.test.mts"],
  testRoot: "../test-workspace",
});
const status = vitestStatus("final pass", run, {
  file: "test/retry.test.mts",
  name: "retry > finally passes",
});
const expected: ReferenceValue<typeof status> = { status: "passed" };
void expected;

const additionalTest: VitestTestSelection = {
  file: "test/stable.test.mts",
  name: "passes normally",
};
const runWithAdditionalTest = defineVitestRun("additional same-run selection", {
  files: ["test/retry.test.mts", "test/stable.test.mts"],
  additionalTests: [additionalTest],
});
void runWithAdditionalTest;

const currentTitle = defineVitestObservation("current-title", "title");
const observationRun = defineVitestRun("typed observation", {
  files: ["test/stable.test.mts"],
  observations: [currentTitle],
});
const observedTitle = vitestObservation(
  "observed title",
  observationRun,
  { file: "test/stable.test.mts", name: "passes normally" },
  currentTitle,
);
const expectedObservation: ReferenceValue<typeof observedTitle> =
  "current title";
const roundTripObservation: string = currentTitle.record(expectedObservation);
void roundTripObservation;

const sharedShape = defineVitestObservation("shared.shape", { count: 0 });
const sharedRun = defineVitestRun("shared observation type", {
  files: ["test/stable.test.mts"],
  observations: [sharedShape],
});
const sharedReference = vitestObservation(
  "shared shape reference",
  sharedRun,
  { file: "test/stable.test.mts", name: "passes normally" },
  sharedShape,
);
const sharedValue: ReferenceValue<typeof sharedReference> = sharedShape.record({
  count: 1,
});
const sharedCount: number = sharedValue.count;
// @ts-expect-error Run declaration only guarantees count.
const sharedLabel: string = sharedValue.label;
void sharedCount;
void sharedLabel;

export { sharedRun, sharedShape };

defineConfig({
  plugins: [vitest],
  bindings: [binding("run status", [status])],
});
