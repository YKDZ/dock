import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { nodeTest } from "@boringparts/dock/node-test";

import config, { exampleTest, readme } from "../dock.config.ts";

const consumer = fileURLToPath(new URL("../", import.meta.url));

await test(exampleTest.name, async () => {
  const extension = readme.section("扩展");
  const usage = readme.section("如何使用");
  const codeBody = "^[^\\r\\n]*\\r?\\n([\\s\\S]*?)\\r?\\n[^\\r\\n]*$";
  const inputs = {
    config: extension.node({ type: "code", language: "js" }).match(codeBody, 1),
    manifest: extension
      .node({ type: "code", language: "json" })
      .match(codeBody, 1),
    guide: extension.match("“([^”]+)”", 1),
    nextVersion: extension.match('`"([^"`]+)"`', 1),
    check: extension
      .node({ type: "code", contains: "dock check" })
      .match(codeBody, 1),
    baseline: extension
      .node({ type: "code", contains: "dock baseline update" })
      .match(codeBody, 1),
    usageCheck: usage
      .node({ type: "code", contains: "dock check" })
      .match(codeBody, 1),
    usageBaseline: usage
      .node({ type: "code", contains: "dock baseline update" })
      .match(codeBody, 1),
  };
  const source = {} as Record<keyof typeof inputs, string>;
  for (const key of Object.keys(inputs) as (keyof typeof inputs)[]) {
    const result = await nodeTest.readReferenceInTest(
      config,
      inputs[key].reference(`readme-input-${key}`),
    );
    source[key] = result.value;
  }

  // Temporary project reuses the consumer's installed dependencies so package imports resolve normally.
  const project = await mkdtemp(join(consumer, ".dock-readme-"));
  // Execute the installed dock CLI binary directly using the commands documented in README.
  const bin = join(consumer, "node_modules", ".bin");
  function runDock(command: string) {
    const result = spawnSync(command, {
      shell: true,
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      },
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    return result;
  }
  try {
    const manifest = {
      type: "module",
      ...(JSON.parse(source.manifest) as {
        engines: { node?: string };
        version?: string;
      }),
    };
    const initialVersion = manifest.engines.node;
    assert.equal(typeof initialVersion, "string");
    assert.notEqual(initialVersion, source.nextVersion);
    await writeFile(join(project, "package.json"), JSON.stringify(manifest));
    await writeFile(join(project, "install.md"), `${source.guide}\n`);
    await writeFile(join(project, "dock.config.mjs"), source.config);

    const baseline = runDock(source.baseline);
    assert.equal(baseline.status, 0, baseline.stdout);
    const saved = await readFile(join(project, "dock.baseline.json"), "utf8");

    const unchanged = runDock(source.check);
    assert.equal(unchanged.status, 0, unchanged.stdout);
    assert.equal(
      unchanged.stdout,
      "Scope: installation\nAll checked bindings are consistent with baseline.\n",
    );

    manifest.version = "1.0.1";
    await writeFile(join(project, "package.json"), JSON.stringify(manifest));
    const unrelated = runDock(source.check);
    assert.equal(unrelated.status, 0, unrelated.stdout);
    assert.equal(
      unrelated.stdout,
      "Scope: installation\nAll checked bindings are consistent with baseline.\n",
    );

    manifest.engines.node = source.nextVersion;
    await writeFile(join(project, "package.json"), JSON.stringify(manifest));
    const changed = runDock(source.check);
    assert.equal(changed.status, 1, changed.stdout);
    assert.match(changed.stdout, /Binding installation/u);
    assert.ok(
      changed.stdout.includes(
        `Change: node-version fact: before ${JSON.stringify(initialVersion)}; after ${JSON.stringify(source.nextVersion)}`,
      ),
      changed.stdout,
    );
    assert.match(changed.stdout, /install-guide \(install\.md:1\)/u);
    assert.doesNotMatch(changed.stdout, /Current fact:/u);
    assert.ok(!changed.stdout.includes(JSON.stringify(`${source.guide}\n`)));
    assert.equal(
      await readFile(join(project, "dock.baseline.json"), "utf8"),
      saved,
    );

    delete manifest.engines.node;
    await writeFile(join(project, "package.json"), JSON.stringify(manifest));
    const missing = runDock(source.check);
    assert.equal(missing.status, 1, missing.stdout);
    assert.match(missing.stdout, /Error node-version/u);

    // Run the same example via the TypeScript config entry from the usage section.
    manifest.engines.node = source.nextVersion;
    await writeFile(join(project, "package.json"), JSON.stringify(manifest));
    await writeFile(join(project, "dock.config.ts"), source.config);
    const updated = runDock(source.usageBaseline);
    assert.equal(updated.status, 0, updated.stdout);
    assert.notEqual(
      await readFile(join(project, "dock.baseline.json"), "utf8"),
      saved,
    );
    const confirmed = runDock(source.usageCheck);
    assert.equal(confirmed.status, 0, confirmed.stdout);
    assert.equal(
      confirmed.stdout,
      "Scope: installation\nAll checked bindings are consistent with baseline.\n",
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
