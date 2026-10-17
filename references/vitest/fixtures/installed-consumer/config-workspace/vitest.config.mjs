import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default async function config(environment) {
  if (environment.command !== "serve" || environment.mode !== "test") {
    throw new Error("用户配置没有收到约定的命令和模式。");
  }
  appendFileSync(
    new URL("../maintenance-root/config-evaluated.log", import.meta.url),
    "serve/test\n",
  );
  return {
    test: {
      testNamePattern: /配置通过/iu,
      setupFiles: fileURLToPath(new URL("./setup.mts", import.meta.url)),
      reporters: [fileURLToPath(new URL("./reporter.mjs", import.meta.url))],
    },
  };
}
