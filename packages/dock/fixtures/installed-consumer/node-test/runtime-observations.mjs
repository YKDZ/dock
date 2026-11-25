import assert from "node:assert/strict";

import { defineNodeTestObservation } from "@boringparts/dock/node-test";

const number = defineNodeTestObservation("runtime.number", 0);
const array = defineNodeTestObservation("runtime.array", [0]);
const object = defineNodeTestObservation("runtime.object", { valid: true });

assert.throws(() => number.record(Number.NaN), /non-finite number/);
assert.throws(
  () => number.record(Number.POSITIVE_INFINITY),
  /non-finite number/,
);
const sparse = [];
sparse.length = 1;
assert.throws(() => array.record(sparse), /dense/);
assert.throws(() => object.record(new Date()), /plain JSON object/);
