import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  type PluginBatchResult,
  type PluginInformation,
  type PluginRequest,
  type Reference,
  updateBaseline,
} from "@dock/host";

type FixtureReference = Reference<
  "fixture-plugin",
  string,
  { readonly path: string },
  string
>;

type Prepared = { readonly token: string };

function fixtureReference(id: string, path = id): FixtureReference {
  return createReference<
    "fixture-plugin",
    string,
    { readonly path: string },
    string
  >("fixture-plugin", id, { path });
}

void test("inspect and check share the batch contract and expose only explicit descriptions", async () => {
  const calls: PluginRequest<FixtureReference, Prepared>[] = [];
  let collections = 0;
  const plugin = definePlugin({
    id: "fixture-plugin",
    validate(_reference: FixtureReference): void {},
    prepare(references: readonly FixtureReference[]): Prepared {
      return { token: `prepared-${references.length}` };
    },
    describe(request: PluginRequest<FixtureReference, Prepared>) {
      return {
        data: {
          preparedToken: request.prepared?.token ?? "",
          selected: request.selectedReferences.map(({ id }) => id),
        },
        text: ["Catalog prepared"],
      };
    },
    collect(
      request: PluginRequest<FixtureReference, Prepared>,
    ): PluginBatchResult<string> {
      collections += 1;
      calls.push(request);
      return {
        results: request.selectedReferences.map((reference) => ({
          referenceId: reference.id,
          kind: "value",
          value: request.prepared?.token ?? reference.target.path,
        })),
      };
    },
  });
  const first = createReference<
    "fixture-plugin",
    string,
    { readonly path: string },
    string
  >("fixture-plugin", "first", { path: "first.txt" });
  const second = createReference<
    "fixture-plugin",
    string,
    { readonly path: string },
    string
  >("fixture-plugin", "second", { path: "second.txt" });
  const config = defineConfig({
    plugins: [plugin],
    bindings: [
      binding("first-policy", [first]),
      binding("second-policy", [second]),
    ],
  });

  const view = await inspect(config, { binding: ["first-policy"] });
  assert.deepEqual(view.plugins, [
    {
      id: "fixture-plugin",
      references: ["first", "second"],
      selectedReferences: ["first"],
      description: {
        data: { preparedToken: "prepared-2", selected: ["first"] },
        text: ["Catalog prepared"],
      },
    },
  ]);
  assert.equal(collections, 0);

  const report = await check(config, { binding: ["first-policy"] });
  assert.equal(collections, 1);
  assert.deepEqual(
    calls[0]?.references.map(({ id }) => id),
    ["first", "second"],
  );
  assert.deepEqual(
    calls[0]?.selectedReferences.map(({ id }) => id),
    ["first"],
  );
  assert.deepEqual(calls[0]?.prepared, { token: "prepared-2" });
  assert.equal(
    report.bindings[0]?.current?.references.first?.value,
    "prepared-2",
  );
  assert.deepEqual(report.pluginDiagnostics, []);
  assert.deepEqual(report.pluginErrors, []);
});

void test("plugins collect concurrently after all preflights finish and single failures preserve other plugin facts", async () => {
  type FirstReference = Reference<
    "first-plugin",
    "first",
    { readonly path: string },
    string
  >;
  type SecondReference = Reference<
    "second-plugin",
    "second",
    { readonly path: string },
    string
  >;
  const prepared = new Set<string>();
  const started = new Set<string>();
  let signalBothStarted: () => void = () => {};
  const bothStarted = new Promise<void>((resolve) => {
    signalBothStarted = resolve;
  });
  const firstPlugin = definePlugin({
    id: "first-plugin",
    validate(_reference: FirstReference): void {},
    prepare(): { token: string } {
      prepared.add("first-plugin");
      return { token: "first" };
    },
    async collect(
      _request: PluginRequest<FirstReference, { token: string }>,
    ): Promise<PluginBatchResult<string>> {
      assert.deepEqual([...prepared].sort(), ["first-plugin", "second-plugin"]);
      started.add("first-plugin");
      if (started.size === 2) signalBothStarted();
      await bothStarted;
      throw new Error("first plugin failed");
    },
  });
  const secondPlugin = definePlugin({
    id: "second-plugin",
    validate(_reference: SecondReference): void {},
    prepare(): { token: string } {
      prepared.add("second-plugin");
      return { token: "second" };
    },
    async collect(
      request: PluginRequest<SecondReference, { token: string }>,
    ): Promise<PluginBatchResult<string>> {
      assert.deepEqual([...prepared].sort(), ["first-plugin", "second-plugin"]);
      started.add("second-plugin");
      if (started.size === 2) signalBothStarted();
      await bothStarted;
      return {
        results: request.selectedReferences.map((reference) => ({
          referenceId: reference.id,
          kind: "value",
          value: "second plugin survived",
        })),
      };
    },
  });
  const first = createReference<
    "first-plugin",
    "first",
    { readonly path: string },
    string
  >("first-plugin", "first", { path: "first" });
  const second = createReference<
    "second-plugin",
    "second",
    { readonly path: string },
    string
  >("second-plugin", "second", { path: "second" });
  const config = defineConfig({
    plugins: [firstPlugin, secondPlugin],
    bindings: [
      binding("first-policy", [first]),
      binding("second-policy", [second]),
    ],
  });

  const report = await check(config);
  const failed = report.bindings.find(
    ({ bindingId }) => bindingId === "first-policy",
  );
  const survived = report.bindings.find(
    ({ bindingId }) => bindingId === "second-policy",
  );
  assert.ok(failed && "errors" in failed);
  assert.equal(failed.errors[0]?.code, "plugin-failed");
  assert.equal(
    failed.errors[0]?.message,
    "Plugin first-plugin batch collection failed: first plugin failed",
  );
  assert.ok(survived && "current" in survived);
  assert.equal(
    survived.current.references.second?.value,
    "second plugin survived",
  );
});

