import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  binding,
  check,
  createReference,
  defineConfig,
  definePlugin,
  MaintenanceError,
  type PluginBatchResult,
  type PluginContext,
  type PluginRequest,
  type Reference,
  updateBaseline,
} from "@dock/host";
import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
  vitestPluginId,
  vitestStatus,
  vitestSuite,
} from "@dock/vitest";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const vitestSourceUrl = pathToFileURL(
  join(packageDirectory, "src", "index.ts"),
).href;

type LocalTextFileReference = Reference<
  "fixture:text-file",
  string,
  string,
  string
>;

const localTextFilePlugin = definePlugin({
  id: "fixture:text-file",
  validate(reference: LocalTextFileReference): void {
    if (typeof reference.target !== "string" || reference.target.length === 0) {
      throw new TypeError("Text file target must be a non-empty path.");
    }
  },
  fileInfo(reference: LocalTextFileReference): string {
    return reference.target;
  },
  async collect(
    request: PluginRequest<LocalTextFileReference>,
    context: PluginContext,
  ): Promise<PluginBatchResult<string>> {
    const results = await Promise.all(
      request.selectedReferences.map(async (reference) => ({
        referenceId: reference.id,
        kind: "value" as const,
        value: await readFile(join(context.root, reference.target), "utf8"),
      })),
    );
    return { results };
  },
});

function localTextFileReference(
  id: string,
  path: string,
): LocalTextFileReference {
  return createReference<"fixture:text-file", string, string, string>(
    "fixture:text-file",
    id,
    path,
  );
}

