import assert from "node:assert/strict";

import { defineNodeTestObservation } from "@dock/reference-node-test";

const number = defineNodeTestObservation("runtime.number", 0);
const array = defineNodeTestObservation("runtime.array", [0]);
const object = defineNodeTestObservation("runtime.object", { valid: true });

assert.throws(() => number.record(Number.NaN), /非有限数/);
assert.throws(() => number.record(Number.POSITIVE_INFINITY), /非有限数/);
const sparse = [];
sparse.length = 1;
assert.throws(() => array.record(sparse), /连续/);
assert.throws(() => object.record(new Date()), /普通 JSON 对象/);
