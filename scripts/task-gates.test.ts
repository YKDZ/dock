import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { inspectTaskGate, type TaskGate } from "./task-gates.ts";

type FixtureTask = {
  readonly name: string;
  readonly fullName: string;
  readonly tags: readonly string[];
  readonly script?: string;
  readonly command?: string;
  readonly dependsOn?: readonly string[];
};

type FixturePackage = {
  readonly name: string;
  readonly tasks: readonly FixtureTask[];
};

const entryCommand = "node --conditions=source scripts/task-gates.ts";
const tempDirectories: string[] = [];

const fakeTurboScript = `
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();
const fixture = JSON.parse(readFileSync(join(cwd, "fixture.json"), "utf8"));
const subcommand = process.argv[2];

if (subcommand === "query") {
  const packages = fixture.packages.map((pkg) => ({
    name: pkg.name,
    tasks: {
      items: pkg.tasks.map((task) => ({
        name: task.name,
        fullName: task.fullName,
        tags: task.tags,
        script: task.script ?? null,
        command: task.command ?? null,
      })),
    },
  }));
  process.stdout.write(JSON.stringify({ data: { packages: { items: packages } } }));
  process.exit(0);
}

if (subcommand === "run") {
  const args = process.argv.slice(3);
  const roots = args.filter((arg) => !arg.startsWith("--"));
  const depsByTask = new Map();
  for (const pkg of fixture.packages) {
    for (const task of pkg.tasks) {
      depsByTask.set(task.fullName, task.dependsOn ?? []);
    }
  }
  const visited = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    for (const dep of depsByTask.get(current) ?? []) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }
  const tasks = [...visited].map((taskId) => ({ taskId }));
  process.stdout.write(JSON.stringify({ tasks }));
  process.exit(0);
}

process.stderr.write("Unexpected fake turbo command: " + subcommand + "\\n");
process.exit(1);
`;

function defaultPublicGates(): readonly FixtureTask[] {
  return [
    {
      name: "check",
      fullName: "//#check",
      tags: ["quality:entry"],
      script: `${entryCommand} check`,
      command: `${entryCommand} check`,
    },
    {
      name: "check:heavy",
      fullName: "//#check:heavy",
      tags: ["quality:entry"],
      script: `${entryCommand} check:heavy`,
      command: `${entryCommand} check:heavy`,
    },
    {
      name: "check:full",
      fullName: "//#check:full",
      tags: ["quality:entry"],
      script: `${entryCommand} check:full`,
      command: `${entryCommand} check:full`,
    },
    {
      name: "fix",
      fullName: "//#fix",
      tags: ["work:repair"],
      script: `${entryCommand} fix`,
      command: `${entryCommand} fix`,
    },
  ];
}

async function createWorkspaceFixture(
  packages: readonly FixturePackage[],
): Promise<{
  readonly cwd: string;
  readonly turboCommand: readonly [string, ...string[]];
}> {
  const cwd = await mkdtemp(join(tmpdir(), "dock-task-gates-test-"));
  tempDirectories.push(cwd);
  const runnerPath = join(cwd, "fake-turbo.mjs");
  await writeFile(runnerPath, fakeTurboScript);
  await writeFile(join(cwd, "fixture.json"), JSON.stringify({ packages }));
  return { cwd, turboCommand: [process.execPath, runnerPath] };
}

