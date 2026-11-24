import { defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  readReferenceInTest,
  vitest,
  vitestStatus,
} from "@ykdz/dock/vitest";

const run = defineVitestRun("unreadable test status", {
  files: ["test/stable.test.mts"],
});
const status = vitestStatus("status", run, {
  file: "test/stable.test.mts",
  name: "passes normally",
});
const config = defineConfig({ plugins: [vitest], bindings: [] });
// @ts-expect-error Vitest status reference has no read implementation and cannot be read via readReferenceInTest.
void readReferenceInTest(config, status);
