import {
  defineNodeTestObservation,
  defineNodeTestRun,
  nodeTest,
  nodeTestObservation,
} from "@dock/reference-node-test";
import { binding, defineConfig } from "@dock/sdk";

export const amount = defineNodeTestObservation("amount", 0);
const run = defineNodeTestRun("循环注册观察", {
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
        "alpha 观察",
        run,
        { file: testFile, name: "alpha" },
        amount,
      ),
    ]),
    binding("beta", [
      nodeTestObservation(
        "beta 观察",
        run,
        { file: testFile, name: "beta" },
        amount,
      ),
    ]),
  ],
});
