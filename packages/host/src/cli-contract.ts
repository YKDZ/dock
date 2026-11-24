import { readFileSync } from "node:fs";

import {
  defineCli,
  helpCapability,
  text,
  versionCapability,
} from "@ykdz/cli-contract";
import { z } from "zod";

import type {
  BaselineUpdateIssue,
  BindingCheckResult,
  TextRange,
} from "./core/index.ts";
import {
  check,
  inspect,
  MaintenanceError,
  updateBaseline,
} from "./maintenance.ts";
import type { CheckReport, MaintenanceScope } from "./maintenance.ts";
import type { ResolvedMaintenance } from "./resolution.ts";

const define = defineCli();
const reportPayload = z.object({ report: z.unknown() });
const updateIssueSchema = z.object({
  bindingId: z.string().optional(),
  referenceId: z.string().optional(),
  memberId: z.string().optional(),
  code: z.string(),
  message: z.string(),
  range: z
    .object({ path: z.string(), start: z.number(), end: z.number() })
    .optional(),
});
const rejectedUpdatePayload = z.object({
  report: z.unknown(),
  errors: z.array(updateIssueSchema),
});
const failurePayload = z.object({ code: z.string(), message: z.string() });

const sharedFields = {
  config: {
    kind: "valueOption",
    longOption: "--config",
    description: "Explicitly select an ESM config entry",
  },
  binding: {
    kind: "repeatableOption",
    longOption: "--binding",
    description: "Select a binding ID (repeatable)",
  },
  reference: {
    kind: "repeatableOption",
    longOption: "--reference",
    description: "Select a reference ID (repeatable)",
  },
  file: {
    kind: "repeatableOption",
    longOption: "--file",
    description: "Select a direct target file (repeatable)",
  },
} as const;

const sharedInput = z.object({
  config: z.string().min(1),
  binding: z.array(z.string().min(1)).optional(),
  reference: z.array(z.string().min(1)).optional(),
  file: z.array(z.string().min(1)).optional(),
});

const maintenanceFailureVariant = {
  description: "Configuration loading or maintenance operation failed",
  schema: failurePayload,
  exitCode: 1,
} as const;

const structuredModeOptions = {
  description: "Machine-readable JSON output",
} as const;

const presentMaintenanceFailure = ({
  code,
  message,
}: {
  readonly code: string;
  readonly message: string;
}) => text.lines(toTextLines([`Maintenance failed (${code})`, message]));

const inspectCommand = define.command("inspect")({
  kind: "command",
  parent: "dock",
  name: "inspect",
  description: "Inspect resolved declarations, check scope, and target files",
  fields: sharedFields,
  input: sharedInput,
  outputs(factory) {
    const execution = factory.atomic({
      success: {
        kind: "data",
        variants: {
          inspected: {
            description: "Resolved declarations and check scope",
            schema: z.object({ resolution: z.unknown() }),
            exitCode: 0,
          },
        },
      },
      failures: {
        maintenanceFailed: {
          description: "Configuration loading or resolution failed",
          schema: failurePayload,
          exitCode: 1,
        },
      },
      async handler({ input, outcome }) {
        try {
          const resolution = await inspect(input.config, inputScope(input));
          return outcome.data.inspected({ resolution });
        } catch (error) {
          return outcome.failure.maintenanceFailed(asFailure(error));
        }
      },
    });

    return {
      default: "text",
      modes: {
        text: execution.text({
          description: "Human-readable text output",
          success: {
            inspected: ({ resolution }) =>
              text.lines(
                toTextLines(
                  formatResolution(resolution as ResolvedMaintenance),
                ),
              ),
          },
          failures: {
            maintenanceFailed: presentMaintenanceFailure,
          },
        }),
        structured: execution.structured(structuredModeOptions),
      },
    };
  },
});

