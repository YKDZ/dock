import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

const tarball = resolve("packages/host/.artifacts/package.tgz");
await access(tarball);

for (const packageName of ["@ykdz/dock", "@dock/consumer-readme"] as const) {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      packageName,
      "exec",
      "node",
      "--conditions=source",
      "scripts/verify-installed.ts",
      tarball,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