void test("vitest baseline comparison ignores shared run arrangement and config switches, catches re-targeting, and preserves baseline bytes on errors", async () => {
  const cacheDirectory = join(packageDirectory, "node_modules", ".cache");
  await mkdir(cacheDirectory, { recursive: true });
  const root = await mkdtemp(join(cacheDirectory, "dock-vitest-comparable-"));
  const baselinePath = join(root, "dock.baseline.json");

  try {
    await mkdir(join(root, "suite", "alt"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "vitest-comparable-fixture",
        private: true,
        type: "module",
      }),
      "utf8",
    );
    await writeFile(join(root, "doc.txt"), "vitest contract v1\n", "utf8");
    await writeFile(
      join(root, "vitest.alpha.config.mjs"),
      "export default { test: { testNamePattern: /alpha|group/ } };\n",
      "utf8",
    );
    await writeFile(
      join(root, "vitest.beta.config.mjs"),
      "export default { test: { testNamePattern: /.*/ } };\n",
      "utf8",
    );
    await writeFile(
      join(root, "vitest.filtered.config.mjs"),
      "export default { test: { testNamePattern: /beta/ } };\n",
      "utf8",
    );

    const primaryFile = join(root, "suite", "primary.test.mjs");
    const extraFile = join(root, "suite", "extra.test.mjs");
    const altFile = join(root, "suite", "alt", "primary.test.mjs");

    await writeFile(
      primaryFile,
      [
        'import { describe, expect, it } from "vitest";',
        `import { defineVitestObservation } from ${JSON.stringify(vitestSourceUrl)};`,
        "",
        'const metric = defineVitestObservation("metric", 0);',
        'const secondary = defineVitestObservation("secondary", "");',
        "",
        'it("alpha passes", () => {',
        "  expect(1 + 1).toBe(2);",
        "  metric.record(7);",
        '  secondary.record("alpha-sec");',
        "});",
        "",
        'it("beta passes", () => {',
        "  expect(2 + 2).toBe(4);",
        "  metric.record(9);",
        "});",
        "",
        'describe("group", () => {',
        '  it("member one", () => {',
        "    expect(true).toBe(true);",
        "    metric.record(100);",
        '    secondary.record("one");',
        "  });",
        "});",
        "",
        'describe("alt-group", () => {',
        '  it("member two", () => {',
        "    expect(true).toBe(true);",
        "    metric.record(200);",
        '    secondary.record("two");',
        "  });",
        "});",
        "",
        'it.skip("skipped case", () => {',
        "  expect(1).toBe(2);",
        "});",
        "",
        "let retryAttempt = 0;",
        'it("flaky missing final observation", { retry: 1 }, () => {',
        "  retryAttempt += 1;",
        "  if (retryAttempt === 1) {",
        "    metric.record(1);",
        '    throw new Error("first attempt fails");',
        "  }",
        "});",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      extraFile,
      [
        'import { expect, it } from "vitest";',
        'it("extra unrelated test", () => { expect(true).toBe(true); });',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      altFile,
      [
        'import { describe, expect, it } from "vitest";',
        `import { defineVitestObservation } from ${JSON.stringify(vitestSourceUrl)};`,
        "",
        'const metric = defineVitestObservation("metric", 0);',
        "",
        'it("alpha passes", () => { expect(true).toBe(true); });',
        "",
        'describe("group", () => {',
        '  it("member one", () => {',
        "    expect(true).toBe(true);",
        "    metric.record(100);",
        "  });",
        "});",
      ].join("\n"),
      "utf8",
    );

    const metric = defineVitestObservation("metric", 0);
    const secondary = defineVitestObservation("secondary", "");
    const unused = defineVitestObservation("unused", false);

    const initialRun = defineVitestRun("initial-vitest-run", {
      files: ["suite/primary.test.mjs"],
      configFile: "vitest.alpha.config.mjs",
      observations: [metric, secondary],
    });
    const initialConfig = defineConfig({
      root,
      plugins: [localTextFilePlugin, vitest],
      bindings: [
        binding("alpha-status-binding", [
          localTextFileReference("doc", "doc.txt"),
          vitestStatus("alpha-status", initialRun, {
            file: "suite/primary.test.mjs",
            name: "alpha passes",
          }),
        ]),
        binding("alpha-metric-binding", [
          vitestObservation(
            "alpha-metric",
            initialRun,
            { file: "suite/primary.test.mjs", name: "alpha passes" },
            metric,
          ),
        ]),
        binding("group-suite-binding", [
          vitestSuite(
            "group-suite",
            initialRun,
            { file: "suite/primary.test.mjs", suitePath: ["group"] },
            [metric],
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
        pluginId: vitestPluginId,
        target: { kind: "vitest-test-status", name: "alpha passes" },
        fileInfo: "suite/primary.test.mjs",
      },
    );
    assert.deepEqual(
      created.baseline.bindings["alpha-metric-binding"]?.references[
        "alpha-metric"
      ]?.definition.target,
      {
        pluginId: vitestPluginId,
        target: {
          kind: "vitest-test-observation",
          name: "alpha passes",
          key: "metric",
        },
        fileInfo: "suite/primary.test.mjs",
      },
    );
    assert.deepEqual(
      created.baseline.bindings["group-suite-binding"]?.references[
        "group-suite"
      ]?.definition.target,
      {
        pluginId: vitestPluginId,
        target: {
          kind: "vitest-suite",
          suitePath: ["group"],
          observationKeys: ["metric"],
        },
        fileInfo: "suite/primary.test.mjs",
      },
    );
    const savedBaselineBytes = await readFile(baselinePath, "utf8");

    // Rename run, add unrelated file, add additionalTests, register unused observation,
    // and switch configFile (relaxing testNamePattern) with all three reference kinds consistent.
    const rearrangedRun = defineVitestRun("renamed-vitest-run", {
      configFile: "vitest.beta.config.mjs",
      files: ["suite/primary.test.mjs", "suite/extra.test.mjs"],
      additionalTests: [
        { file: "suite/extra.test.mjs", name: "extra unrelated test" },
      ],
      observations: [metric, secondary, unused],
    });
    const rearrangedConfig = defineConfig({
      root,
      plugins: [localTextFilePlugin, vitest],
      bindings: [
        binding("alpha-status-binding", [
          localTextFileReference("doc", "doc.txt"),
          vitestStatus("alpha-status", rearrangedRun, {
            file: "suite/primary.test.mjs",
            name: "alpha passes",
          }),
        ]),
        binding("alpha-metric-binding", [
          vitestObservation(
            "alpha-metric",
            rearrangedRun,
            { file: "suite/primary.test.mjs", name: "alpha passes" },
            metric,
          ),
        ]),
        binding("group-suite-binding", [
          vitestSuite(
            "group-suite",
            rearrangedRun,
            { file: "suite/primary.test.mjs", suitePath: ["group"] },
            [metric],
          ),
        ]),
      ],
    });
    const afterRearrangement = await check(rearrangedConfig);
    assert.deepEqual(
      afterRearrangement.bindings.map((entry) => entry.consistency),
      ["consistent", "consistent", "consistent"],
    );

    // Extracting testRoot while resolving to the exact same fileInfo also keeps status/observation/suite consistent.
    const movedTestRootRun = defineVitestRun("moved-test-root-run", {
      testRoot: "suite",
      configFile: "vitest.beta.config.mjs",
      files: ["primary.test.mjs", "extra.test.mjs"],
      additionalTests: [
        { file: "extra.test.mjs", name: "extra unrelated test" },
      ],
      observations: [metric, secondary, unused],
    });
    const afterMovedTestRoot = await check(
      defineConfig({
        root,
        plugins: [localTextFilePlugin, vitest],
        bindings: [
          binding("alpha-status-binding", [
            localTextFileReference("doc", "doc.txt"),
            vitestStatus("alpha-status", movedTestRootRun, {
              file: "primary.test.mjs",
              name: "alpha passes",
            }),
          ]),
          binding("alpha-metric-binding", [
            vitestObservation(
              "alpha-metric",
              movedTestRootRun,
              { file: "primary.test.mjs", name: "alpha passes" },
              metric,
            ),
          ]),
          binding("group-suite-binding", [
            vitestSuite(
              "group-suite",
              movedTestRootRun,
              { file: "primary.test.mjs", suitePath: ["group"] },
              [metric],
            ),
          ]),
        ],
      }),
      {
        binding: [
          "alpha-status-binding",
          "alpha-metric-binding",
          "group-suite-binding",
        ],
      },
    );
    assert.deepEqual(
      afterMovedTestRoot.bindings.map((entry) => entry.consistency),
      ["consistent", "consistent", "consistent"],
    );

    // Same-identity conflicting run configurations still fail full-config preflight.
    const conflictingRun = defineVitestRun("renamed-vitest-run", {
      files: ["suite/primary.test.mjs"],
      observations: [metric],
    });
    await assert.rejects(
      check(
        defineConfig({
          root,
          plugins: [vitest],
          bindings: [
            binding("b1", [
              vitestStatus("s1", rearrangedRun, {
                file: "suite/primary.test.mjs",
                name: "alpha passes",
              }),
            ]),
            binding("b2", [
              vitestStatus("s2", conflictingRun, {
                file: "suite/primary.test.mjs",
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

    // Retargeting to another actual file with a passing test/suite of the same name reports definition diff.
    const retargetedFileRun = defineVitestRun("retargeted-file", {
      testRoot: "suite/alt",
      files: ["primary.test.mjs"],
      observations: [metric],
    });
    const retargetedFileCheck = await check(
      defineConfig({
        root,
        plugins: [localTextFilePlugin, vitest],
        bindings: [
          binding("alpha-status-binding", [
            localTextFileReference("doc", "doc.txt"),
            vitestStatus("alpha-status", retargetedFileRun, {
              file: "primary.test.mjs",
              name: "alpha passes",
            }),
          ]),
          binding("group-suite-binding", [
            vitestSuite(
              "group-suite",
              retargetedFileRun,
              { file: "primary.test.mjs", suitePath: ["group"] },
              [metric],
            ),
          ]),
        ],
      }),
      { binding: ["alpha-status-binding", "group-suite-binding"] },
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
    assert.equal(retargetedFileCheck.bindings[1]?.consistency, "inconsistent");
    assert.equal(
      retargetedFileCheck.bindings[1]?.changes.some(
        (change) =>
          change.kind === "reference-definition" &&
          change.referenceId === "group-suite",
      ),
      true,
    );

    // Changing selected test name, observation key, suitePath, or suite observationKeys reports definition diff.
    const changedSelectionsCheck = await check(
      defineConfig({
        root,
        plugins: [localTextFilePlugin, vitest],
        bindings: [
          binding("alpha-status-binding", [
            localTextFileReference("doc", "doc.txt"),
            vitestStatus("alpha-status", rearrangedRun, {
              file: "suite/primary.test.mjs",
              name: "beta passes",
            }),
          ]),
          binding("alpha-metric-binding", [
            vitestObservation(
              "alpha-metric",
              rearrangedRun,
              { file: "suite/primary.test.mjs", name: "alpha passes" },
              secondary,
            ),
          ]),
          binding("group-suite-binding", [
            vitestSuite(
              "group-suite",
              rearrangedRun,
              { file: "suite/primary.test.mjs", suitePath: ["alt-group"] },
              [metric, secondary],
            ),
          ]),
        ],
      }),
    );
    for (const entry of changedSelectionsCheck.bindings) {
      assert.equal(entry.consistency, "inconsistent");
      assert.equal(
        entry.changes.some((change) => change.kind === "reference-definition"),
        true,
      );
    }

    // Filtering out the required test via configFile rejects update and preserves baseline bytes.
    const filteredRun = defineVitestRun("filtered-vitest-run", {
      testRoot: "suite",
      configFile: "vitest.filtered.config.mjs",
      files: ["primary.test.mjs"],
      observations: [metric],
    });
    const filteredUpdate = await updateBaseline(
      defineConfig({
        root,
        plugins: [localTextFilePlugin, vitest],
        bindings: [
          binding("alpha-status-binding", [
            localTextFileReference("doc", "doc.txt"),
            vitestStatus("alpha-status", filteredRun, {
              file: "primary.test.mjs",
              name: "alpha passes",
            }),
          ]),
        ],
      }),
      { binding: ["alpha-status-binding"] },
    );
    assert.equal(filteredUpdate.status, "rejected");
    assert.equal(
      filteredUpdate.report.bindings[0]?.errors?.[0]?.code,
      "test-skipped",
    );
    assert.equal(await readFile(baselinePath, "utf8"), savedBaselineBytes);

    // Skipped required test rejects update and preserves baseline bytes.
    const skippedUpdate = await updateBaseline(
      defineConfig({
        root,
        plugins: [localTextFilePlugin, vitest],
        bindings: [
          binding("alpha-status-binding", [
            localTextFileReference("doc", "doc.txt"),
            vitestStatus("alpha-status", rearrangedRun, {
              file: "suite/primary.test.mjs",
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

    // Passing final retry attempt without selected observation rejects update and preserves baseline bytes.
    const missingFinalObsUpdate = await updateBaseline(
      defineConfig({
        root,
        plugins: [vitest],
        bindings: [
          binding("alpha-metric-binding", [
            vitestObservation(
              "alpha-metric",
              rearrangedRun,
              {
                file: "suite/primary.test.mjs",
                name: "flaky missing final observation",
              },
              metric,
            ),
          ]),
        ],
      }),
      { binding: ["alpha-metric-binding"] },
    );
    assert.equal(missingFinalObsUpdate.status, "rejected");
    assert.equal(
      missingFinalObsUpdate.report.bindings[0]?.errors?.[0]?.code,
      "observation-missing",
    );
    assert.equal(await readFile(baselinePath, "utf8"), savedBaselineBytes);

    // Shared teardown failure invalidates evidence and preserves baseline bytes.
    await writeFile(
      primaryFile,
      [
        'import { afterAll, expect, it } from "vitest";',
        'it("alpha passes", () => { expect(1 + 1).toBe(2); });',
        'afterAll(() => { throw new Error("shared vitest teardown failure"); });',
      ].join("\n"),
      "utf8",
    );
    const teardownFailedUpdate = await updateBaseline(
      defineConfig({
        root,
        plugins: [localTextFilePlugin, vitest],
        bindings: [
          binding("alpha-status-binding", [
            localTextFileReference("doc", "doc.txt"),
            vitestStatus("alpha-status", initialRun, {
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