const checkCommand = define.command("check")({
  kind: "command",
  parent: "dock",
  name: "check",
  description: "Check registered bindings against the baseline",
  fields: sharedFields,
  input: sharedInput,
  outputs(factory) {
    const execution = factory.atomic({
      success: {
        kind: "data",
        variants: {
          consistent: {
            description: "All bindings match the baseline",
            schema: reportPayload,
            exitCode: 0,
          },
          changed: {
            description: "At least one binding has a valid change",
            schema: reportPayload,
            exitCode: 1,
          },
          errors: {
            description: "At least one binding could not be checked",
            schema: reportPayload,
            exitCode: 1,
          },
        },
      },
      failures: {
        maintenanceFailed: maintenanceFailureVariant,
      },
      async handler({ input, outcome }) {
        try {
          const report = await check(input.config, inputScope(input));
          const hasErrors = report.bindings.some(
            (binding) => "errors" in binding,
          );
          const hasChanges = report.bindings.some(
            (binding) => binding.changes.length > 0,
          );
          if (hasErrors) return outcome.data.errors({ report });
          if (hasChanges) return outcome.data.changed({ report });
          return outcome.data.consistent({ report });
        } catch (error) {
          return outcome.failure.maintenanceFailed(asFailure(error));
        }
      },
    });

    const presentReport = ({ report }: { readonly report: unknown }) =>
      text.lines(toTextLines(formatReport(report as CheckReport)));

    return {
      default: "text",
      modes: {
        text: execution.text({
          description: "Human-readable text output",
          success: {
            consistent: presentReport,
            changed: presentReport,
            errors: presentReport,
          },
          failures: {
            maintenanceFailed: presentMaintenanceFailure,
          },
        }),
        structured: execution.structured(structuredModeOptions),
      },
    };
  },
});

const updateCommand = define.command("update")({
  kind: "command",
  parent: "baseline",
  name: "update",
  description: "Recollect facts and explicitly update the baseline",
  fields: sharedFields,
  input: sharedInput,
  outputs(factory) {
    const execution = factory.atomic({
      success: {
        kind: "data",
        variants: {
          updated: {
            description: "Baseline updated",
            schema: reportPayload,
            exitCode: 0,
          },
          rejected: {
            description: "Current evidence or scope does not allow saving",
            schema: rejectedUpdatePayload,
            exitCode: 1,
          },
        },
      },
      failures: {
        maintenanceFailed: {
          description: "Configuration loading, checking, or saving failed",
          schema: failurePayload,
          exitCode: 1,
        },
      },
      async handler({ input, outcome }) {
        try {
          const result = await updateBaseline(input.config, inputScope(input));
          if (result.status === "updated") {
            return outcome.data.updated({ report: result.report });
          }
          return outcome.data.rejected({
            report: result.report,
            errors: result.errors,
          });
        } catch (error) {
          return outcome.failure.maintenanceFailed(asFailure(error));
        }
      },
    });

    return {
      default: "text",
      modes: {
        text: execution.text({
          description: "Human-readable text output",
          success: {
            updated: ({ report }) =>
              text.lines(toTextLines(formatReport(report as CheckReport))),
            rejected: ({ report, errors }) =>
              text.lines(
                toTextLines(
                  formatRejectedUpdate(
                    report as CheckReport,
                    errors as BaselineUpdateIssue[],
                  ),
                ),
              ),
          },
          failures: {
            maintenanceFailed: presentMaintenanceFailure,
          },
        }),
        structured: execution.structured(structuredModeOptions),
      },
    };
  },
});

export const cli = define({
  root: "dock",
  help: helpCapability({
    shortAlias: "-h",
    headings: {
      usage: "Usage",
      commands: "Commands",
      arguments: "Arguments",
      options: "Options",
    },
    wording: {
      commandPlaceholder: "command",
      choices: "(choices: {choices})",
      default: "(default: {value})",
      countExactly: "{fields} must appear exactly {count} time(s)",
      countAtLeast: "{fields} must appear at least {min} time(s)",
      countAtMost: "{fields} must appear at most {max} time(s)",
      countBetween: "{fields} must appear between {min} and {max} time(s)",
      whenOnMatch: "when {facts}, {onMatch}",
      whenOtherwise: "when not ({facts}), {otherwise}",
      whenOnMatchOtherwise: "when {facts}, {onMatch}; otherwise {otherwise}",
      require: "require {fields}",
      forbid: "forbid {fields}",
      present: "{field} is provided",
      equals: "{field} equals {value}",
      forbiddenCombination: "cannot combine {facts}",
    },
  }),
  version: versionCapability({
    value: text.line(
      (
        JSON.parse(
          readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ) as { version: string }
      ).version,
    ),
    description: "Show installed version",
  }),
  usageFailureExitCode: 64,
  commands: {
    dock: {
      kind: "rootGroup",
      name: "dock",
      description: "Explicitly check and maintain registered binding baselines",
    },
    baseline: {
      kind: "commandGroup",
      parent: "dock",
      name: "baseline",
      description: "Baseline maintenance commands",
    },
    ...inspectCommand,
    ...checkCommand,
    ...updateCommand,
  },
});

