import {
  defineVitestObservation,
  defineVitestRun,
  vitestObservation,
  vitestStatus,
} from "@dock/reference-vitest";

import { keepResult } from "./keep.projections.ts";

const sample = { a: 1, b: 2 };
const observation = defineVitestObservation(
  "result",
  keepResult(sample, sample),
);
const run = defineVitestRun("keep-tests", {
  files: ["src/__tests__/utils.test.tsx"],
  testRoot: ".",
  configFile: "vite.config.ts",
  observations: [observation],
});
const target = {
  file: "src/__tests__/utils.test.tsx",
  name: "core/utils > keepPreviousData > should return the parameter as is",
};

export const keep = {
  observation,
  status: vitestStatus("keep-case", run, target),
  result: vitestObservation(
    "@observation:keep-case:result",
    run,
    target,
    observation,
  ),
};