after(async () => {
  await Promise.all(
    tempDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

void describe("inspectTaskGate", () => {
  void test("accepts a valid layered workspace task graph across all public gates", async () => {
    const { cwd, turboCommand } = await createWorkspaceFixture([
      {
        name: "//",
        tasks: [
          ...defaultPublicGates(),
          {
            name: "lint",
            fullName: "//#lint",
            tags: ["quality:light"],
            script: "oxlint",
            command: "oxlint",
          },
          {
            name: "check:install",
            fullName: "//#check:install",
            tags: ["quality:heavy"],
            script: "node scripts/check-installed.ts",
            command: "node scripts/check-installed.ts",
            dependsOn: ["@ykdz/dock#pack"],
          },
          {
            name: "format:write",
            fullName: "//#format:write",
            tags: ["work:repair"],
            script: "oxfmt --write",
            command: "oxfmt --write",
          },
        ],
      },
      {
        name: "@ykdz/dock",
        tasks: [
          {
            name: "build",
            fullName: "@ykdz/dock#build",
            tags: ["quality:light"],
            script: "tsc -p tsconfig.build.json",
            command: "tsc -p tsconfig.build.json",
          },
          {
            name: "pack",
            fullName: "@ykdz/dock#pack",
            tags: ["work:preparation"],
            script: "pnpm pack",
            command: "pnpm pack",
            dependsOn: ["@ykdz/dock#build"],
          },
          {
            name: "test:manual",
            fullName: "@ykdz/dock#test:manual",
            tags: ["quality:conditional"],
            script: "node test/manual.test.ts",
            command: "node test/manual.test.ts",
          },
        ],
      },
    ]);

    const checkResult = inspectTaskGate(
      "check",
      cwd,
      entryCommand,
      turboCommand,
    );
    assert.deepEqual(checkResult.diagnostics, []);
    assert.equal(checkResult.plans.length, 1);
    assert.deepEqual(
      checkResult.plans[0]?.tasks.map((task) => task.fullName),
      ["//#lint", "@ykdz/dock#build"],
    );
    assert.deepEqual(
      checkResult.conditionalTasks.map((task) => task.fullName),
      ["@ykdz/dock#test:manual"],
    );

    const heavyResult = inspectTaskGate(
      "check:heavy",
      cwd,
      entryCommand,
      turboCommand,
    );
    assert.deepEqual(heavyResult.diagnostics, []);
    assert.deepEqual(
      heavyResult.plans[0]?.tasks.map((task) => task.fullName),
      ["//#check:install"],
    );

    const fullResult = inspectTaskGate(
      "check:full",
      cwd,
      entryCommand,
      turboCommand,
    );
    assert.deepEqual(fullResult.diagnostics, []);
    assert.equal(fullResult.plans.length, 2);

    const fixResult = inspectTaskGate("fix", cwd, entryCommand, turboCommand);
    assert.deepEqual(fixResult.diagnostics, []);
    assert.deepEqual(
      fixResult.plans[0]?.tasks.map((task) => task.fullName),
      ["//#format:write"],
    );
  });

  void test("fails when an executable task is missing a role tag", async () => {
    const { cwd, turboCommand } = await createWorkspaceFixture([
      {
        name: "//",
        tasks: [
          ...defaultPublicGates(),
          {
            name: "lint",
            fullName: "//#lint",
            tags: ["quality:light"],
            script: "oxlint",
            command: "oxlint",
          },
        ],
      },
      {
        name: "@ykdz/dock",
        tasks: [
          {
            name: "build",
            fullName: "@ykdz/dock#build",
            tags: [],
            script: "tsc -p tsconfig.build.json",
            command: "tsc -p tsconfig.build.json",
          },
        ],
      },
    ]);

    const result = inspectTaskGate("check", cwd, entryCommand, turboCommand);
    assert.ok(
      result.diagnostics.some((line) =>
        line.includes("@ykdz/dock#build is missing a unique role tag"),
      ),
    );
  });

  void test("fails when a task uses an unknown role tag", async () => {
    const { cwd, turboCommand } = await createWorkspaceFixture([
      {
        name: "//",
        tasks: [
          ...defaultPublicGates(),
          {
            name: "lint",
            fullName: "//#lint",
            tags: ["quality:light"],
            script: "oxlint",
            command: "oxlint",
          },
        ],
      },
      {
        name: "@ykdz/dock",
        tasks: [
          {
            name: "build",
            fullName: "@ykdz/dock#build",
            tags: ["quality:unknown"],
            script: "tsc -p tsconfig.build.json",
            command: "tsc -p tsconfig.build.json",
          },
        ],
      },
    ]);

    const result = inspectTaskGate("check", cwd, entryCommand, turboCommand);
    assert.ok(
      result.diagnostics.some((line) =>
        line.includes("@ykdz/dock#build uses unknown role tag quality:unknown"),
      ),
    );
  });

  void test("fails when a task declares multiple conflicting role tags", async () => {
    const { cwd, turboCommand } = await createWorkspaceFixture([
      {
        name: "//",
        tasks: [
          ...defaultPublicGates(),
          {
            name: "lint",
            fullName: "//#lint",
            tags: ["quality:light"],
            script: "oxlint",
            command: "oxlint",
          },
        ],
      },
      {
        name: "@ykdz/dock",
        tasks: [
          {
            name: "build",
            fullName: "@ykdz/dock#build",
            tags: ["quality:light", "work:preparation"],
            script: "tsc -p tsconfig.build.json",
            command: "tsc -p tsconfig.build.json",
          },
        ],
      },
    ]);

    const result = inspectTaskGate("check", cwd, entryCommand, turboCommand);
    assert.ok(
      result.diagnostics.some((line) =>
        line.includes("@ykdz/dock#build has multiple role tags"),
      ),
    );
  });

  void test("fails when public gates are miswired or missing or have wrong roles", async () => {
    const gateCases: readonly {
      readonly gate: TaskGate;
      readonly mutate: (tasks: FixtureTask[]) => void;
      readonly expectedSnippet: string;
    }[] = [
      {
        gate: "check",
        mutate: (tasks) => {
          const idx = tasks.findIndex((t) => t.name === "check");
          tasks[idx] = {
            ...tasks[idx]!,
            script: "turbo run check",
            command: "turbo run check",
          };
        },
        expectedSnippet: "//#check public gate entry is miswired",
      },
      {
        gate: "check:heavy",
        mutate: (tasks) => {
          const idx = tasks.findIndex((t) => t.name === "check:heavy");
          tasks[idx] = {
            ...tasks[idx]!,
            command: "node scripts/other.ts check:heavy",
          };
        },
        expectedSnippet: "//#check:heavy public gate entry is miswired",
      },
      {
        gate: "check:full",
        mutate: (tasks) => {
          const idx = tasks.findIndex((t) => t.name === "check:full");
          tasks[idx] = {
            ...tasks[idx]!,
            tags: ["quality:heavy"],
          };
        },
        expectedSnippet:
          "//#check:full is a public gate entry and must declare role quality:entry",
      },
      {
        gate: "fix",
        mutate: (tasks) => {
          const idx = tasks.findIndex((t) => t.name === "fix");
          tasks[idx] = {
            ...tasks[idx]!,
            tags: ["quality:entry"],
          };
        },
        expectedSnippet:
          "//#fix is a public gate entry and must declare role work:repair",
      },
      {
        gate: "check",
        mutate: (tasks) => {
          const idx = tasks.findIndex((t) => t.name === "check:heavy");
          tasks.splice(idx, 1);
        },
        expectedSnippet: "Missing root public gate entry check:heavy",
      },
    ];

    for (const testCase of gateCases) {
      const rootTasks: FixtureTask[] = [
        ...defaultPublicGates(),
        {
          name: "lint",
          fullName: "//#lint",
          tags: ["quality:light"],
          script: "oxlint",
          command: "oxlint",
        },
      ];
      testCase.mutate(rootTasks);
      const { cwd, turboCommand } = await createWorkspaceFixture([
        { name: "//", tasks: rootTasks },
      ]);

      const result = inspectTaskGate(
        testCase.gate,
        cwd,
        entryCommand,
        turboCommand,
      );
      assert.ok(
        result.diagnostics.some((line) =>
          line.includes(testCase.expectedSnippet),
        ),
        `Expected diagnostic containing "${testCase.expectedSnippet}", got: ${result.diagnostics.join(" | ")}`,
      );
    }
  });

  void test("fails when a non-public task uses quality:entry or a verification task uses a non-quality role", async () => {
    const { cwd, turboCommand } = await createWorkspaceFixture([
      {
        name: "//",
        tasks: [
          ...defaultPublicGates(),
          {
            name: "lint",
            fullName: "//#lint",
            tags: ["work:repair"],
            script: "oxlint",
            command: "oxlint",
          },
          {
            name: "custom",
            fullName: "//#custom",
            tags: ["quality:entry"],
            script: "echo custom",
            command: "echo custom",
          },
        ],
      },
    ]);

    const result = inspectTaskGate("check", cwd, entryCommand, turboCommand);
    assert.ok(
      result.diagnostics.some((line) =>
        line.includes("//#lint is a reserved verification task"),
      ),
    );
    assert.ok(
      result.diagnostics.some((line) =>
        line.includes("//#custom cannot use quality:entry"),
      ),
    );
  });

  void test("fails when a commandless aggregate node declares a role tag without reaching executable work", async () => {
    const { cwd, turboCommand } = await createWorkspaceFixture([
      {
        name: "//",
        tasks: [
          ...defaultPublicGates(),
          {
            name: "lint",
            fullName: "//#lint",
            tags: ["quality:light"],
            script: "oxlint",
            command: "oxlint",
          },
          {
            name: "empty-aggregate",
            fullName: "//#empty-aggregate",
            tags: ["quality:light"],
            dependsOn: ["@ykdz/dock#empty-leaf"],
          },
        ],
      },
      {
        name: "@ykdz/dock",
        tasks: [
          {
            name: "empty-leaf",
            fullName: "@ykdz/dock#empty-leaf",
            tags: [],
          },
        ],
      },
    ]);

    const result = inspectTaskGate("check", cwd, entryCommand, turboCommand);
    assert.ok(
      result.diagnostics.some((line) =>
        line.includes(
          "//#empty-aggregate declares dangling role tag quality:light",
        ),
      ),
    );
  });

  void test("fails when quality:light transitively reaches quality:heavy", async () => {
    const { cwd, turboCommand } = await createWorkspaceFixture([
      {
        name: "//",
        tasks: [
          ...defaultPublicGates(),
          {
            name: "lint",
            fullName: "//#lint",
            tags: ["quality:light"],
            script: "oxlint",
            command: "oxlint",
            dependsOn: ["//#check:install"],
          },
          {
            name: "check:install",
            fullName: "//#check:install",
            tags: ["quality:heavy"],
            script: "node scripts/check-installed.ts",
            command: "node scripts/check-installed.ts",
          },
        ],
      },
    ]);

    const result = inspectTaskGate("check", cwd, entryCommand, turboCommand);
    assert.ok(
      result.diagnostics.some((line) =>
        line.includes(
          "Light check execution graph includes //#check:install: light check cannot transitively trigger heavy verification",
        ),
      ),
    );
  });

  void test("fails when a leaf task depends on a public gate, reaches quality:conditional, or selects no light tasks", async () => {
    const { cwd, turboCommand } = await createWorkspaceFixture([
      {
        name: "//",
        tasks: [
          ...defaultPublicGates(),
          {
            name: "check:heavy-leaf",
            fullName: "//#check:heavy-leaf",
            tags: ["quality:heavy"],
            script: "node heavy.js",
            command: "node heavy.js",
            dependsOn: ["//#check", "//#cond"],
          },
          {
            name: "cond",
            fullName: "//#cond",
            tags: ["quality:conditional"],
            script: "node cond.js",
            command: "node cond.js",
          },
        ],
      },
    ]);

    const checkResult = inspectTaskGate(
      "check",
      cwd,
      entryCommand,
      turboCommand,
    );
    assert.ok(
      checkResult.diagnostics.some((line) =>
        line.includes("Light check selected no executable tasks"),
      ),
    );

    const heavyResult = inspectTaskGate(
      "check:heavy",
      cwd,
      entryCommand,
      turboCommand,
    );
    assert.ok(
      heavyResult.diagnostics.some((line) =>
        line.includes(
          "leaf tasks cannot depend on public aggregate gate entries",
        ),
      ),
    );
    assert.ok(
      heavyResult.diagnostics.some((line) =>
        line.includes(
          "standard verification cannot transitively trigger conditional verification",
        ),
      ),
    );

    const unknownResult = inspectTaskGate(
      "unknown" as TaskGate,
      cwd,
      entryCommand,
      turboCommand,
    );
    assert.ok(
      unknownResult.diagnostics.some((line) =>
        line.includes("Unknown public gate entry"),
      ),
    );
  });
});
