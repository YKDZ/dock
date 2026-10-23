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
} from "@ykdz/dock";

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

void test("查看与检查共享批量契约并只在说明中公开明确选择的信息", async () => {
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
        text: ["目录已准备"],
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
        text: ["目录已准备"],
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

void test("所有插件预检完成后并发采集且单个失败保留其他插件事实", async () => {
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
  assert.ok(survived && "current" in survived);
  assert.equal(
    survived.current.references.second?.value,
    "second plugin survived",
  );
});

void test("逐引用缺失、重复、非法与越界批量结果按归属隔离", async () => {
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

void test("非法诊断单独报告，不阻止有效事实更新基线", async () => {
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
          "插件 fixture-plugin 的诊断格式无效：值必须是无循环、无特殊属性的普通 JSON 数据。",
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

void test("操作在异步预检前复制引用输入与插件准备结果", async () => {
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
