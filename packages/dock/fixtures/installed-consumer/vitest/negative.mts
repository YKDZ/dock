import { binding, defineConfig, type ReferenceValue } from "@ykdz/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
  vitestStatus,
} from "@ykdz/dock/vitest";

// @ts-expect-error Test run requires at least one native test file.
defineVitestRun("empty run", { files: [] });

const run = defineVitestRun("valid run", {
  files: ["test/retry.test.mts"],
});
defineVitestRun("missing additional test title", {
  files: ["test/retry.test.mts"],
  // @ts-expect-error Additional same-run selection must provide a full test name.
  additionalTests: [{ file: "test/retry.test.mts" }],
});
// @ts-expect-error Test title must be a string.
vitestStatus("wrong title", run, { file: "test/retry.test.mts", name: 42 });

const status = vitestStatus("status", run, {
  file: "test/retry.test.mts",
  name: "retry > finally passes",
});
// @ts-expect-error Status reference only represents a passing terminal state.
const failed: ReferenceValue<typeof status> = { status: "failed" };
void failed;

const titleObservation = defineVitestObservation("title", "title");
// @ts-expect-error Observation value must match the type inferred from the declaration.
titleObservation.record(42);
const observedRun = defineVitestRun("observation type check", {
  files: ["test/stable.test.mts"],
  observations: [titleObservation],
});
vitestObservation(
  "unknown observation key",
  observedRun,
  { file: "test/stable.test.mts", name: "passes normally" },
  // @ts-expect-error Reference can only bind an observation declared on this run.
  defineVitestObservation("other", "other"),
);
const observedTitle = vitestObservation(
  "typed title",
  observedRun,
  { file: "test/stable.test.mts", name: "passes normally" },
  titleObservation,
);
// @ts-expect-error Observation value type comes from declaration and cannot be substituted.
const wrongObservation: ReferenceValue<typeof observedTitle> = 42;
void wrongObservation;

const declaredShape = defineVitestObservation("declared.shape", { count: 0 });
const shapeRun = defineVitestRun("observation value declaration", {
  files: ["test/stable.test.mts"],
  observations: [declaredShape],
});
const incompatibleShape = defineVitestObservation("declared.shape", {
  count: 0,
  label: "",
});
const shapeReference = vitestObservation(
  "observation value reference",
  shapeRun,
  { file: "test/stable.test.mts", name: "passes normally" },
  // @ts-expect-error Same-key helper must also match the full value type declared on the run.
  incompatibleShape,
);
const shapeValue: ReferenceValue<typeof shapeReference> = declaredShape.record({
  count: 1,
});
// @ts-expect-error Run declaration does not promise label; reference type cannot expose it.
const unpromisedLabel: string = shapeValue.label;
void unpromisedLabel;
const wrongShapeValue: ReferenceValue<typeof shapeReference> = {
  // @ts-expect-error count must be a number.
  count: "1",
};
void wrongShapeValue;
const undeclaredShape = defineVitestObservation("undeclared.shape", 0);
vitestObservation(
  "undeclared key",
  shapeRun,
  { file: "test/stable.test.mts", name: "passes normally" },
  // @ts-expect-error Helper key must belong to this run.
  undeclaredShape,
);

const richerShape = defineVitestObservation("reverse.shape", {
  count: 0,
  label: "",
});
const richerRun = defineVitestRun("reverse observation type check", {
  files: ["test/stable.test.mts"],
  observations: [richerShape],
});
const narrowerShape = defineVitestObservation("reverse.shape", { count: 0 });
vitestObservation(
  "reverse incompatible observation reference",
  richerRun,
  { file: "test/stable.test.mts", name: "passes normally" },
  // @ts-expect-error Run declaration guarantees label; a narrower helper cannot hide it.
  narrowerShape,
);

// @ts-expect-error Status reference must be handled by the matching Vitest plugin.
defineConfig({ plugins: [], bindings: [binding("missing plugin", [status])] });

vitestStatus(
  "invalid selection",
  run,
  { file: "test/retry.test.mts", name: "retry > finally passes" },
  // @ts-expect-error Vitest status declaration does not support selection.
  { selection: { kind: "unsupported" } },
);

defineConfig({
  plugins: [vitest],
  bindings: [binding("valid declaration", [status])],
});
