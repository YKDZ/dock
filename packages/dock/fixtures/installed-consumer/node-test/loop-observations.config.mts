import { binding, defineConfig } from "@boringparts/dock";
import {
  defineNodeTestObservation,
  defineNodeTestRun,
  nodeTest,
  nodeTestObservation,
} from "@boringparts/dock/node-test";

export const amount = defineNodeTestObservation("amount", 0);
const run = defineNodeTestRun("loop-registered-observations", {
  files: ["test/loop-observations.test.mts"],
  testRoot: "test-workspace",
  observations: [amount],
});
const testFile = "test/loop-observations.test.mts";

export default defineConfig({
  baseline: "loop-observations.baseline.json",
  plugins: [nodeTest],
  bindings: [
    binding("alpha", [
      nodeTestObservation(
        "alpha-observation",
        run,
        { file: testFile, name: "alpha" },
        amount,
      ),
    ]),
    binding("beta", [
      nodeTestObservation(
        "beta-observation",
        run,
        { file: testFile, name: "beta" },
        amount,
      ),
    ]),
  ],
});
