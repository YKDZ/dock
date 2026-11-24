import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type TaskGate = "check" | "check:heavy" | "check:full" | "fix";

type ScriptRole =
  | "quality:light"
  | "quality:heavy"
  | "quality:conditional"
  | "quality:entry"
  | "work:development"
  | "work:repair"
  | "work:release"
  | "work:preparation"
  | "work:lifecycle"
  | "work:on-demand";

type TurboTask = {
  readonly name: string;
  readonly fullName: string;
  readonly packageName: string;
  readonly tags: readonly string[];
  readonly executable: boolean;
  readonly role?: ScriptRole;
};

type GateLayer = {
  readonly role: "quality:light" | "quality:heavy" | "work:repair";
  readonly label: string;
};

type CommandResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | undefined;
};

const turboTaskQuery =
  "{ packages { items { name tasks { items { name fullName tags script command } } } } }";

const validRoles = new Set<ScriptRole>([
  "quality:light",
  "quality:heavy",
  "quality:conditional",
  "quality:entry",
  "work:development",
  "work:repair",
  "work:release",
  "work:preparation",
  "work:lifecycle",
  "work:on-demand",
]);

const publicGateNames = new Set<TaskGate>([
  "check",
  "check:heavy",
  "check:full",
  "fix",
]);

const defaultEntryCommand = "node --conditions=source scripts/task-gates.ts";
const maxTurboOutputBytes = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function report(message: string): void {
  process.stderr.write(`${message}\n`);
}

type TurboCommand = readonly [string, ...string[]];

function runCaptured(
  cwd: string,
  args: readonly string[],
  command: TurboCommand = ["pnpm", "exec", "turbo"],
): CommandResult {
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: maxTurboOutputBytes,
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function runVisible(cwd: string, args: readonly string[]): Promise<number> {
  return new Promise((resolveStatus) => {
    const command =
      process.platform === "win32"
        ? "pnpm"
        : resolve(cwd, "node_modules/.bin/turbo");
    const commandArgs =
      process.platform === "win32" ? ["exec", "turbo", ...args] : args;
    const child = spawn(command, commandArgs, {
      cwd,
      detached: process.platform !== "win32",
      stdio: "inherit",
    });
    let interruptedBy: NodeJS.Signals | undefined;
    const forward = (signal: NodeJS.Signals): void => {
      if (child.exitCode === null && child.signalCode === null) {
        interruptedBy = signal;
        const turboSignal = signal === "SIGTERM" ? "SIGINT" : signal;
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, turboSignal);
          } catch {
            child.kill(turboSignal);
          }
        } else {
          child.kill(turboSignal);
        }
      }
    };
    const forwardInterrupt = (): void => forward("SIGINT");
    const forwardTerminate = (): void => forward("SIGTERM");
    const removeSignalHandlers = (): void => {
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTerminate);
    };

    process.on("SIGINT", forwardInterrupt);
    process.on("SIGTERM", forwardTerminate);
    child.once("error", (error) => {
      removeSignalHandlers();
      report(`Failed to start Turbo for ${args.join(" ")}: ${error.message}`);
      resolveStatus(1);
    });
    child.once("close", (code, signal) => {
      removeSignalHandlers();
      if (interruptedBy !== undefined) {
        resolveStatus(interruptedBy === "SIGINT" ? 130 : 143);
      } else if (code !== null) {
        resolveStatus(code);
      } else {
        resolveStatus(
          signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1,
        );
      }
    });
  });
}

function commandFailure(label: string, result: CommandResult): string {
  const details = result.stderr.trim();
  if (result.error !== undefined) {
    return `Failed to run Turbo ${label}: ${result.error.message}`;
  }
  return `Turbo ${label} failed (exit code ${String(result.status)})${details === "" ? "" : `:\n${details}`}`;
}

function roleTags(tags: readonly string[]): readonly string[] {
  return tags.filter(
    (tag) => tag.startsWith("quality:") || tag.startsWith("work:"),
  );
}

function publicGateTask(task: {
  readonly name: string;
  readonly packageName: string;
}): boolean {
  return (
    task.packageName === "//" && publicGateNames.has(task.name as TaskGate)
  );
}

function protectedVerificationTask(task: TurboTask): boolean {
  return (
    task.name === "check" ||
    task.name.startsWith("check:") ||
    task.name === "test" ||
    task.name.startsWith("test:") ||
    task.name === "lint" ||
    task.name === "typecheck" ||
    task.name === "format:check"
  );
}

