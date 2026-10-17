import { defineVitestRun, vitest, vitestStatus } from "@dock/reference-vitest";
import { binding, defineConfig } from "@dock/sdk";

const run = defineVitestRun("用户配置运行", {
  testRoot: "../config-workspace",
  files: ["selected.test.mts"],
});

export default defineConfig({
  root: "maintenance-root",
  plugins: [vitest],
  bindings: [
    binding("用户配置状态", [
      vitestStatus("配置通过", run, {
        file: "selected.test.mts",
        name: "配置通过",
      }),
    ]),
    binding("范围外状态", [
      vitestStatus("范围外测试", run, {
        file: "selected.test.mts",
        name: "范围外测试",
      }),
    ]),
  ],
});
