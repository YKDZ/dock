import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check, inspect, updateBaseline } from "@dock/sdk";

const directory = await mkdtemp(join(tmpdir(), "dock-execution-consumer-"));
try {
  const executions = [];
  const plugin = {
    id: "fixture:execution",
    validate() {},
    execution: {
      declare(references) {
        return references.map((reference) => ({
          identity: reference.target.run,
          configuration: { command: { value: reference.target.value } },
          references: [reference.id],
        }));
      },
      execute({ declaration, selectedReferences }) {
        executions.push({
          identity: declaration.identity,
          references: selectedReferences.map((ref) => ref.id),
        });
        return {
          lifecycle: "complete",
          commandAttempts: 1,
          testExecutions: 0,
          tests: [],
          errors: [],
        };
      },
    },
    collect(reference, context) {
      const run = context.execution.get(reference.target.run);
      assert.equal(context.execution.get("unknown"), undefined);
      assert.equal(run.record.lifecycle, "complete");
      return {
        kind: "value",
        value: run.declaration.configuration.command.value,
      };
    },
  };
  const config = {
    root: directory,
    plugins: [plugin],
    bindings: [
      {
        id: "first",
        references: [
          {
            id: "first-ref",
            pluginId: plugin.id,
            target: { run: "shared", value: 1 },
          },
        ],
      },
      {
        id: "second",
        references: [
          {
            id: "second-ref",
            pluginId: plugin.id,
            target: { run: "shared", value: 1 },
          },
        ],
      },
      {
        id: "other",
        references: [
          {
            id: "other-ref",
            pluginId: plugin.id,
            target: { run: "other", value: 2 },
          },
        ],
      },
    ],
  };
  const resolution = await inspect(config, { binding: ["first"] });
  assert.deepEqual(resolution.runs, [
    {
      pluginId: plugin.id,
      identity: "shared",
      configuration: { command: { value: 1 } },
      references: ["first-ref", "second-ref"],
      selectedReferences: ["first-ref"],
    },
    {
      pluginId: plugin.id,
      identity: "other",
      configuration: { command: { value: 2 } },
      references: ["other-ref"],
      selectedReferences: [],
    },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(resolution)), resolution);
  assert.deepEqual(executions, []);
  const report = await check(config, { binding: ["first"] });
  assert.deepEqual(executions, [
    { identity: "shared", references: ["first-ref"] },
  ]);
  assert.equal(report.bindings[0].current.references["first-ref"].value, 1);
  assert.equal(report.execution.commandAttempts, 1);
  executions.length = 0;
  await check(config);
  assert.deepEqual(executions, [
    { identity: "shared", references: ["first-ref", "second-ref"] },
    { identity: "other", references: ["other-ref"] },
  ]);

  executions.length = 0;
  const otherPlugin = {
    ...plugin,
    id: "fixture:other-execution",
    execution: {
      ...plugin.execution,
      declare(references) {
        return [
          {
            identity: "shared",
            configuration: { command: { value: 1 } },
            references: references.map((ref) => ref.id),
          },
        ];
      },
    },
  };
  const crossPlugin = {
    ...config,
    plugins: [plugin, otherPlugin],
    bindings: [
      config.bindings[0],
      {
        id: "cross-plugin",
        references: [
          {
            id: "cross-plugin-ref",
            pluginId: otherPlugin.id,
            target: { run: "shared", value: 1 },
          },
        ],
      },
    ],
  };
  const conflicting = {
    ...config,
    bindings: [
      config.bindings[0],
      {
        ...config.bindings[1],
        references: [
          {
            ...config.bindings[1].references[0],
            target: { run: "shared", value: 2 },
          },
        ],
      },
    ],
  };
  for (const operation of [inspect, check, updateBaseline]) {
    await assert.rejects(operation(crossPlugin, { binding: ["first"] }), {
      code: "execution-identity-conflict",
    });
    await assert.rejects(operation(conflicting, { binding: ["first"] }), {
      code: "plugin-reference-validation-failed",
    });
  }
  assert.deepEqual(executions, []);

  for (const references of [["unknown-ref"], ["cross-plugin-ref"], []]) {
    const invalid = {
      ...crossPlugin,
      plugins: [
        {
          ...plugin,
          execution: {
            ...plugin.execution,
            declare() {
              return [{ identity: "invalid", configuration: {}, references }];
            },
          },
        },
        otherPlugin,
      ],
    };
    await assert.rejects(inspect(invalid), {
      code: "plugin-reference-validation-failed",
    });
  }

  let evaluated = false;
  const invalidValue = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      evaluated = true;
      return 1;
    },
  });
  const invalidConfiguration = {
    ...config,
    plugins: [
      {
        ...plugin,
        execution: {
          ...plugin.execution,
          declare(references) {
            return [
              {
                identity: "invalid",
                configuration: invalidValue,
                references: references.map((ref) => ref.id),
              },
            ];
          },
        },
      },
    ],
  };
  for (const operation of [inspect, check, updateBaseline]) {
    await assert.rejects(operation(invalidConfiguration), {
      code: "plugin-reference-validation-failed",
    });
  }
  const invalidFact = await check(
    {
      ...config,
      plugins: [
        {
          ...plugin,
          collect() {
            return { kind: "value", value: invalidValue };
          },
        },
      ],
    },
    { binding: ["first"] },
  );
  assert.equal(invalidFact.bindings[0].errors[0].code, "invalid-plugin-result");
  assert.equal(evaluated, false);

  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const configuration = { command: { value: 1 } };
  const observer = {
    id: "fixture:observer",
    validate() {},
    async validateReferences() {
      entered.resolve();
      await release.promise;
    },
    collect(_reference, context) {
      assert.equal(context.execution.get("shared"), undefined);
      return { kind: "value", value: true };
    },
  };
  const snapshotConfig = {
    ...config,
    plugins: [
      {
        ...plugin,
        execution: {
          ...plugin.execution,
          declare(references) {
            return [
              {
                identity: "shared",
                configuration,
                references: references.map((ref) => ref.id),
              },
            ];
          },
        },
      },
      observer,
    ],
    bindings: [
      config.bindings[0],
      {
        id: "observer",
        references: [
          { id: "observer-ref", pluginId: observer.id, target: true },
        ],
      },
    ],
  };
  const pending = check(snapshotConfig);
  await entered.promise;
  configuration.command.value = 9;
  release.resolve();
  const snapshot = await pending;
  assert.equal(
    snapshot.bindings.find((binding) => binding.bindingId === "first").current
      .references["first-ref"].value,
    1,
  );
  assert.equal(
    snapshot.bindings.find((binding) => binding.bindingId === "observer")
      .current.references["observer-ref"].value,
    true,
  );

  const failed = await check(
    {
      ...config,
      plugins: [
        {
          ...plugin,
          execution: {
            ...plugin.execution,
            execute() {
              throw new Error("运行中断");
            },
          },
          collect(reference, context) {
            const run = context.execution.get(reference.target.run);
            assert.equal(run.record.lifecycle, "incomplete");
            return { kind: "error", error: run.record.errors[0] };
          },
        },
      ],
    },
    { binding: ["first"] },
  );
  assert.equal(failed.bindings[0].errors[0].code, "execution-failed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
