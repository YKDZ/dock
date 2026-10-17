import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import {
  check as checkCore,
  updateBaseline as updateBaselineCore,
} from "@dock/core";
import { check, inspect, updateBaseline } from "@dock/sdk";

const consumer = process.cwd();
const directory = await mkdtemp(join(consumer, "inspect-consumer-"));
const child = join(directory, "child");
const configPath = join(directory, "dock.config.mjs");
const declarationPath = join(directory, "declarations.mjs");
const baselinePath = join(directory, "state.json");
const callsPath = join(directory, "calls.txt");
const bin = join(
  consumer,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "dock.cmd" : "dock",
);
const sharedText = "同一事实\n";
const stableText = "范围外事实\n";
const retiredText = "取消跟踪的事实\n";

try {
  await mkdir(child);
  const target = { path: "a" };
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const stableConfig = {
    root: directory,
    baseline: "snapshot.json",
    plugins: [
      {
        id: "fixture:snapshot",
        validate() {},
        async validateReferences() {
          entered.resolve();
          await release.promise;
        },
        collect(reference) {
          return { kind: "value", value: reference.target.path };
        },
      },
    ],
    bindings: [
      {
        id: "snapshot",
        references: [
          { id: "snapshot-ref", pluginId: "fixture:snapshot", target },
        ],
      },
    ],
  };
  const pending = check(stableConfig);
  await entered.promise;
  target.path = "b";
  release.resolve();
  const snapshot = (await pending).bindings[0].current.references[
    "snapshot-ref"
  ];
  assert.equal(snapshot.definition.target.target.path, "a");
  assert.equal(snapshot.value, "a");
  const nextSnapshot = (await check(stableConfig)).bindings[0].current
    .references["snapshot-ref"];
  assert.equal(nextSnapshot.definition.target.target.path, "b");
  assert.equal(nextSnapshot.value, "b");
  await writeFile(
    declarationPath,
    `
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { file } from "@dock/reference-file";
import { binding, createReference, defineConfig, definePlugin } from "@dock/sdk";

const tag = definePlugin({
  id: "fixture:inspect-tag",
  validate(reference) {
    if (typeof reference.target !== "string") throw new TypeError("标签必须是文本。");
  },
  async collect(reference, context) {
    await appendFile(join(context.root, "calls.txt"), "collect\\n");
    return { kind: "value", value: reference.target };
  },
});

export function createConfig(root = ".", target = "old.txt", includeRetired = true) {
  return defineConfig({
    root,
    baseline: "state.json",
    declarationSources: [new URL("./declarations.mjs", import.meta.url), "config-source.mjs"],
    plugins: [file, tag],
    bindings: [
      binding("changing", [
        file.from(target).reference("shared", { declaredAt: new URL("./first.mjs", import.meta.url) }),
        createReference(tag.id, "tag", "known"),
      ], { declaredAt: new URL("./bindings.mjs", import.meta.url) }),
      binding("stable", [file.from("stable.txt").reference("stable")]),
      binding("shared-owner", [file.from(target).reference("shared", { declaredAt: "second.mjs" })]),
      ...(includeRetired ? [binding("retired", [file.from("retired.txt").reference("retired")])] : []),
    ],
  });
}
`,
  );
  await writeFile(
    configPath,
    'import { createConfig } from "./declarations.mjs";\nexport default createConfig();\n',
  );
  const { createConfig } = await import(pathToFileURL(declarationPath).href);

  const initial = await inspect(configPath);
  assert.deepEqual(initial, roundTrip(initial));
  assert.deepEqual(await inspect(pathToFileURL(configPath)), initial);
  assert.deepEqual(await inspect(relative(consumer, configPath)), initial);
  const { configPath: resolvedConfig, ...objectResolution } = initial;
  assert.equal(resolvedConfig, configPath);
  assert.deepEqual(await inspect(createConfig(directory)), objectResolution);
  const initialCli = runCli([
    "inspect",
    "--config",
    "../dock.config.mjs",
    "--json",
  ]);
  assert.equal(initialCli.status, 0, initialCli.stderr);
  const initialEnvelope = JSON.parse(initialCli.stdout);
  assert.equal(initialEnvelope.variant, "inspected");
  assert.deepEqual(initialEnvelope.data.resolution, initial);
  const text = runCli(["inspect", "--config", "../dock.config.mjs"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /changing/);
  assert.match(text.stdout, /old\.txt/);

  assert.equal(initial.root, directory);
  assert.equal(initial.baselinePath, baselinePath);
  assert.deepEqual(
    new Set(initial.plugins),
    new Set(["@dock/reference-file", "fixture:inspect-tag"]),
  );
  assert.equal(initial.context.declarationCompleteness, "complete");
  assert.deepEqual(initial.context.scope, [
    "changing",
    "retired",
    "shared-owner",
    "stable",
  ]);
  assert.equal(
    initial.context.references.filter((reference) => reference.id === "shared")
      .length,
    1,
  );
  assert.deepEqual(
    initial.files.toSorted((left, right) =>
      left.path.localeCompare(right.path),
    ),
    [
      { path: join(directory, "old.txt"), references: ["shared"] },
      { path: join(directory, "retired.txt"), references: ["retired"] },
      { path: join(directory, "stable.txt"), references: ["stable"] },
    ],
  );
  assert.deepEqual(initial.declarationSources.config, [
    pathToFileURL(declarationPath).href,
    "config-source.mjs",
  ]);
  assert.deepEqual(initial.declarationSources.bindings.changing, [
    pathToFileURL(join(directory, "bindings.mjs")).href,
  ]);
  assert.deepEqual(initial.declarationSources.references.shared, [
    pathToFileURL(join(directory, "first.mjs")).href,
    "second.mjs",
  ]);
  assert.equal(
    initial.context.references.find((reference) => reference.id === "shared")
      .target.fileInfo,
    "old.txt",
  );
  assert.equal(
    initial.context.references.find((reference) => reference.id === "tag")
      .target.fileInfo,
    null,
  );
  await assert.rejects(access(callsPath), { code: "ENOENT" });
  await assert.rejects(access(baselinePath), { code: "ENOENT" });

  await writeFile(join(directory, "old.txt"), sharedText);
  await writeFile(join(directory, "stable.txt"), stableText);
  await writeFile(join(directory, "retired.txt"), retiredText);
  const facts = [
    {
      referenceId: "shared",
      value: sharedText,
      range: { path: "old.txt", start: 0, end: sharedText.length },
    },
    { referenceId: "tag", value: "known" },
    {
      referenceId: "stable",
      value: stableText,
      range: { path: "stable.txt", start: 0, end: stableText.length },
    },
    {
      referenceId: "retired",
      value: retiredText,
      range: { path: "retired.txt", start: 0, end: retiredText.length },
    },
  ];
  const initialInput = { ...roundTrip(initial.context), facts };
  const initialReport = roundTrip(checkCore(initialInput));
  assert.deepEqual(await check(configPath), initialReport);
  assert.deepEqual(
    roundTrip(await check(createConfig(directory))),
    initialReport,
  );
  const initialCheck = runCli([
    "check",
    "--config",
    "../dock.config.mjs",
    "--json",
  ]);
  assert.equal(initialCheck.status, 1, initialCheck.stderr);
  assert.deepEqual(JSON.parse(initialCheck.stdout).data.report, initialReport);
  const initialUpdate = roundTrip(updateBaselineCore(initialInput));
  assert.equal(initialUpdate.status, "updated");
  assert.deepEqual(await updateBaseline(configPath), initialUpdate);
  const baselineBytes = await readFile(baselinePath);
  assert.deepEqual(
    JSON.parse(baselineBytes.toString("utf8")),
    initialUpdate.baseline,
  );

  await writeFile(
    configPath,
    'import { createConfig } from "./declarations.mjs";\nexport default createConfig(".", "new.txt", false);\n',
  );
  await writeFile(join(directory, "new.txt"), sharedText);
  await rm(join(directory, "stable.txt"));
  await rm(join(directory, "retired.txt"));
  const selectedScope = { file: ["old.txt", "retired.txt"] };
  const callsBeforeInspect = await readFile(callsPath);
  assert.deepEqual((await inspect(configPath)).context.scope, [
    "changing",
    "retired",
    "shared-owner",
    "stable",
  ]);
  const selected = await inspect(configPath, selectedScope);
  const equivalentScope = {
    binding: ["changing"],
    reference: ["shared"],
    file: ["retired.txt"],
  };
  assert.deepEqual(await inspect(configPath, equivalentScope), selected);
  assert.deepEqual(selected.context.scope, [
    "changing",
    "retired",
    "shared-owner",
  ]);
  assert.deepEqual(
    selected.context.bindings.map((binding) => binding.id).sort(),
    ["changing", "shared-owner", "stable"],
  );
  assert.deepEqual(selected.files, [
    { path: join(directory, "new.txt"), references: ["shared"] },
    { path: join(directory, "stable.txt"), references: ["stable"] },
  ]);
  const cliScope = [
    "--binding",
    "changing",
    "--reference",
    "shared",
    "--file",
    "retired.txt",
  ];
  const selectedCli = runCli([
    "inspect",
    "--config",
    "../dock.config.mjs",
    ...cliScope,
    "--json",
  ]);
  assert.equal(selectedCli.status, 0, selectedCli.stderr);
  assert.deepEqual(JSON.parse(selectedCli.stdout).data.resolution, selected);
  assert.deepEqual(await readFile(callsPath), callsBeforeInspect);
  assert.deepEqual(await readFile(baselinePath), baselineBytes);

  const selectedInput = {
    ...roundTrip(selected.context),
    facts: [
      {
        referenceId: "shared",
        value: sharedText,
        range: { path: "new.txt", start: 0, end: sharedText.length },
      },
      { referenceId: "tag", value: "known" },
    ],
  };
  const selectedReport = roundTrip(checkCore(selectedInput));
  assert.deepEqual(await check(configPath, selectedScope), selectedReport);
  assert.deepEqual(
    roundTrip(
      await check(createConfig(directory, "new.txt", false), equivalentScope),
    ),
    selectedReport,
  );
  assert.equal(
    selectedReport.bindings.find((binding) => binding.bindingId === "retired")
      .untracked,
    true,
  );
  assert.equal(
    selectedReport.bindings.find((binding) => binding.bindingId === "changing")
      .changes[0].kind,
    "reference-definition",
  );
  const selectedCheck = runCli([
    "check",
    "--config",
    "../dock.config.mjs",
    ...cliScope,
    "--json",
  ]);
  assert.equal(selectedCheck.status, 1, selectedCheck.stderr);
  assert.deepEqual(
    JSON.parse(selectedCheck.stdout).data.report,
    selectedReport,
  );
  assert.deepEqual(await readFile(baselinePath), baselineBytes);

  const selectedUpdate = roundTrip(updateBaselineCore(selectedInput));
  assert.equal(selectedUpdate.status, "updated");
  assert.deepEqual(
    await updateBaseline(configPath, equivalentScope),
    selectedUpdate,
  );
  assert.deepEqual(
    selectedUpdate.baseline.bindings.stable,
    initialUpdate.baseline.bindings.stable,
  );
  assert.equal(
    Object.hasOwn(selectedUpdate.baseline.bindings, "retired"),
    false,
  );
  assert.deepEqual(
    JSON.parse(await readFile(baselinePath, "utf8")),
    selectedUpdate.baseline,
  );
  await writeFile(baselinePath, baselineBytes);
  const selectedCliUpdate = runCli([
    "baseline",
    "update",
    "--config",
    "../dock.config.mjs",
    ...cliScope,
    "--json",
  ]);
  assert.equal(selectedCliUpdate.status, 0, selectedCliUpdate.stderr);
  assert.equal(JSON.parse(selectedCliUpdate.stdout).variant, "updated");
  assert.deepEqual(
    JSON.parse(selectedCliUpdate.stdout).data.report,
    selectedReport,
  );
  assert.deepEqual(
    JSON.parse(await readFile(baselinePath, "utf8")),
    selectedUpdate.baseline,
  );

  const conflictPath = join(directory, "conflict.mjs");
  await writeFile(
    conflictPath,
    [
      'import { file } from "@dock/reference-file";',
      "export default { plugins: [file], bindings: [",
      '{ id: "first", references: [file.from("first.txt").reference("same")] },',
      '{ id: "second", references: [file.from("second.txt").reference("same")] },',
      "] };",
    ].join("\n"),
  );
  for (const failure of [
    {
      config: configPath,
      scope: { binding: ["absent"] },
      args: ["--binding", "absent"],
      code: "scope-selector-unmatched",
    },
    {
      config: conflictPath,
      scope: undefined,
      args: [],
      code: "maintenance-failed",
    },
    {
      config: configPath,
      scope: undefined,
      args: [],
      code: "baseline-invalid",
    },
  ]) {
    if (failure.code === "baseline-invalid")
      await writeFile(baselinePath, "{ invalid");
    const unchangedBaseline = await readFile(baselinePath);
    const unchangedCalls = await readFile(callsPath);
    for (const [operation, command] of [
      [inspect, ["inspect"]],
      [check, ["check"]],
      [updateBaseline, ["baseline", "update"]],
    ]) {
      await assert.rejects(operation(failure.config, failure.scope), {
        code: failure.code,
      });
      const failed = runCli([
        ...command,
        "--config",
        failure.config,
        ...failure.args,
        "--json",
      ]);
      assert.equal(failed.status, 1, failed.stderr);
      const envelope = JSON.parse(failed.stderr);
      assert.equal(envelope.kind, "failure");
      assert.equal(envelope.data.code, failure.code);
    }
    assert.deepEqual(await readFile(baselinePath), unchangedBaseline);
    assert.deepEqual(await readFile(callsPath), unchangedCalls);
  }
  process.stdout.write("安装制品统一解析、结构化导出与核心模型重放通过。\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}

function roundTrip(value) {
  return JSON.parse(JSON.stringify(value));
}

function runCli(args) {
  const result = spawnSync(bin, args, {
    cwd: child,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
