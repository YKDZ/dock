import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { collectArtifacts, packageNames } from "./release-artifacts.ts";

const directory = resolve(".artifacts/candidate");
const manifest = await collectArtifacts(directory);
const consumers: [string, number[]][] = [
  [packageNames[2], [0, 1, 2]],
  [packageNames[3], [0, 1, 2, 3]],
  [packageNames[4], [0, 1, 4, 2]],
  [packageNames[5], [0, 1, 2, 5]],
  [packageNames[6], [0, 1, 6, 4, 2]],
  ["@dock/consumer-readme", [0, 1, 2, 3, 4]],
];
for (const [name, indexes] of consumers) {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      name,
      "exec",
      "node",
      "--conditions=source",
      "scripts/verify-installed.ts",
      ...indexes.map((index) =>
        resolve(directory, manifest.packages[index]!.file),
      ),
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
