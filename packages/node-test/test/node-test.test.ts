import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  binding,
  check,
  createReference,
  defineConfig,
  definePlugin,
  inspect,
  MaintenanceError,
  type PluginBatchResult,
  type PluginContext,
  type PluginReadResult,
  type PluginRequest,
  type Reference,
  updateBaseline,
} from "@dock/host";
import {
  defineNodeTestObservation,
  defineNodeTestRun,
  nodeTest,
  nodeTestObservation,
  nodeTestPluginId,
  nodeTestStatus,
} from "@dock/node-test";

type DocReference = Reference<"test:doc", string, string, string>;

const docPlugin = definePlugin({
  id: "test:doc",
  validate(reference: DocReference): void {
    if (typeof reference.target !== "string" || reference.target.length === 0) {
      throw new TypeError("Document target must be a non-empty path.");
    }
  },
  fileInfo(reference: DocReference): string {
    return reference.target;
  },
  async read(
    reference: DocReference,
    context: PluginContext,
  ): Promise<PluginReadResult<string>> {
    const value = await readFile(join(context.root, reference.target), "utf8");
    return {
      value,
      range: { path: reference.target, start: 0, end: value.length },
    };
  },
  async collect(
    request: PluginRequest<DocReference>,
    context: PluginContext,
  ): Promise<PluginBatchResult<string>> {
    const results = await Promise.all(
      request.selectedReferences.map(async (reference) => {
        const value = await readFile(
          join(context.root, reference.target),
          "utf8",
        );
        return {
          referenceId: reference.id,
          kind: "value" as const,
          value,
          range: { path: reference.target, start: 0, end: value.length },
        };
      }),
    );
    return { results };
  },
});

function docReference(id = "doc", path = "doc.txt"): DocReference {
  return createReference<"test:doc", string, string, string>(
    "test:doc",
    id,
    path,
  );
}