void test("non-stringifiable thrown values still isolate failure and preserve other plugin facts", async () => {
  type UnknownErrorReference = Reference<
    "unknown-error-plugin",
    "unprintable",
    string,
    string
  >;
  type GoodReference = Reference<"good-plugin", "good", string, string>;
  const unknownErrorPlugin = definePlugin({
    id: "unknown-error-plugin",
    validate(_reference: UnknownErrorReference): void {},
    collect(
      _request: PluginRequest<UnknownErrorReference>,
    ): PluginBatchResult<string> {
      throw Object.create(null);
    },
  });
  const goodPlugin = definePlugin({
    id: "good-plugin",
    validate(_reference: GoodReference): void {},
    collect(request: PluginRequest<GoodReference>): PluginBatchResult<string> {
      return {
        results: request.selectedReferences.map(({ id }) => ({
          referenceId: id,
          kind: "value",
          value: "good fact",
        })),
      };
    },
  });
  const config = defineConfig({
    plugins: [unknownErrorPlugin, goodPlugin],
    bindings: [
      binding("unknown-error-policy", [
        createReference<"unknown-error-plugin", "unprintable", string, string>(
          "unknown-error-plugin",
          "unprintable",
          "target",
        ),
      ]),
      binding("good-policy", [
        createReference<"good-plugin", "good", string, string>(
          "good-plugin",
          "good",
          "target",
        ),
      ]),
    ],
  });

  const report = await check(config);
  const unknownFailure = report.bindings.find(
    ({ bindingId }) => bindingId === "unknown-error-policy",
  );
  const goodResult = report.bindings.find(
    ({ bindingId }) => bindingId === "good-policy",
  );
  assert.ok(unknownFailure && "errors" in unknownFailure);
  assert.equal(unknownFailure.errors[0]?.code, "plugin-failed");
  assert.equal(
    unknownFailure.errors[0]?.message,
    "Plugin unknown-error-plugin batch collection failed: Error value cannot be converted to string",
  );
  assert.ok(goodResult && "current" in goodResult);
  assert.equal(goodResult.current.references.good?.value, "good fact");
});

