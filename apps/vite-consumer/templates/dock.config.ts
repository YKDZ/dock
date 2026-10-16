import { markdown } from "@dock/reference-markdown";
import { defineVitestRun, vitest, vitestStatus } from "@dock/reference-vitest";
import { binding, defineConfig } from "@dock/sdk";

const testFile = "packages/vite/src/node/__tests__/static-deploy.spec.ts";
const run = defineVitestRun("Vite 静态部署流程", {
  files: [testFile],
  testRoot: ".",
  configFile: "vitest.config.ts",
});
const workflowTest = vitestStatus("static-deploy-workflow", run, {
  file: testFile,
  name: "本地静态部署 > 新鲜构建的 HTML 和资源可经预览服务读取",
});

const guide = markdown.from("docs/guide/static-deploy.md");
const building = guide.section("Building the App");
const preview = guide.section("Testing the App Locally");

export default defineConfig({
  baseline: "dock.baseline.json",
  plugins: [markdown, vitest],
  bindings: [
    binding("static-local-workflow", [
      guide
        .node({
          type: "paragraph",
          contains: "Vite is installed as a local dev dependency",
        })
        .reference("static-local-prerequisite"),
      guide
        .node({ type: "code", contains: '"build": "vite build"' })
        .reference("static-local-scripts"),
      building
        .node({ type: "code", contains: "$ npm run build" })
        .reference("static-build-command"),
      guide
        .node({
          type: "paragraph",
          contains: "By default, the build output will be placed",
        })
        .reference("static-build-output"),
      preview
        .node({ type: "paragraph", contains: "Once you've built the app" })
        .reference("static-preview-order"),
      preview
        .node({ type: "code", contains: "$ npm run preview" })
        .reference("static-preview-command"),
      workflowTest,
    ]),
  ],
});
