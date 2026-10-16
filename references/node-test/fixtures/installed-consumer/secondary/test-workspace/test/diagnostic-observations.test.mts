import { test } from "node:test";

import {
  defineNodeTestObservation,
  beginExecution,
} from "@dock/reference-node-test";

const repeated = defineNodeTestObservation("duplicate.value", 0);

test("声明但未记录", () => {
  beginExecution();
});

test("同值重复记录", () => {
  beginExecution();
  repeated.record(17);
  repeated.record(17);
});
