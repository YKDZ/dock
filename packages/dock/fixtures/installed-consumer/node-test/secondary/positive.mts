import { binding, defineConfig, type ReferenceValue } from "@ykdz/dock";
import {
  defineNodeTestObservation,
  defineNodeTestRun,
  nodeTest,
  nodeTestObservation,
} from "@ykdz/dock/node-test";

import { sharedRun, sharedShape } from "../positive.mjs";

const count = defineNodeTestObservation("secondary.count", 0);
const object = defineNodeTestObservation("secondary.object", { count: 0 });
const run = defineNodeTestRun("secondary-install-types", {
  files: ["test/sample.test.mts"],
  observations: [count, object],
});
const reference = nodeTestObservation(
  "secondary-count",
  run,
  { file: "test/sample.test.mts", name: "sample" },
  count,
);
const value: ReferenceValue<typeof reference> = 19;
const actual: number = count.record(value);
const actualObjectCount: number = object.record({ count: actual }).count;
const secondShape = defineNodeTestObservation("node.shared.shape", {
  count: 0,
});
const crossReference = nodeTestObservation(
  "secondary-physical-install-ref",
  sharedRun,
  {
    file: "test/happy.test.mts",
    name: "primary business status meets expectation",
  },
  secondShape,
);
const crossValue: ReferenceValue<typeof crossReference> = sharedShape.record({
  count: 1,
});
const crossCount: number = crossValue.count;
// @ts-expect-error Secondary install still follows the run's structured value type.
const crossLabel: string = crossValue.label;
const config = defineConfig({
  plugins: [nodeTest],
  bindings: [binding("secondary-physical-install", [reference])],
});
void actualObjectCount;
void crossCount;
void crossLabel;
const widerSecondShape = defineNodeTestObservation("node.shared.shape", {
  count: 0,
  label: "",
});
nodeTestObservation(
  "secondary-physical-install-wrong-shape",
  sharedRun,
  {
    file: "test/happy.test.mts",
    name: "primary business status meets expectation",
  },
  // @ts-expect-error Secondary physical install also rejects a helper that widens the declared value shape.
  widerSecondShape,
);
void config;
