import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  defineNodeTestObservation,
  nodeTest as secondaryNodeTest,
  beginExecution,
} from "@dock/reference-node-test";

import {
  currentText,
  numericObservation,
  objectObservation,
  readConfig,
  unassociatedText,
} from "../../../observations.config.mts";

const secondaryNumericObservation = defineNodeTestObservation(
  numericObservation.key,
  0,
);
const secondaryObjectObservation = defineNodeTestObservation(
  objectObservation.key,
  { amount: 0 },
);

test("读取当前值并记录观察", async () => {
  beginExecution();
  const read = await secondaryNodeTest.readReferenceInTest(
    readConfig,
    currentText,
  );
  const source = await readFile(
    new URL("../../../read-business.txt", import.meta.url),
    "utf8",
  );
  assert.equal(read.value, "温度 🧭：24");
  assert.ok(read.range !== undefined);
  assert.equal(read.range.start, source.indexOf(read.value));
  assert.equal(read.range.end, read.range.start + read.value.length);

  const unassociated = await secondaryNodeTest.readReferenceInTest(
    readConfig,
    unassociatedText,
  );
  assert.equal(unassociated.value, "独立当前内容");
  assert.ok(unassociated.range !== undefined);

  const numeric = secondaryNumericObservation.record(read.value.length);
  assert.equal(numeric, read.value.length);
  const business = { amount: 17 };
  const recorded = secondaryObjectObservation.record(business);
  assert.strictEqual(recorded, business);

  const invalidNumber = defineNodeTestObservation("invalid.number", 0);
  const invalidArray = defineNodeTestObservation("invalid.array", [0]);
  assert.throws(() => invalidNumber.record(Number.NaN), /非有限数/);
  const sparse: number[] = [];
  sparse.length = 1;
  assert.throws(() => invalidArray.record(sparse), /连续/);
});