function toTextLines(lines: readonly string[]): [string, ...string[]] {
  const expanded: string[] = [];
  for (const line of lines) {
    // Strip NUL bytes and split embedded newlines so text.lines never throws TextValueError.
    const sanitized = line.replaceAll("\0", "");
    expanded.push(...sanitized.split(/\r\n|\r|\n/u));
  }
  if (expanded.every((line) => line.length === 0)) {
    return ["(empty)"];
  }
  return expanded as [string, ...string[]];
}

function asFailure(error: unknown): { code: string; message: string } {
  if (error instanceof MaintenanceError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "maintenance-failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function inputScope(input: {
  readonly binding?: readonly string[] | undefined;
  readonly reference?: readonly string[] | undefined;
  readonly file?: readonly string[] | undefined;
}): MaintenanceScope | undefined {
  if (
    input.binding === undefined &&
    input.reference === undefined &&
    input.file === undefined
  ) {
    return undefined;
  }
  return {
    ...(input.binding === undefined ? {} : { binding: input.binding }),
    ...(input.reference === undefined ? {} : { reference: input.reference }),
    ...(input.file === undefined ? {} : { file: input.file }),
  };
}

function formatReport(report: CheckReport): [string, ...string[]] {
  const lines = [
    `Scope: ${report.scope.length === 0 ? "none" : report.scope.join(", ")}`,
  ];
  for (const diagnostic of report.pluginDiagnostics) {
    for (const line of diagnostic.text) {
      lines.push(`Plugin ${diagnostic.pluginId}: ${line}`);
    }
  }
  for (const error of report.pluginErrors) {
    lines.push(
      `Plugin ${error.pluginId} error (${error.code}): ${error.message}`,
    );
  }
  for (const binding of report.bindings) {
    lines.push(...formatBinding(binding));
  }
  return lines as [string, ...string[]];
}

function formatResolution(
  resolution: ResolvedMaintenance,
): [string, ...string[]] {
  const { context } = resolution;
  const scope = context.scope;
  const lines: [string, ...string[]] = [
    `Root: ${resolution.root}`,
    `Baseline: ${resolution.baselinePath}`,
    `Baseline status: ${context.baseline === undefined ? "not created" : "loaded"}`,
    `Scope: ${scope.length === 0 ? "none" : scope.join(", ")}`,
    `Plugins: ${resolution.plugins.length === 0 ? "none" : resolution.plugins.map(({ id }) => id).join(", ")}`,
  ];
  if (resolution.configPath !== undefined) {
    lines.unshift(`Config entry: ${resolution.configPath}`);
  }
  for (const reference of context.references) {
    lines.push(
      `Reference declaration ${reference.id}: ${JSON.stringify(reference)}`,
    );
  }
  for (const binding of context.bindings) {
    lines.push(`Binding declaration ${binding.id}: ${JSON.stringify(binding)}`);
  }
  for (const plugin of resolution.plugins) {
    lines.push(
      `Plugin ${plugin.id}: declared references ${plugin.references.join(", ") || "none"}; selected ${plugin.selectedReferences.join(", ") || "none"}`,
    );
    if (plugin.description !== undefined) {
      lines.push(...plugin.description.text);
    }
  }
  for (const file of resolution.files) {
    lines.push(`Target file ${file.path}: ${file.references.join(", ")}`);
  }
  for (const source of resolution.declarationSources.config) {
    lines.push(`Config source: ${source}`);
  }
  for (const [id, sources] of Object.entries(
    resolution.declarationSources.bindings,
  )) {
    for (const source of sources) {
      lines.push(`Binding ${id} declaration source: ${source}`);
    }
  }
  for (const [id, sources] of Object.entries(
    resolution.declarationSources.references,
  )) {
    for (const source of sources) {
      lines.push(`Reference ${id} declaration source: ${source}`);
    }
  }
  return lines;
}

