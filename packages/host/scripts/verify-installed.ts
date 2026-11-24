import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { verifyInstalledCli } from "./verify-installed-cli.ts";
import { verifyInstalledFile } from "./verify-installed-file.ts";
import { verifyInstalledHost } from "./verify-installed-host.ts";
import { verifyInstalledVitest } from "./verify-installed-vitest.ts";

async function main(): Promise<void> {
  const artifacts = process.argv.slice(2);
  assert.ok(
    artifacts.length >= 1 && artifacts.length <= 2,
    "Installed verification expects the @ykdz/dock tarball path.",
  );
  const tarballs = artifacts.map((artifact) =>
    resolve(process.cwd(), artifact),
  );
  await Promise.all(tarballs.map((artifact) => access(artifact)));

  const dockTarball = selectDockTarball(tarballs);
  await verifyInstalledHost(dockTarball);
  await verifyInstalledFile(dockTarball);
  await verifyInstalledCli(dockTarball);
  await verifyInstalledVitest(dockTarball);
  process.stdout.write(
    "Clean @ykdz/dock installed verification (host, core, file, CLI, and Vitest) passed.\n",
  );
}

function selectDockTarball(tarballs: readonly string[]): string {
  for (const tarball of tarballs) {
    const extracted = spawnSync(
      "tar",
      ["-xOf", tarball, "package/package.json"],
      { encoding: "utf8" },
    );
    if (extracted.status !== 0) continue;
    const manifest = JSON.parse(extracted.stdout) as {
      readonly name?: unknown;
    };
    if (manifest.name === "@ykdz/dock") return tarball;
  }
  const names = tarballs.map((item) => basename(item)).join(", ");
  throw new Error(`Could not find @ykdz/dock tarball in: ${names}`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Installed verification failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
