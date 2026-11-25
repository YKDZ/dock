import { binding, defineConfig, type ReferenceValue } from "@boringparts/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitestSuite,
} from "@boringparts/dock/vitest";

const declared = defineVitestObservation("declared", { count: 0 });
const run = defineVitestRun("group member error types", {
  files: ["test/groups.test.mts"],
  observations: [declared],
});
const other = defineVitestObservation("other", { label: "" });
const unregistered = vitestSuite(
  "unregistered",
  run,
  {
    file: "test/groups.test.mts",
    suitePath: ["preview config"],
  },
  // @ts-expect-error Suite can only select observations declared on this run.
  [other],
);
const suite = vitestSuite(
  "invalid-member-value",
  run,
  { file: "test/groups.test.mts", suitePath: ["preview config"] },
  [declared],
);
const incompatible = defineVitestObservation("declared", {
  count: 0,
  label: "",
});
vitestSuite(
  "incompatible-helper",
  run,
  { file: "test/groups.test.mts", suitePath: ["preview config"] },
  // @ts-expect-error Same-key observation helper must match the value contract declared on this run.
  [incompatible],
);
const invalidValue: ReferenceValue<typeof suite> = [
  // @ts-expect-error Member observation value must preserve the declared count shape.
  { key: "declared", value: { label: "wrong" } },
];
vitestSuite(
  "empty-path",
  run,
  // @ts-expect-error Native suite path cannot be empty.
  { file: "test/groups.test.mts", suitePath: [] },
  [declared],
);
void unregistered;
void invalidValue;

const valid = vitestSuite(
  "valid",
  run,
  { file: "test/groups.test.mts", suitePath: ["preview config"] },
  [declared],
);
// @ts-expect-error Suite reference must be handled by the Vitest plugin.
defineConfig({ plugins: [], bindings: [binding("missing plugin", [valid])] });
