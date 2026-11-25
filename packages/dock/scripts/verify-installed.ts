import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { verifyInstalledBase } from "./verify-installed-base.ts";
import { verifyInstalledVitest } from "./verify-installed-vitest.ts";

async function main(): Promise<void> {
  const artifacts = process.argv.slice(2);
  assert.equal(
    artifacts.length,
    1,
    "Installed verification expects the @boringparts/dock tarball path.",
  );
  const dockTarball = resolve(process.cwd(), artifacts[0]!);
  await access(dockTarball);

  await verifyInstalledBase(dockTarball);
  await verifyInstalledVitest(dockTarball);
  process.stdout.write(
    "Clean @boringparts/dock installed verification (base no-vitest, Vitest 4.1.11, Vitest 5.0.3, CLI, and v2 migration) passed.\n",
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Installed verification failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
