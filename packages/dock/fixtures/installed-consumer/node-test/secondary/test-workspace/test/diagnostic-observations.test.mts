import { test } from "node:test";

import {
  beginExecution,
  defineNodeTestObservation,
} from "@ykdz/dock/node-test";

const repeated = defineNodeTestObservation("duplicate.value", 0);

test("declared but not recorded", () => {
  beginExecution();
});

test("duplicate identical observation recorded", () => {
  beginExecution();
  repeated.record(17);
  repeated.record(17);
});
