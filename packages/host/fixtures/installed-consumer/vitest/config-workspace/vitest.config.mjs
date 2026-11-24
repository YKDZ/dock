import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default async function config(environment) {
  if (environment.command !== "serve" || environment.mode !== "test") {
    throw new Error(
      "User config did not receive the expected command and mode.",
    );
  }
  appendFileSync(
    new URL("../maintenance-root/config-evaluated.log", import.meta.url),
    "serve/test\n",
  );
  return {
    test: {
      testNamePattern: /config passed/iu,
      setupFiles: fileURLToPath(new URL("./setup.mts", import.meta.url)),
      reporters: [fileURLToPath(new URL("./reporter.mjs", import.meta.url))],
    },
  };
}
