import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { collectArtifacts, packageNames } from "./release-artifacts.ts";

const directory = resolve(".artifacts/candidate");
const manifest = await collectArtifacts(directory);
const [core, host, file, markdown, nodeTest, typescript, vitest] = packageNames;
const consumers: [string, readonly string[]][] = [
  [host, [core, host]],
  [file, [core, host, file]],
  [markdown, [core, host, file, markdown]],
  [nodeTest, [core, host, nodeTest, file]],
  [typescript, [core, host, file, typescript]],
  [vitest, [core, host, vitest, nodeTest, file]],
  ["@dock/consumer-readme", [core, host, file, markdown, nodeTest]],
];
for (const [name, dependencies] of consumers) {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      name,
      "exec",
      "node",
      "--conditions=source",
      "scripts/verify-installed.ts",
      ...dependencies.map((dependency) =>
        resolve(
          directory,
          manifest.packages.find(({ name }) => name === dependency)!.file,
        ),
      ),
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
