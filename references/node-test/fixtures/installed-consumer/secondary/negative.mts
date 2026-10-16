import { defineNodeTestObservation } from "@dock/reference-node-test";

const count = defineNodeTestObservation("secondary.count", 0);
// @ts-expect-error 第二物理安装也必须保留观察值的 number 类型。
count.record("nineteen");
