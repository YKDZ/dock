import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  beginExecution,
  defineNodeTestObservation,
  nodeTest as secondaryNodeTest,
} from "@ykdz/dock/node-test";

import {
  currentAmount,
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

test("read current value and record observations", async () => {
  beginExecution();
  const read = await secondaryNodeTest.readReferenceInTest(
    readConfig,
    currentText,
  );
  const amountRead = await secondaryNodeTest.readReferenceInTest(
    readConfig,
    currentAmount,
  );
  const source = await readFile(
    new URL("../../../read-business.txt", import.meta.url),
    "utf8",
  );
  assert.equal(read.value, "温度 🧭：24");
  assert.ok(read.range !== undefined);
  assert.equal(read.range.start, source.indexOf(read.value));
  assert.equal(read.range.end, read.range.start + read.value.length);
  assert.match(amountRead.value, /^\d+$/);
  assert.ok(amountRead.range !== undefined);
  assert.equal(amountRead.range.start, source.indexOf(amountRead.value));
  assert.equal(
    amountRead.range.end,
    amountRead.range.start + amountRead.value.length,
  );

  const unassociated = await secondaryNodeTest.readReferenceInTest(
    readConfig,
    unassociatedText,
  );
  assert.equal(unassociated.value, "unassociated current content");
  assert.ok(unassociated.range !== undefined);

  const amount = Number(amountRead.value);
  const numeric = secondaryNumericObservation.record(amount);
  assert.equal(numeric, amount);
  const business = { amount: 17 };
  const recorded = secondaryObjectObservation.record(business);
  assert.strictEqual(recorded, business);

  const invalidNumber = defineNodeTestObservation("invalid.number", 0);
  const invalidArray = defineNodeTestObservation("invalid.array", [0]);
  assert.throws(() => invalidNumber.record(Number.NaN), /non-finite number/);
  const sparse: number[] = [];
  sparse.length = 1;
  assert.throws(() => invalidArray.record(sparse), /dense/);
});