function assignRole(
  task: Omit<TurboTask, "role">,
  diagnostics: string[],
): ScriptRole | undefined {
  const roles = roleTags(task.tags);
  const isPublicGate = publicGateTask(task);
  if (roles.length === 0) {
    diagnostics.push(
      `${task.fullName} is missing a unique role tag; declare a quality scope or work purpose in its Turbo task tags`,
    );
    return undefined;
  }
  if (roles.length > 1) {
    diagnostics.push(
      `${task.fullName} has multiple role tags: ${roles.join(", ")}; each executable task may declare only one role`,
    );
    return undefined;
  }

  const role = roles[0]!;
  if (!validRoles.has(role as ScriptRole)) {
    diagnostics.push(`${task.fullName} uses unknown role tag ${role}`);
    return undefined;
  }
  const scriptRole = role as ScriptRole;
  const publicRole = task.name === "fix" ? "work:repair" : "quality:entry";
  if (isPublicGate && scriptRole !== publicRole) {
    diagnostics.push(
      `${task.fullName} is a public gate entry and must declare role ${publicRole}, got ${scriptRole}`,
    );
    return undefined;
  }
  if (!isPublicGate && scriptRole === "quality:entry") {
    diagnostics.push(
      `${task.fullName} cannot use quality:entry; that role is reserved for root check, check:heavy, and check:full`,
    );
    return undefined;
  }
  if (protectedVerificationTask(task) && !scriptRole.startsWith("quality:")) {
    diagnostics.push(
      `${task.fullName} is a reserved verification task and cannot be assigned non-verification role ${scriptRole}`,
    );
    return undefined;
  }

  return scriptRole;
}

