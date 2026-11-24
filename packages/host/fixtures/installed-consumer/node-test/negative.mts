import { binding, defineConfig, type ReferenceValue } from "@ykdz/dock";
import {
  defineNodeTestObservation,
  defineNodeTestRun,
  nodeTest,
  nodeTestObservation,
  nodeTestStatus,
} from "@ykdz/dock/node-test";

// @ts-expect-error At least one native test file is required.
defineNodeTestRun("empty-run", { files: [] });

const run = defineNodeTestRun("valid-run", {
  files: ["test/happy.test.mts"],
});
nodeTestStatus("invalid-identity", run, {
  file: "test/happy.test.mts",
  // @ts-expect-error Test name must be a string.
  name: 42,
});

const status = nodeTestStatus("status", run, {
  file: "test/happy.test.mts",
  name: "primary business status meets expectation",
});

const amount = defineNodeTestObservation("business.amount", 0);
// @ts-expect-error sample=0 infers number, so string cannot be recorded.
amount.record("17");
// @ts-expect-error Status reference only represents a passed terminal state.
const failed: ReferenceValue<typeof status> = { status: "failed" };
void failed;

const declaredShape = defineNodeTestObservation("declared.shape", { count: 0 });
const shapeRun = defineNodeTestRun("observation-declaration", {
  files: ["test/happy.test.mts"],
  observations: [declaredShape],
});
const incompatibleShape = defineNodeTestObservation("declared.shape", {
  count: 0,
  label: "",
});
const shapeReference = nodeTestObservation(
  "observation-ref",
  shapeRun,
  {
    file: "test/happy.test.mts",
    name: "primary business status meets expectation",
  },
  // @ts-expect-error Helper with the same key must match the run's full declared value type.
  incompatibleShape,
);
const shapeValue: ReferenceValue<typeof shapeReference> = declaredShape.record({
  count: 1,
});
// @ts-expect-error Run declaration does not guarantee label, so reference type cannot expose it.
const unpromisedLabel: string = shapeValue.label;
void unpromisedLabel;
const wrongShapeValue: ReferenceValue<typeof shapeReference> = {
  // @ts-expect-error count must be a number.
  count: "1",
};
void wrongShapeValue;
const undeclaredShape = defineNodeTestObservation("undeclared.shape", 0);
nodeTestObservation(
  "undeclared-key",
  shapeRun,
  {
    file: "test/happy.test.mts",
    name: "primary business status meets expectation",
  },
  // @ts-expect-error Helper key must belong to the run.
  undeclaredShape,
);

const richerShape = defineNodeTestObservation("reverse.shape", {
  count: 0,
  label: "",
});
const richerRun = defineNodeTestRun("reverse-observation-type-check", {
  files: ["test/happy.test.mts"],
  observations: [richerShape],
});
const narrowerShape = defineNodeTestObservation("reverse.shape", {
  count: 0,
});
nodeTestObservation(
  "reverse-incompatible-observation-ref",
  richerRun,
  {
    file: "test/happy.test.mts",
    name: "primary business status meets expectation",
  },
  // @ts-expect-error Run declaration guarantees label, so a narrower helper cannot hide it.
  narrowerShape,
);

// @ts-expect-error Status reference requires the matching Node test plugin.
defineConfig({ plugins: [], bindings: [binding("missing-plugin", [status])] });

defineConfig({
  plugins: [nodeTest],
  bindings: [binding("valid-declaration", [status])],
});