void test("uses dock:node-test plugin ID and collects native node:test status and observation", async () => {
  assert.equal(nodeTestPluginId, "dock:node-test");
  assert.equal(nodeTest.id, "dock:node-test");

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

const nodeTestSourceUrl = import.meta.resolve("@dock/node-test");
const hostSourceUrl = import.meta.resolve("@dock/host");

void test("node-test baseline comparison ignores shared run arrangement, catches re-targeting, and preserves baseline bytes on errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-node-test-comparable-"));
  const baselinePath = join(root, "dock.baseline.json");

  try {
    await mkdir(join(root, "suite", "alt"), { recursive: true });
    await writeFile(join(root, "doc.txt"), "contract v1\n", "utf8");
    const primaryFile = join(root, "suite", "primary.test.mjs");
    const extraFile = join(root, "suite", "extra.test.mjs");
    const altFile = join(root, "suite", "alt", "primary.test.mjs");

    const primaryContent = [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      `import { defineNodeTestObservation } from ${JSON.stringify(nodeTestSourceUrl)};`,
      "",
      'const metric = defineNodeTestObservation("metric", 0);',
      'const secondary = defineNodeTestObservation("secondary", "");',
      "",
      'test("alpha passes", () => {',
      "  assert.equal(1 + 1, 2);",
      "  metric.record(42);",
      '  secondary.record("alpha-sec");',
      "});",
      "",
      'test("beta passes", () => {',
      "  assert.equal(2 + 2, 4);",
      "});",
      "",
      'test.skip("skipped case", () => {',
      "  assert.fail();",
      "});",
    ].join("\n");
    await writeFile(primaryFile, primaryContent, "utf8");
    await writeFile(
      extraFile,
      [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'test("extra unrelated test", () => { assert.ok(true); });',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      altFile,
      [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'test("alpha passes", () => { assert.ok(true); });',
      ].join("\n"),
      "utf8",
    );

    const metric = defineNodeTestObservation("metric", 0);
    const secondary = defineNodeTestObservation("secondary", "");
    const extraUnused = defineNodeTestObservation("unused", false);

    const initialRun = defineNodeTestRun("initial-run", {
      files: ["suite/primary.test.mjs"],
      namePattern: "^alpha passes$",
      observations: [metric],
    });
    const initialConfig = defineConfig({
      root,
      plugins: [docPlugin, nodeTest],
      bindings: [
        binding("alpha-status-binding", [
          docReference(),
          nodeTestStatus("alpha-status", initialRun, {
            file: "suite/primary.test.mjs",
            name: "alpha passes",
          }),
        ]),
        binding("alpha-metric-binding", [
          nodeTestObservation(
            "alpha-metric",
            initialRun,
            { file: "suite/primary.test.mjs", name: "alpha passes" },
            metric,
          ),
        ]),
      ],
    });

    const created = await updateBaseline(initialConfig);
    assert.equal(created.status, "updated");
    if (created.status !== "updated") return;
    assert.equal(created.baseline.version, 3);
    assert.deepEqual(
      created.baseline.bindings["alpha-status-binding"]?.references[
        "alpha-status"
      ]?.definition.target,
      {
        pluginId: nodeTestPluginId,
        target: { kind: "node-test-status", name: "alpha passes" },
        fileInfo: "suite/primary.test.mjs",
      },
    );
    assert.deepEqual(
      created.baseline.bindings["alpha-metric-binding"]?.references[
        "alpha-metric"
      ]?.definition.target,
      {
        pluginId: nodeTestPluginId,
        target: {
          kind: "node-test-observation",
          name: "alpha passes",
          key: "metric",
        },
        fileInfo: "suite/primary.test.mjs",
      },
    );
    const savedBaselineBytes = await readFile(baselinePath, "utf8");

    // Rename run, add unrelated file, register unused observation, relax namePattern,
    // and extract testRoot without changing the resolved target file.
    const rearrangedRun = defineNodeTestRun("renamed-run", {
      testRoot: "suite",
      files: ["primary.test.mjs", "extra.test.mjs"],
      namePattern: "^(alpha|beta) passes$",
      observations: [metric, secondary, extraUnused],
    });
    const rearrangedConfig = defineConfig({
      root,
      plugins: [docPlugin, nodeTest],
      bindings: [
        binding("alpha-status-binding", [
          docReference(),
          nodeTestStatus("alpha-status", rearrangedRun, {
            file: "primary.test.mjs",
            name: "alpha passes",
          }),
        ]),
        binding("alpha-metric-binding", [
          nodeTestObservation(
            "alpha-metric",
            rearrangedRun,
            { file: "primary.test.mjs", name: "alpha passes" },
            metric,
          ),
        ]),
      ],
    });
    const afterRearrangement = await check(rearrangedConfig);
    assert.deepEqual(
      afterRearrangement.bindings.map((entry) => entry.consistency),
      ["consistent", "consistent"],
    );

    // Same-identity conflicting run configurations still fail full-config preflight.
    const conflictingRun = defineNodeTestRun("renamed-run", {
      testRoot: "suite",
      files: ["primary.test.mjs"],
      observations: [metric],
    });
    await assert.rejects(
      check(
        defineConfig({
          root,
          plugins: [nodeTest],
          bindings: [
            binding("b1", [
              nodeTestStatus("s1", rearrangedRun, {
                file: "primary.test.mjs",
                name: "alpha passes",
              }),
            ]),
            binding("b2", [
              nodeTestStatus("s2", conflictingRun, {
                file: "primary.test.mjs",
                name: "beta passes",
              }),
            ]),
          ],
        }),
      ),
      (error: unknown) =>
        error instanceof MaintenanceError &&
        error.code === "plugin-prepare-failed",
    );

    // Retargeting to another actual file with a passing test of the same name reports definition diff.
    const retargetedFileRun = defineNodeTestRun("retargeted-file", {
      testRoot: "suite/alt",
      files: ["primary.test.mjs"],
    });
    const retargetedFileCheck = await check(
      defineConfig({
        root,
        plugins: [docPlugin, nodeTest],
        bindings: [
          binding("alpha-status-binding", [
            docReference(),
            nodeTestStatus("alpha-status", retargetedFileRun, {
              file: "primary.test.mjs",
              name: "alpha passes",
            }),
          ]),
        ],
      }),
      { binding: ["alpha-status-binding"] },
    );
    assert.equal(retargetedFileCheck.bindings[0]?.consistency, "inconsistent");
    assert.equal(
      retargetedFileCheck.bindings[0]?.changes.some(
        (change) =>
          change.kind === "reference-definition" &&
          change.referenceId === "alpha-status",
      ),
      true,
    );

    // Changing selected test name or observation key reports reference-definition change.
    const renamedTestCheck = await check(
      defineConfig({
        root,
        plugins: [docPlugin, nodeTest],
        bindings: [
          binding("alpha-status-binding", [
            docReference(),
            nodeTestStatus("alpha-status", rearrangedRun, {
              file: "primary.test.mjs",
              name: "beta passes",
            }),
          ]),
          binding("alpha-metric-binding", [
            nodeTestObservation(
              "alpha-metric",
              rearrangedRun,
              { file: "primary.test.mjs", name: "alpha passes" },
              secondary,
            ),
          ]),
        ],
      }),
    );
    for (const entry of renamedTestCheck.bindings) {
      assert.equal(entry.consistency, "inconsistent");
      assert.equal(
        entry.changes.some((change) => change.kind === "reference-definition"),
        true,
      );
    }

    // Filtering out or skipping the required test rejects update and preserves baseline bytes.
    const filteredRun = defineNodeTestRun("filtered-run", {
      testRoot: "suite",
      files: ["primary.test.mjs"],
      namePattern: "^beta passes$",
      observations: [metric],
    });
    const filteredUpdate = await updateBaseline(
      defineConfig({
        root,
        plugins: [docPlugin, nodeTest],
        bindings: [
          binding("alpha-status-binding", [
            docReference(),
            nodeTestStatus("alpha-status", filteredRun, {
              file: "primary.test.mjs",
              name: "alpha passes",
            }),
          ]),
          binding("alpha-metric-binding", [
            nodeTestObservation(
              "alpha-metric",
              filteredRun,
              { file: "primary.test.mjs", name: "alpha passes" },
              metric,
            ),
          ]),
        ],
      }),
    );
    assert.equal(filteredUpdate.status, "rejected");
    assert.equal(
      filteredUpdate.report.bindings[0]?.errors?.[0]?.code,
      "test-filtered",
    );
    assert.equal(await readFile(baselinePath, "utf8"), savedBaselineBytes);

    const unfilteredRun = defineNodeTestRun("unfiltered-run", {
      testRoot: "suite",
      files: ["primary.test.mjs"],
      observations: [metric],
    });
    const skippedUpdate = await updateBaseline(
      defineConfig({
        root,
        plugins: [docPlugin, nodeTest],
        bindings: [
          binding("alpha-status-binding", [
            docReference(),
            nodeTestStatus("alpha-status", unfilteredRun, {
              file: "primary.test.mjs",
              name: "skipped case",
            }),
          ]),
        ],
      }),
      { binding: ["alpha-status-binding"] },
    );
    assert.equal(skippedUpdate.status, "rejected");
    assert.equal(
      skippedUpdate.report.bindings[0]?.errors?.[0]?.code,
      "test-skipped",
    );
    assert.equal(await readFile(baselinePath, "utf8"), savedBaselineBytes);

    // Missing observation on a passing test rejects update and preserves baseline bytes.
    const missingObsRun = defineNodeTestRun("missing-obs-run", {
      testRoot: "suite",
      files: ["primary.test.mjs"],
      observations: [metric, extraUnused],
    });
    const missingObsConfig = defineConfig({
      root,
      plugins: [nodeTest],
      bindings: [
        binding("alpha-metric-binding", [
          nodeTestObservation(
            "alpha-metric",
            missingObsRun,
            { file: "primary.test.mjs", name: "alpha passes" },
            extraUnused,
          ),
        ]),
      ],
    });
    const missingObsCheck = await check(missingObsConfig, {
      binding: ["alpha-metric-binding"],
    });
    assert.equal(
      missingObsCheck.bindings[0]?.errors?.[0]?.code,
      "observation-missing",
    );
    const missingObsUpdate = await updateBaseline(missingObsConfig, {
      binding: ["alpha-metric-binding"],
    });
    assert.equal(missingObsUpdate.status, "rejected");
    assert.equal(
      missingObsUpdate.report.bindings[0]?.errors?.[0]?.code,
      "observation-missing",
    );
    assert.equal(await readFile(baselinePath, "utf8"), savedBaselineBytes);

    // Shared teardown failure invalidates evidence and preserves baseline bytes.
    await writeFile(
      primaryFile,
      [
        'import assert from "node:assert/strict";',
        'import { after, test } from "node:test";',
        'test("alpha passes", () => { assert.equal(1 + 1, 2); });',
        'after(() => { throw new Error("shared teardown failure"); });',
      ].join("\n"),
      "utf8",
    );
    const teardownFailedUpdate = await updateBaseline(
      defineConfig({
        root,
        plugins: [docPlugin, nodeTest],
        bindings: [
          binding("alpha-status-binding", [
            docReference(),
            nodeTestStatus("alpha-status", initialRun, {
              file: "suite/primary.test.mjs",
              name: "alpha passes",
            }),
          ]),
        ],
      }),
      { binding: ["alpha-status-binding"] },
    );
    assert.equal(teardownFailedUpdate.status, "rejected");
    assert.equal(
      teardownFailedUpdate.report.bindings[0]?.errors?.[0]?.code,
      "run-lifecycle-failed",
    );
    assert.equal(await readFile(baselinePath, "utf8"), savedBaselineBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("readReferenceInTest requires an active node:test callback and records reads with range during native execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-node-test-read-"));
  try {
    await writeFile(join(root, "doc.txt"), "contract v1\n", "utf8");
    const doc = docReference();

    const testFile = join(root, "read.test.mjs");
    await writeFile(
      testFile,
      [
        'import assert from "node:assert/strict";',
        'import { readFile } from "node:fs/promises";',
        'import { join } from "node:path";',
        'import { test } from "node:test";',
        `import { createReference, defineConfig, definePlugin } from ${JSON.stringify(hostSourceUrl)};`,
        `import { defineNodeTestObservation, readReferenceInTest } from ${JSON.stringify(nodeTestSourceUrl)};`,
        "",
        "const localDocPlugin = definePlugin({",
        '  id: "test:doc",',
        "  validate() {},",
        "  async read(reference, context) {",
        '    const value = await readFile(join(context.root, reference.target), "utf8");',
        "    return { value, range: { path: reference.target, start: 0, end: value.length } };",
        "  },",
        "  collect() { return { results: [] }; },",
        "});",
        'const localDoc = createReference("test:doc", "doc", "doc.txt");',
        `const localConfig = defineConfig({ root: ${JSON.stringify(root)}, plugins: [localDocPlugin], bindings: [] });`,
        'const observed = defineNodeTestObservation("doc-length", 0);',
        "",
        "await assert.rejects(",
        "  readReferenceInTest(localConfig, localDoc),",
        "  /must be called inside an active Node native test callback/,",
        ");",
        "",
        'test("reads document in active test", async () => {',
        "  const result = await readReferenceInTest(localConfig, localDoc);",
        '  assert.equal(result.value, "contract v1\\n");',
        "  observed.record(result.value.length);",
        "});",
      ].join("\n"),
      "utf8",
    );

    const observed = defineNodeTestObservation("doc-length", 0);
    const run = defineNodeTestRun("read-in-test-run", {
      files: ["read.test.mjs"],
      observations: [observed],
    });
    const config = defineConfig({
      root,
      plugins: [docPlugin, nodeTest],
      bindings: [
        binding("doc-read-binding", [
          doc,
          nodeTestObservation(
            "doc-length-ref",
            run,
            { file: "read.test.mjs", name: "reads document in active test" },
            observed,
          ),
        ]),
      ],
    });

    const report = await check(config);
    assert.equal(report.bindings[0]?.consistency, "inconsistent");
    assert.equal(report.bindings[0]?.errors, undefined);
    assert.equal(
      report.bindings[0]?.current?.references["doc-length-ref"]?.value,
      "contract v1\n".length,
    );
    const nodeDiagnostics = report.pluginDiagnostics.find(
      (entry) => entry.pluginId === nodeTestPluginId,
    )?.data as unknown as {
      readonly runs: readonly {
        readonly reads: readonly {
          readonly referenceId: string;
          readonly value: unknown;
          readonly range?: {
            readonly path: string;
            readonly start: number;
            readonly end: number;
          };
        }[];
      }[];
    };
    assert.deepEqual(nodeDiagnostics.runs[0]?.reads[0]?.referenceId, "doc");
    assert.equal(nodeDiagnostics.runs[0]?.reads[0]?.value, "contract v1\n");
    assert.deepEqual(nodeDiagnostics.runs[0]?.reads[0]?.range, {
      path: "doc.txt",
      start: 0,
      end: "contract v1\n".length,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
