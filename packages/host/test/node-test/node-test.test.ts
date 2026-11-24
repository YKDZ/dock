import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  binding,
  check,
  defineConfig,
  inspect,
  updateBaseline,
} from "@ykdz/dock";
import {
  defineNodeTestObservation,
  defineNodeTestRun,
  nodeTest,
  nodeTestObservation,
  nodeTestPluginId,
  nodeTestStatus,
} from "@ykdz/dock/node-test";

void test("preserves legacy nodeTestPluginId and collects native node:test status and observation", async () => {
  assert.equal(nodeTestPluginId, "@ykdz/dock-reference-node-test");
  assert.equal(nodeTest.id, "@ykdz/dock-reference-node-test");

  const root = await mkdtemp(join(tmpdir(), "dock-node-test-unit-"));
  try {
    const testFile = join(root, "sample.test.mjs");
    await writeFile(
      testFile,
      [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        "",
        'test("passes and matches assertion", () => {',
        "  assert.equal(2 + 2, 4);",
        "});",
      ].join("\n"),
      "utf8",
    );

    const run = defineNodeTestRun("unit-run", { files: ["sample.test.mjs"] });
    const status = nodeTestStatus("unit-status", run, {
      file: "sample.test.mjs",
      name: "passes and matches assertion",
    });
    const config = defineConfig({
      root,
      plugins: [nodeTest],
      bindings: [binding("unit-binding", [status])],
    });

    const resolution = await inspect(config);
    assert.equal(
      resolution.plugins.some((plugin) => plugin.id === nodeTestPluginId),
      true,
    );

    const initial = await check(config);
    assert.equal(initial.bindings[0]?.consistency, "inconsistent");
    assert.equal(initial.bindings[0]?.errors, undefined);
    assert.deepEqual(
      initial.bindings[0]?.current?.references["unit-status"]?.value,
      {
        status: "passed",
      },
    );

    const updated = await updateBaseline(config);
    assert.equal(updated.status, "updated");

    const consistent = await check(config);
    assert.equal(consistent.bindings[0]?.consistency, "consistent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("validates node test run, observation, and selection inputs with English diagnostics", () => {
  assert.throws(
    () => defineNodeTestRun("empty", { files: [] as unknown as [string] }),
    /must provide an identity, at least one test file, and valid options/,
  );
  assert.throws(
    () =>
      defineNodeTestRun("bad-pattern", {
        files: ["a.test.mts"],
        namePattern: "[",
      }),
    /Invalid Node test namePattern/,
  );
  const count = defineNodeTestObservation("count", 0);
  const run = defineNodeTestRun("valid-run", { files: ["a.test.mts"] });
  assert.throws(
    () =>
      nodeTestObservation(
        "missing-key",
        run as unknown as ReturnType<typeof defineNodeTestRun<[typeof count]>>,
        { file: "a.test.mts", name: "sample" },
        count as never,
      ),
    /does not declare observation key count/,
  );
});
