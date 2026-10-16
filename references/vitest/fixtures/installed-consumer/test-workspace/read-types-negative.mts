import {
  defineVitestRun,
  readReferenceInTest,
  vitest,
  vitestStatus,
} from "@dock/reference-vitest";
import { defineConfig } from "@dock/sdk";

const run = defineVitestRun("不可读取的测试状态", {
  files: ["test/stable.test.mts"],
});
const status = vitestStatus("状态", run, {
  file: "test/stable.test.mts",
  name: "普通通过",
});
const config = defineConfig({ plugins: [vitest], bindings: [] });
// @ts-expect-error Vitest 状态引用没有 read 实现，不能作为 SDK 读取目标。
void readReferenceInTest(config, status);
