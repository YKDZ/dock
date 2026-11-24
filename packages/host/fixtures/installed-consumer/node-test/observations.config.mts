import { binding, defineConfig, file } from "@ykdz/dock";
import {
  defineNodeTestObservation,
  defineNodeTestRun,
  nodeTest,
  nodeTestObservation,
  nodeTestStatus,
} from "@ykdz/dock/node-test";

export const currentText = file
  .at(import.meta.url)
  .from("./read-business.txt")
  .match("Reading: (.*)", 1)
  .reference("current-business-text");

export const currentAmount = file
  .at(import.meta.url)
  .from("./read-business.txt")
  .match("Amount: (\\d+)", 1)
  .reference("current-business-amount");

export const unassociatedText = file
  .at(import.meta.url)
  .from("./read-unassociated.txt")
  .match("Unassociated: (.*)", 1)
  .reference("unassociated-business-text");

export const readConfig = defineConfig({ plugins: [file], bindings: [] });

export const numericObservation = defineNodeTestObservation(
  "business.amount",
  0,
);
export const objectObservation = defineNodeTestObservation("business.object", {
  amount: 0,
});

const run = defineNodeTestRun("observation-and-read-run", {
  files: ["test/observations.test.mts"],
  testRoot: "secondary/test-workspace",
  observations: [numericObservation, objectObservation],
});
const target = {
  file: "test/observations.test.mts",
  name: "read current value and record observations",
};
const status = nodeTestStatus("observation-read-test-status", run, target);
const numeric = nodeTestObservation(
  "current-amount",
  run,
  target,
  numericObservation,
);
const object = nodeTestObservation(
  "business-object",
  run,
  target,
  objectObservation,
);

export default defineConfig({
  baseline: "observations.baseline.json",
  plugins: [file, nodeTest],
  bindings: [binding("node-observation-and-read", [status, numeric, object])],
});