void test("missing, duplicate, invalid, and out-of-scope per-reference batch results are isolated by ownership", async () => {
  type FaultReference = Reference<
    "fault-plugin",
    string,
    { readonly path: string },
    string
  >;
  const plugin = definePlugin({
    id: "fault-plugin",
    validate(_reference: FaultReference): void {},
    collect(request: PluginRequest<FaultReference>): PluginBatchResult<string> {
      assert.deepEqual(request.selectedReferences.map(({ id }) => id).sort(), [
        "duplicate",
        "good",
        "invalid",
        "missing",
      ]);
      return {
        results: [
          { referenceId: "good", kind: "value", value: "usable" },
          { referenceId: "duplicate", kind: "value", value: "first" },
          { referenceId: "duplicate", kind: "value", value: "second" },
          {
            referenceId: "invalid",
            kind: "value",
            value: undefined as unknown as string,
          },
          { referenceId: "outside", kind: "value", value: "ignored" },
        ],
        diagnostics: {
          data: new Date() as unknown as PluginInformation["data"],
          text: [],
        },
      };
    },
  });
  const faultReference = (id: string): FaultReference =>
    createReference<"fault-plugin", string, { readonly path: string }, string>(
      "fault-plugin",
      id,
      { path: id },
    );
  const config = defineConfig({
    plugins: [plugin],
    bindings: ["good", "duplicate", "invalid", "missing"].map((id) =>
      binding(`${id}-policy`, [faultReference(id)]),
    ),
  });

  const report = await check(config);
  const resultFor = (id: string) =>
    report.bindings.find(({ bindingId }) => bindingId === `${id}-policy`);
  const good = resultFor("good");
  assert.ok(good && "current" in good);
  assert.equal(good.current.references.good?.value, "usable");
  const duplicate = resultFor("duplicate");
  assert.ok(duplicate && "errors" in duplicate);
  assert.equal(duplicate.errors[0]?.code, "duplicate-plugin-result");
  const invalid = resultFor("invalid");
  assert.ok(invalid && "errors" in invalid);
  assert.equal(invalid.errors[0]?.code, "invalid-plugin-result");
  const missing = resultFor("missing");
  assert.ok(missing && "errors" in missing);
  assert.equal(missing.errors[0]?.code, "missing-plugin-result");
  assert.deepEqual(report.pluginDiagnostics, []);
  assert.deepEqual(report.pluginErrors.map(({ code }) => code).sort(), [
    "invalid-plugin-diagnostics",
    "unexpected-plugin-result",
  ]);
});

