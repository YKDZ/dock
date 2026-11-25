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

import { check, inspect, updateBaseline } from "@boringparts/dock";
import {
  check as checkCore,
  updateBaseline as updateBaselineCore,
} from "@boringparts/dock/core";

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
const sharedText = "Same fact\n";
const stableText = "Out-of-scope fact\n";
const retiredText = "Untracked fact\n";

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
        async prepare() {
          entered.resolve();
          await release.promise;
          return undefined;
        },
        collect(request) {
          return {
            results: request.selectedReferences.map((reference) => ({
              referenceId: reference.id,
              kind: "value",
              value: reference.target.path,
            })),
          };
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
import { binding, createReference, defineConfig, definePlugin, file } from "@boringparts/dock";

const tag = definePlugin({
  id: "fixture:inspect-tag",
  validate(reference) {
    if (typeof reference.target !== "string") throw new TypeError("Tag target must be a string.");
  },
  async collect(request, context) {
    await appendFile(join(context.root, "calls.txt"), "collect\\n");
    return {
      results: request.selectedReferences.map((reference) => ({
        referenceId: reference.id,
        kind: "value",
        value: reference.target,
      })),
    };
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
    "--output",
    "structured",
  ]);
  assert.equal(initialCli.status, 0, initialCli.stderr);
  const initialEnvelope = JSON.parse(initialCli.stdout);
  assert.equal(initialEnvelope.schemaVersion, "3");
  assert.equal(initialEnvelope.outputMode, "structured");
  assert.equal(initialEnvelope.variant, "inspected");
  assert.deepEqual(initialEnvelope.data.resolution, initial);
  const text = runCli(["inspect", "--config", "../dock.config.mjs"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /changing/);
  assert.match(text.stdout, /old\.txt/);

  assert.equal(initial.root, directory);
  assert.equal(initial.baselinePath, baselinePath);
  assert.deepEqual(
    new Set(initial.plugins.map(({ id }) => id)),
    new Set(["dock:file", "fixture:inspect-tag"]),
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
  const initialReport = {
    ...roundTrip(checkCore(initialInput)),
    pluginDiagnostics: [],
    pluginErrors: [],
  };
  assert.deepEqual(await check(configPath), initialReport);
  assert.deepEqual(
    roundTrip(await check(createConfig(directory))),
    initialReport,
  );
  const initialCheck = runCli([
    "check",
    "--config",
    "../dock.config.mjs",
    "--output",
    "structured",
  ]);
  assert.equal(initialCheck.status, 1, initialCheck.stderr);
  const initialCheckEnvelope = JSON.parse(initialCheck.stdout);
  assert.equal(initialCheckEnvelope.schemaVersion, "3");
  assert.equal(initialCheckEnvelope.outputMode, "structured");
  assert.deepEqual(initialCheckEnvelope.data.report, initialReport);
  const initialUpdateCore = roundTrip(updateBaselineCore(initialInput));
  const initialUpdate = {
    ...initialUpdateCore,
    report: {
      ...initialUpdateCore.report,
      pluginDiagnostics: [],
      pluginErrors: [],
    },
  };
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
    "--output",
    "structured",
  ]);
  assert.equal(selectedCli.status, 0, selectedCli.stderr);
  const selectedEnvelope = JSON.parse(selectedCli.stdout);
  assert.equal(selectedEnvelope.schemaVersion, "3");
  assert.equal(selectedEnvelope.outputMode, "structured");
  assert.deepEqual(selectedEnvelope.data.resolution, selected);
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
  const selectedReport = {
    ...roundTrip(checkCore(selectedInput)),
    pluginDiagnostics: [],
    pluginErrors: [],
  };
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
    "--output",
    "structured",
  ]);
  assert.equal(selectedCheck.status, 1, selectedCheck.stderr);
  const selectedCheckEnvelope = JSON.parse(selectedCheck.stdout);
  assert.equal(selectedCheckEnvelope.schemaVersion, "3");
  assert.equal(selectedCheckEnvelope.outputMode, "structured");
  assert.deepEqual(selectedCheckEnvelope.data.report, selectedReport);
  assert.deepEqual(await readFile(baselinePath), baselineBytes);

  const selectedUpdateCore = roundTrip(updateBaselineCore(selectedInput));
  const selectedUpdate = {
    ...selectedUpdateCore,
    report: {
      ...selectedUpdateCore.report,
      pluginDiagnostics: [],
      pluginErrors: [],
    },
  };
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
    "--output",
    "structured",
  ]);
  assert.equal(selectedCliUpdate.status, 0, selectedCliUpdate.stderr);
  const selectedUpdateEnvelope = JSON.parse(selectedCliUpdate.stdout);
  assert.equal(selectedUpdateEnvelope.schemaVersion, "3");
  assert.equal(selectedUpdateEnvelope.outputMode, "structured");
  assert.equal(selectedUpdateEnvelope.variant, "updated");
  assert.deepEqual(selectedUpdateEnvelope.data.report, selectedReport);
  assert.deepEqual(
    JSON.parse(await readFile(baselinePath, "utf8")),
    selectedUpdate.baseline,
  );

  const conflictPath = join(directory, "conflict.mjs");
  await writeFile(
    conflictPath,
    [
      'import { file } from "@boringparts/dock";',
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
        "--output",
        "structured",
      ]);
      assert.equal(failed.status, 1, failed.stderr);
      const envelope = JSON.parse(failed.stderr);
      assert.equal(envelope.schemaVersion, "3");
      assert.equal(envelope.outputMode, "structured");
      assert.equal(envelope.kind, "failure");
      assert.equal(envelope.data.code, failure.code);
    }
    assert.deepEqual(await readFile(baselinePath), unchangedBaseline);
    assert.deepEqual(await readFile(callsPath), unchangedCalls);
  }
  process.stdout.write(
    "Installed unified inspect, structured exports, and core model replay passed.\n",
  );
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