function readTaskDirectory(
  cwd: string,
  entryCommand: string,
  turboCommand?: TurboCommand,
): {
  readonly tasks: readonly TurboTask[];
  readonly diagnostics: readonly string[];
} {
  const result = runCaptured(cwd, ["query", turboTaskQuery], turboCommand);
  if (result.error !== undefined || result.status !== 0) {
    return {
      diagnostics: [commandFailure("native task directory query", result)],
      tasks: [],
    };
  }

  let response: unknown;
  try {
    response = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    return {
      diagnostics: [
        `Turbo native task directory is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
      tasks: [],
    };
  }

  const packages =
    isRecord(response) && isRecord(response.data)
      ? response.data.packages
      : undefined;
  const packageItems = isRecord(packages) ? packages.items : undefined;
  if (!Array.isArray(packageItems)) {
    return {
      diagnostics: ["Turbo native task directory is missing packages.items"],
      tasks: [],
    };
  }

  const diagnostics: string[] = [];
  const tasks: TurboTask[] = [];
  for (const packageItem of packageItems) {
    if (!isRecord(packageItem) || !isNonEmptyString(packageItem.name)) {
      diagnostics.push(
        "Turbo native task directory contains an unrecognized workspace package",
      );
      continue;
    }
    const taskConnection = packageItem.tasks;
    const taskItems = isRecord(taskConnection)
      ? taskConnection.items
      : undefined;
    if (!Array.isArray(taskItems)) {
      diagnostics.push(
        `Turbo task directory for ${packageItem.name} is missing tasks.items`,
      );
      continue;
    }

    for (const taskItem of taskItems) {
      if (!isRecord(taskItem)) {
        diagnostics.push(
          `Turbo task directory for ${packageItem.name} contains an invalid task`,
        );
        continue;
      }
      const { name, fullName, tags, script, command } = taskItem;
      if (
        !isNonEmptyString(name) ||
        !isNonEmptyString(fullName) ||
        !Array.isArray(tags) ||
        !tags.every((tag) => typeof tag === "string")
      ) {
        diagnostics.push(
          `Turbo task entry in ${packageItem.name} is missing a name or tags`,
        );
        continue;
      }

      const executable = isNonEmptyString(script) || isNonEmptyString(command);
      const taskWithoutRole = {
        name,
        fullName,
        packageName: packageItem.name,
        tags,
        executable,
      };
      if (publicGateTask(taskWithoutRole)) {
        const expectedCommand = `${entryCommand} ${name}`;
        if (script !== expectedCommand || command !== expectedCommand) {
          diagnostics.push(
            `${fullName} public gate entry is miswired; both package.json script and effective command must be ${expectedCommand}`,
          );
        }
      }
      if (!executable && roleTags(tags).length === 0) {
        tasks.push(taskWithoutRole);
        continue;
      }

      const role = assignRole(taskWithoutRole, diagnostics);
      tasks.push(
        role === undefined ? taskWithoutRole : { ...taskWithoutRole, role },
      );
    }
  }

  for (const name of publicGateNames) {
    if (
      !tasks.some((task) => task.packageName === "//" && task.name === name)
    ) {
      diagnostics.push(`Missing root public gate entry ${name}`);
    }
  }

  return { diagnostics, tasks };
}

function parseDryRun(
  cwd: string,
  tasks: readonly TurboTask[],
  turboCommand?: TurboCommand,
): {
  readonly taskIds: readonly string[];
  readonly diagnostics: readonly string[];
} {
  if (tasks.length === 0) {
    return { diagnostics: [], taskIds: [] };
  }
  const result = runCaptured(
    cwd,
    ["run", ...tasks.map((task) => task.fullName), "--dry=json"],
    turboCommand,
  );
  if (result.error !== undefined || result.status !== 0) {
    return {
      diagnostics: [commandFailure("execution graph dry run", result)],
      taskIds: [],
    };
  }

  let response: unknown;
  try {
    response = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    return {
      diagnostics: [
        `Turbo execution graph dry run is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
      taskIds: [],
    };
  }
  if (!isRecord(response) || !Array.isArray(response.tasks)) {
    return {
      diagnostics: ["Turbo execution graph dry run is missing tasks"],
      taskIds: [],
    };
  }

  const taskIds: string[] = [];
  const diagnostics: string[] = [];
  for (const task of response.tasks) {
    if (!isRecord(task) || !isNonEmptyString(task.taskId)) {
      diagnostics.push(
        "Turbo execution graph dry run contains an unrecognized taskId",
      );
      continue;
    }
    taskIds.push(task.taskId);
  }

  return { diagnostics, taskIds };
}

function validateLayerClosure(
  layer: GateLayer,
  taskIds: readonly string[],
  tasksByName: ReadonlyMap<string, TurboTask>,
): readonly string[] {
  const diagnostics: string[] = [];
  for (const taskId of taskIds) {
    const dependency = tasksByName.get(taskId);
    if (dependency === undefined) {
      diagnostics.push(
        `${layer.label} execution graph contains task ${taskId} which is missing from the task directory`,
      );
      continue;
    }
    if (publicGateTask(dependency)) {
      diagnostics.push(
        `${layer.label} execution graph includes ${dependency.fullName}: leaf tasks cannot depend on public aggregate gate entries`,
      );
    } else if (
      dependency.role !== undefined &&
      dependency.role !== layer.role &&
      dependency.role !== "work:preparation" &&
      !(layer.role !== "quality:light" && dependency.role === "quality:light")
    ) {
      const scope =
        layer.role === "quality:light" && dependency.role === "quality:heavy"
          ? "light check cannot transitively trigger heavy verification"
          : dependency.role === "quality:conditional"
            ? "standard verification cannot transitively trigger conditional verification"
            : `transitively triggering role ${dependency.role} is not allowed`;
      diagnostics.push(
        `${layer.label} execution graph includes ${dependency.fullName}: ${scope}`,
      );
    }
  }

  return diagnostics;
}

function layerFor(role: GateLayer["role"]): GateLayer {
  return {
    role,
    label:
      role === "quality:light"
        ? "Light check"
        : role === "quality:heavy"
          ? "Heavy verification"
          : "Fix",
  };
}

function layersFor(gate: TaskGate): readonly GateLayer[] {
  if (gate === "check") {
    return [layerFor("quality:light")];
  }
  if (gate === "check:heavy") {
    return [layerFor("quality:heavy")];
  }
  if (gate === "fix") {
    return [layerFor("work:repair")];
  }

  return [layerFor("quality:light"), layerFor("quality:heavy")];
}

/**
 * Validates workspace Turbo task role tags, public gate wiring, and layer execution closures
 * without running any tasks.
 */
export function inspectTaskGate(
  gate: TaskGate,
  cwd = process.cwd(),
  entryCommand = defaultEntryCommand,
  turboCommand?: TurboCommand,
): {
  readonly diagnostics: readonly string[];
  readonly plans: readonly {
    readonly layer: GateLayer;
    readonly tasks: readonly TurboTask[];
  }[];
  readonly conditionalTasks: readonly TurboTask[];
} {
  if (!publicGateNames.has(gate)) {
    return {
      diagnostics: [`Unknown public gate entry: ${String(gate)}`],
      plans: [],
      conditionalTasks: [],
    };
  }

  const directory = readTaskDirectory(cwd, entryCommand, turboCommand);
  if (directory.diagnostics.length > 0) {
    return {
      diagnostics: directory.diagnostics,
      plans: [],
      conditionalTasks: [],
    };
  }
  const tasksByName = new Map(
    directory.tasks.map((task) => [task.fullName, task]),
  );
  const layers = layersFor(gate);
  const plans: {
    readonly layer: GateLayer;
    readonly tasks: readonly TurboTask[];
  }[] = [];
  const diagnostics: string[] = [];

  for (const task of directory.tasks) {
    if (task.executable || task.role === undefined) {
      continue;
    }
    const dryRun = parseDryRun(cwd, [task], turboCommand);
    diagnostics.push(...dryRun.diagnostics);
    if (
      dryRun.diagnostics.length === 0 &&
      !dryRun.taskIds.some(
        (taskId) => tasksByName.get(taskId)?.executable === true,
      )
    ) {
      diagnostics.push(
        `${task.fullName} declares dangling role tag ${task.role}: commandless node has no executable work in its native execution graph`,
      );
    }
  }

  for (const layer of layers) {
    const selected = directory.tasks.filter(
      (task) => task.role === layer.role && !publicGateTask(task),
    );
    const dryRun = parseDryRun(cwd, selected, turboCommand);
    diagnostics.push(...dryRun.diagnostics);
    diagnostics.push(
      ...validateLayerClosure(layer, dryRun.taskIds, tasksByName),
    );
    if (
      layer.role === "quality:light" &&
      !dryRun.taskIds.some(
        (taskId) => tasksByName.get(taskId)?.executable === true,
      )
    ) {
      diagnostics.push(
        "Light check selected no executable tasks; declare quality:light on actual verification tasks",
      );
    }
    plans.push({ layer, tasks: selected });
  }

  const conditionalTasks = directory.tasks.filter(
    (task) => task.role === "quality:conditional",
  );
  return { diagnostics, plans, conditionalTasks };
}

/**
 * Validates the workspace task graph via `inspectTaskGate` and executes each selected layer in
 * sequence. Returns `0` on success, `1` on validation failure, or the failing Turbo exit status.
 */
export async function runTaskGate(
  gate: TaskGate,
  cwd = process.cwd(),
  entryCommand = defaultEntryCommand,
): Promise<number> {
  const { diagnostics, plans, conditionalTasks } = inspectTaskGate(
    gate,
    cwd,
    entryCommand,
  );
  if (diagnostics.length > 0) {
    report(diagnostics.join("\n"));
    return 1;
  }

  if (gate !== "fix" && conditionalTasks.length > 0) {
    report(
      `Conditional verification tasks not run: ${conditionalTasks.map((task) => task.fullName).join(", ")}`,
    );
  }

  for (const plan of plans) {
    if (plan.tasks.length === 0) {
      report(`${plan.layer.label} selected no tasks; skipping execution`);
      continue;
    }
    const status = await runVisible(cwd, [
      "run",
      ...plan.tasks.map((task) => task.fullName),
      "--continue=dependencies-successful",
      gate === "fix" ? "--output-logs=full" : "--output-logs=errors-only",
      "--log-order=grouped",
      "--log-prefix=task",
    ]);
    if (status !== 0) {
      return status;
    }
  }

  return 0;
}

/**
 * Parses CLI gate arguments from `process.argv` and runs the requested public task gate,
 * setting `process.exitCode` to `2` on usage errors and `1` on unexpected failures.
 */
export async function runTaskGateCli(
  entryCommand = defaultEntryCommand,
): Promise<void> {
  const [gate, ...extraArguments] = process.argv.slice(2);
  if (
    gate === undefined ||
    !publicGateNames.has(gate as TaskGate) ||
    extraArguments.length > 0
  ) {
    report(`Usage: ${entryCommand} <check|check:heavy|check:full|fix>`);
    process.exitCode = 2;
    return;
  }

  try {
    process.exitCode = await runTaskGate(
      gate as TaskGate,
      process.cwd(),
      entryCommand,
    );
  } catch (error) {
    report(
      `Public gate entry failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

const mainFile = process.argv[1];
if (
  mainFile !== undefined &&
  pathToFileURL(resolve(mainFile)).href === import.meta.url
) {
  void runTaskGateCli();
}
