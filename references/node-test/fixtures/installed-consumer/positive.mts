import { binding, defineConfig, type ReferenceValue } from "@ykdz/dock";
import { file } from "@ykdz/dock-reference-file";
import {
  defineNodeTestObservation,
  defineNodeTestRun,
  nodeTest,
  nodeTestObservation,
  nodeTestStatus,
} from "@ykdz/dock-reference-node-test";

const run = defineNodeTestRun("状态检查", {
  files: ["test/happy.test.mts"],
  testRoot: "test-workspace",
});
const status = nodeTestStatus("状态引用", run, {
  file: "test/happy.test.mts",
  name: "主要业务状态符合约定",
});
const expected: ReferenceValue<typeof status> = { status: "passed" };
void expected;

const amount = defineNodeTestObservation("business.amount", 0);
const details = defineNodeTestObservation("business.details", { amount: 0 });
const observedRun = defineNodeTestRun("类型化观察", {
  files: ["test/happy.test.mts"],
  observations: [amount, details],
});
const observedAmount = nodeTestObservation(
  "observed-amount",
  observedRun,
  { file: "test/happy.test.mts", name: "主要业务状态符合约定" },
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
const sharedRun = defineNodeTestRun("Node 共享观察类型", {
  files: ["test/happy.test.mts"],
  observations: [sharedShape],
});
const sharedReference = nodeTestObservation(
  "Node 共享结构引用",
  sharedRun,
  { file: "test/happy.test.mts", name: "主要业务状态符合约定" },
  sharedShape,
);
const sharedValue: ReferenceValue<typeof sharedReference> = sharedShape.record({
  count: 1,
});
const sharedCount: number = sharedValue.count;
// @ts-expect-error 运行声明只保证 count。
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
  bindings: [binding("业务状态", [status])],
});

export { sharedRun, sharedShape };
