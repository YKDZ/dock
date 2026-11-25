import { binding, defineConfig, file, type ReferenceValue } from "@ykdz/dock";
import {
  defineNodeTestObservation,
  defineNodeTestRun,
  nodeTest,
  nodeTestObservation,
  nodeTestStatus,
} from "@ykdz/dock/node-test";

const run = defineNodeTestRun("status-check", {
  files: ["test/happy.test.mts"],
  testRoot: "test-workspace",
});
const status = nodeTestStatus("status-ref", run, {
  file: "test/happy.test.mts",
  name: "primary business status meets expectation",
});
const expected: ReferenceValue<typeof status> = { status: "passed" };
void expected;

const amount = defineNodeTestObservation("business.amount", 0);
const details = defineNodeTestObservation("business.details", { amount: 0 });
const observedRun = defineNodeTestRun("typed-observation", {
  files: ["test/happy.test.mts"],
  observations: [amount, details],
});
const observedAmount = nodeTestObservation(
  "observed-amount",
  observedRun,
  {
    file: "test/happy.test.mts",
    name: "primary business status meets expectation",
  },
  amount,
);
const amountValue: ReferenceValue<typeof observedAmount> = 17;
const actualAmount: number = amount.record(amountValue);
const objectValue = details.record({ amount: actualAmount });
const actualObjectAmount: number = objectValue.amount;
void actualObjectAmount;

const sharedShape = defineNodeTestObservation("node.shared.shape", {
  count: 0,
});
const sharedRun = defineNodeTestRun("node-shared-observation-type", {
  files: ["test/happy.test.mts"],
  observations: [sharedShape],
});
const sharedReference = nodeTestObservation(
  "node-shared-shape-ref",
  sharedRun,
  {
    file: "test/happy.test.mts",
    name: "primary business status meets expectation",
  },
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

const currentText = file
  .from("read-business.txt")
  .match("Reading: (.*)", 1)
  .reference("typed-read");
const readConfig = defineConfig({ plugins: [file], bindings: [] });
async function checkInstalledReadType(): Promise<void> {
  const result = await nodeTest.readReferenceInTest(readConfig, currentText);
  const currentValue: string = result.value;
  void currentValue;
}
void checkInstalledReadType;

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("business-status", [status])],
});

export { sharedRun, sharedShape };