void test("invalid diagnostics are reported separately without blocking baseline updates for valid facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-plugin-diagnostic-"));
  const plugin = definePlugin({
    id: "fixture-plugin",
    validate(_reference: FixtureReference): void {},
    collect(
      request: PluginRequest<FixtureReference>,
    ): PluginBatchResult<string> {
      return {
        results: request.selectedReferences.map((reference) => ({
          referenceId: reference.id,
          kind: "value",
          value: "accepted fact",
        })),
        diagnostics: {
          data: undefined as unknown as PluginInformation["data"],
          text: ["raw fact is valid"],
        },
      };
    },
  });
  const config = defineConfig({
    root,
    plugins: [plugin],
    bindings: [binding("policy", [fixtureReference("item")])],
  });

  try {
    const outcome = await updateBaseline(config);
    assert.equal(outcome.status, "updated");
    assert.equal(
      outcome.report.bindings[0]?.current?.references.item?.value,
      "accepted fact",
    );
    assert.deepEqual(outcome.report.pluginDiagnostics, []);
    assert.deepEqual(outcome.report.pluginErrors, [
      {
        pluginId: "fixture-plugin",
        code: "invalid-plugin-diagnostics",
        message:
          "Plugin fixture-plugin returned invalid diagnostics format: Value must be plain JSON data without cycles or special properties.",
      },
    ]);
    assert.match(
      await readFile(join(root, "dock.baseline.json"), "utf8"),
      /accepted fact/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("operations copy reference inputs and plugin prepared results before async preflight", async () => {
  const target = { path: "before" };
  const reference = createReference<
    "fixture-plugin",
    "snapshot",
    { path: string },
    string
  >("fixture-plugin", "snapshot", target);
  const preparedSource = { token: "before" };
  let signalPreparing: () => void = () => {};
  let releasePrepare: () => void = () => {};
  const preparing = new Promise<void>((resolve) => {
    signalPreparing = resolve;
  });
  const prepareGate = new Promise<void>((resolve) => {
    releasePrepare = resolve;
  });
  const plugin = definePlugin({
    id: "fixture-plugin",
    validate(_reference: FixtureReference): void {},
    async prepare(): Promise<{ token: string }> {
      signalPreparing();
      await prepareGate;
      return preparedSource;
    },
    collect(
      request: PluginRequest<FixtureReference, { token: string }>,
    ): PluginBatchResult<string> {
      preparedSource.token = "mutated after preparation";
      assert.equal(request.references[0]?.target.path, "before");
      assert.deepEqual(request.prepared, { token: "before" });
      return {
        results: request.selectedReferences.map(({ id }) => ({
          referenceId: id,
          kind: "value",
          value: request.prepared?.token ?? "missing",
        })),
      };
    },
  });
  const config = defineConfig({
    plugins: [plugin],
    bindings: [binding("snapshot-policy", [reference])],
  });

  const operation = check(config);
  await preparing;
  target.path = "after";
  releasePrepare();
  const report = await operation;
  assert.equal(
    report.bindings[0]?.current?.references.snapshot?.value,
    "before",
  );
});

void test("members containing both value and error preserve collection failure and reject baseline update", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-member-error-batch-"));
  const plugin = definePlugin({
    id: "fixture-plugin",
    validate(_reference: FixtureReference): void {},
    collect(
      request: PluginRequest<FixtureReference>,
    ): PluginBatchResult<string> {
      return {
        results: request.selectedReferences.map((reference) => ({
          referenceId: reference.id,
          kind: "collection",
          collection: {
            completeness: "complete",
            members: [
              {
                id: "member",
                value: 1,
                error: {
                  code: "member-failed",
                  message: "Member collection failed",
                },
              },
            ],
          },
        })) as unknown as PluginBatchResult<string>["results"],
      };
    },
  });
  const config = defineConfig({
    root,
    plugins: [plugin],
    bindings: [binding("member-policy", [fixtureReference("member-set")])],
  });

  try {
    const outcome = await updateBaseline(config);
    assert.equal(outcome.status, "rejected");
    assert.ok("errors" in (outcome.report.bindings[0] ?? {}));
    const bindingResult = outcome.report.bindings[0];
    assert.ok(bindingResult && "errors" in bindingResult);
    assert.equal(bindingResult.errors[0]?.code, "member-failed");
    await assert.rejects(readFile(join(root, "dock.baseline.json"), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("batch collection rejects getters with zero evaluations and isolates malformed diagnostics from valid facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-batch-getters-"));
  let getterCalls = 0;
  const nestedGetter = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "leaked";
    },
  });

  const plugin = definePlugin({
    id: "fixture-plugin",
    validate(_reference: FixtureReference): void {},
    collect(
      request: PluginRequest<FixtureReference>,
    ): PluginBatchResult<string> {
      const results: unknown[] = [];
      for (const reference of request.selectedReferences) {
        if (reference.id === "valid") {
          results.push({
            referenceId: "valid",
            kind: "value",
            value: { nested: ["ok"] },
          });
        } else if (reference.id === "getter-top") {
          results.push(
            Object.defineProperty(
              { referenceId: "getter-top", kind: "value" },
              "value",
              {
                enumerable: true,
                get() {
                  getterCalls += 1;
                  return "secret";
                },
              },
            ),
          );
        } else if (reference.id === "getter-nested") {
          results.push({
            referenceId: "getter-nested",
            kind: "value",
            value: { nested: [nestedGetter] },
          });
        } else if (reference.id === "getter-member") {
          results.push({
            referenceId: "getter-member",
            kind: "collection",
            collection: {
              completeness: "complete",
              members: [
                {
                  id: "m1",
                  value: { nested: nestedGetter },
                },
              ],
            },
          });
        } else if (reference.id === "ref-error") {
          results.push({
            referenceId: "ref-error",
            kind: "error",
            error: { code: "custom-error", message: "Reference failed" },
          });
        }
      }
      results.push({
        kind: "value",
        value: "no-id",
      });
      return {
        results: results as PluginBatchResult<string>["results"],
        diagnostics: {
          data: { bad: nestedGetter },
          text: ["should be isolated"],
        },
      };
    },
  });

  const config = defineConfig({
    root,
    plugins: [plugin],
    bindings: [
      binding("valid-policy", [fixtureReference("valid")]),
      binding("getter-top-policy", [fixtureReference("getter-top")]),
      binding("getter-nested-policy", [fixtureReference("getter-nested")]),
      binding("getter-member-policy", [fixtureReference("getter-member")]),
      binding("error-policy", [fixtureReference("ref-error")]),
    ],
  });

  try {
    const report = await check(config);
    const byBinding = (id: string) =>
      report.bindings.find(({ bindingId }) => bindingId === id);

    const valid = byBinding("valid-policy");
    assert.ok(valid && "current" in valid);
    assert.deepEqual(valid.current.references.valid?.value, {
      nested: ["ok"],
    });

    for (const badId of [
      "getter-top-policy",
      "getter-nested-policy",
      "getter-member-policy",
    ]) {
      const bad = byBinding(badId);
      assert.ok(bad && "errors" in bad);
      assert.equal(bad.errors[0]?.code, "invalid-plugin-result");
    }

    const refError = byBinding("error-policy");
    assert.ok(refError && "errors" in refError);
    assert.equal(refError.errors[0]?.code, "custom-error");

    assert.deepEqual(report.pluginDiagnostics, []);
    assert.deepEqual(report.pluginErrors.map(({ code }) => code).sort(), [
      "invalid-plugin-diagnostics",
      "unattributed-plugin-result",
    ]);

    const updated = await updateBaseline(config, { binding: ["valid-policy"] });
    assert.equal(updated.status, "updated");
    assert.deepEqual(
      updated.report.pluginErrors.map(({ code }) => code).sort(),
      ["invalid-plugin-diagnostics", "unattributed-plugin-result"],
    );
    assert.equal(getterCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
