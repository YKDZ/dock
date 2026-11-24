import { defineNodeTestObservation } from "@ykdz/dock/node-test";

const count = defineNodeTestObservation("secondary.count", 0);
// @ts-expect-error Secondary physical install must preserve the number type for observations.
count.record("nineteen");
