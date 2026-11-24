import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { verifyInstalledCli } from "./verify-installed-cli.ts";
import { verifyInstalledFile } from "./verify-installed-file.ts";
import { verifyInstalledHost } from "./verify-installed-host.ts";
import { verifyInstalledMarkdown } from "./verify-installed-markdown.ts";
import { verifyInstalledMigration } from "./verify-installed-migration.ts";
import { verifyInstalledNodeTest } from "./verify-installed-node-test.ts";
import { verifyInstalledTypeScript } from "./verify-installed-typescript.ts";
import { verifyInstalledVitest } from "./verify-installed-vitest.ts";

async function main(): Promise<void> {
  const artifacts = process.argv.slice(2);
  assert.equal(
    artifacts.length,
    1,
    "Installed verification expects the @ykdz/dock tarball path.",
  );
  const dockTarball = resolve(process.cwd(), artifacts[0]!);
  await access(dockTarball);

  await verifyInstalledHost(dockTarball);
  await verifyInstalledFile(dockTarball);
  await verifyInstalledCli(dockTarball);
  await verifyInstalledMarkdown(dockTarball);
  await verifyInstalledTypeScript(dockTarball);
  await verifyInstalledNodeTest(dockTarball);
  await verifyInstalledVitest(dockTarball);
  await verifyInstalledMigration(dockTarball);
  process.stdout.write(
    "Clean @ykdz/dock installed verification (host, core, file, markdown, typescript, node-test, vitest, CLI, and 0.2.x migration) passed.\n",
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Installed verification failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
