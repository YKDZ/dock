import { spawnSync } from "node:child_process";

const resolveTarball = spawnSync(
  "pnpm",
  [
    "--filter",
    "@ykdz/dock",
    "exec",
    "node",
    "--input-type=module",
    "-e",
    'import { access } from "node:fs/promises"; import { resolve } from "node:path"; const tarball = resolve(".artifacts/package.tgz"); await access(tarball); process.stdout.write(tarball);',
  ],
  { encoding: "utf8" },
);
if (resolveTarball.status !== 0) {
  if (resolveTarball.stderr !== "") {
    process.stderr.write(resolveTarball.stderr);
  }
  process.exit(resolveTarball.status ?? 1);
}
const tarball = resolveTarball.stdout.trim();
if (tarball === "") {
  process.stderr.write(
    "Failed to resolve @ykdz/dock tarball path from package directory.\n",
  );
  process.exit(1);
}

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