function formatRejectedUpdate(
  report: CheckReport,
  errors: readonly BaselineUpdateIssue[],
): [string, ...string[]] {
  const lines = formatReport(report);
  for (const error of errors) {
    const identity = [error.bindingId, error.referenceId, error.memberId]
      .filter(Boolean)
      .join(" / ");
    lines.push(
      `Update error${identity === "" ? "" : ` ${identity}`} (${error.code})${formatRange(error.range)}: ${error.message}`,
    );
  }
  return lines;
}

function formatBinding(binding: BindingCheckResult): string[] {
  const lines = [`Binding ${binding.bindingId}`];
  if ("errors" in binding) {
    for (const error of binding.errors) {
      const identity = [error.referenceId, error.memberId]
        .filter(Boolean)
        .join(" / ");
      lines.push(
        `Error${identity === "" ? "" : ` ${identity}`} (${error.code})${formatRange(error.range)}: ${error.message}`,
      );
    }
    return lines;
  }
  if ("current" in binding) {
    for (const reference of Object.values(binding.current.references)) {
      const fileInfo = referenceFileInfo(reference.definition.target);
      const file = fileInfo === undefined ? "" : `, file ${fileInfo}`;
      lines.push(`Reference ${reference.definition.id}${file}`);
      lines.push(`Current fact: ${JSON.stringify(reference.value)}`);
      if (reference.range !== undefined) {
        lines.push(
          `Location ${reference.range.path} (text offset ${reference.range.start}-${reference.range.end})`,
        );
      }
    }
  }
  if (binding.changes.length === 0) {
    lines.push("Consistent with baseline.");
  } else {
    for (const change of binding.changes) {
      lines.push(`Change: ${describeChange(change)}`);
    }
  }
  return lines;
}

function formatRange(range: TextRange | undefined): string {
  return range === undefined
    ? ""
    : ` (${range.path}, text offset ${range.start}-${range.end})`;
}

function describeChange(change: BindingCheckResult["changes"][number]): string {
  if (change.kind === "fact" && "before" in change) {
    return `${change.referenceId} fact: before ${JSON.stringify(change.before)}; after ${JSON.stringify(change.after)}`;
  }
  if (change.kind === "fact") {
    return `${change.referenceId} member facts: ${JSON.stringify(change.memberChanges)}`;
  }
  if (change.kind === "binding-definition") {
    return `binding definition: before ${JSON.stringify(change.before)}; after ${JSON.stringify(change.after)}`;
  }
  if (change.kind === "reference-definition") {
    return `reference ${change.referenceId} definition changed${formatDefinitionLocations(change.before, change.after)}`;
  }
  return JSON.stringify(change);
}

function formatDefinitionLocations(before: unknown, after: unknown): string {
  const beforeFile = definitionFileInfo(before);
  const afterFile = definitionFileInfo(after);
  if (beforeFile !== undefined && afterFile !== undefined) {
    return beforeFile === afterFile
      ? ` (target file ${afterFile})`
      : `: previous target file ${beforeFile}; new target file ${afterFile}`;
  }
  if (beforeFile !== undefined) return `: previous target file ${beforeFile}`;
  if (afterFile !== undefined) return `: new target file ${afterFile}`;
  return "";
}

function definitionFileInfo(definition: unknown): string | undefined {
  if (!isRecord(definition)) return undefined;
  return referenceFileInfo(definition.target);
}

function referenceFileInfo(target: unknown): string | undefined {
  if (!isRecord(target)) return undefined;
  const fileInfo = target.fileInfo;
  return typeof fileInfo === "string" && fileInfo.length > 0
    ? fileInfo
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
