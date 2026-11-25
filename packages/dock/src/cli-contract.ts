import { readFileSync } from "node:fs";

import type {
  BaselineUpdateIssue,
  BindingCheckResult,
  TextRange,
} from "@dock/core";
import {
  checkForCli,
  inspect,
  lineRangeKey,
  MaintenanceError,
  updateBaselineForCli,
  type CheckReport,
  type LineRangeRecord,
  type MaintenanceScope,
  type ResolvedMaintenance,
} from "@dock/host";
import {
  defineCli,
  helpCapability,
  text,
  versionCapability,
} from "@ykdz/cli-contract";
import { z } from "zod";

const define = defineCli();
const checkLineRanges = new WeakMap<object, LineRangeRecord>();
const reportPayload = z.object({ report: z.unknown() });
const updateIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
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

const presentReport = (
  { report }: { readonly report: unknown },
  context: { readonly input: object },
) =>
  text.lines(
    toTextLines(
      formatReport(report as CheckReport, checkLineRanges.get(context.input)),
    ),
  );

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
          const { report, lineRanges } = await checkForCli(
            input.config,
            inputScope(input),
          );
          checkLineRanges.set(input, lineRanges);
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
          const { outcome: result, lineRanges } = await updateBaselineForCli(
            input.config,
            inputScope(input),
          );
          checkLineRanges.set(input, lineRanges);
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
            updated: ({ report }, context) =>
              text.lines(
                toTextLines(
                  formatUpdatedUpdate(
                    report as CheckReport,
                    checkLineRanges.get(context.input),
                  ),
                ),
              ),
            rejected: ({ report, errors }, context) =>
              text.lines(
                toTextLines(
                  formatRejectedUpdate(
                    report as CheckReport,
                    errors as BaselineUpdateIssue[],
                    checkLineRanges.get(context.input),
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

function createReportLines(report: CheckReport): [string, ...string[]] {
  const lines: [string, ...string[]] = [
    `Scope: ${report.scope.length === 0 ? "none" : report.scope.join(", ")}`,
  ];
  for (const error of report.pluginErrors) {
    lines.push(
      `Plugin ${error.pluginId} error (${error.code}): ${error.message}`,
    );
  }
  return lines;
}

function activeReportBindings(report: CheckReport): BindingCheckResult[] {
  return report.bindings.filter(
    (binding) => "errors" in binding || binding.changes.length > 0,
  );
}

function formatReport(
  report: CheckReport,
  lineRanges?: LineRangeRecord,
): [string, ...string[]] {
  const lines = createReportLines(report);
  if (report.scope.length === 0) {
    lines.push("No bindings in scope.");
    return lines;
  }
  const activeBindings = activeReportBindings(report);
  if (activeBindings.length === 0) {
    lines.push("All checked bindings are consistent with baseline.");
    return lines;
  }
  const seenErrors = new Map<string, string>();
  for (const binding of activeBindings) {
    lines.push(...formatBinding(binding, lineRanges, seenErrors));
  }
  return lines;
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

function formatUpdatedUpdate(
  report: CheckReport,
  lineRanges?: LineRangeRecord,
): [string, ...string[]] {
  const lines = formatReport(report, lineRanges);
  lines.push("Baseline updated.");
  return lines;
}

function formatRejectedUpdate(
  report: CheckReport,
  errors: readonly BaselineUpdateIssue[],
  lineRanges?: LineRangeRecord,
): [string, ...string[]] {
  const lines = createReportLines(report);
  const seenErrors = new Map<string, string>();
  for (const binding of activeReportBindings(report)) {
    lines.push(...formatBinding(binding, lineRanges, seenErrors));
  }
  for (const error of errors) {
    lines.push(`Update error (${error.code}): ${error.message}`);
  }
  lines.push("Baseline was not updated.");
  return lines;
}

function formatBinding(
  binding: BindingCheckResult,
  lineRanges?: LineRangeRecord,
  seenErrors?: Map<string, string>,
): string[] {
  const lines = [`Binding ${binding.bindingId}`];
  const erroredIds = new Set<string>();
  if ("errors" in binding && binding.errors !== undefined) {
    for (const error of binding.errors) {
      if (error.referenceId !== undefined) {
        erroredIds.add(error.referenceId);
      }
      const identity = [error.referenceId, error.memberId]
        .filter(Boolean)
        .join(" / ");
      const location = formatLocation(
        error.range,
        undefined,
        lineRanges,
        error.referenceId,
      );
      const locSuffix = location === undefined ? "" : ` (${location})`;
      const rootCauseKey = `${error.code}\0${location ?? ""}\0${error.message}`;
      const priorLabel = seenErrors?.get(rootCauseKey);
      const label = identity === "" ? `binding ${binding.bindingId}` : identity;
      if (priorLabel !== undefined) {
        lines.push(
          `Error${identity === "" ? "" : ` ${identity}`} (${error.code})${locSuffix}: same root cause as ${priorLabel}`,
        );
      } else {
        seenErrors?.set(rootCauseKey, label);
        lines.push(
          `Error${identity === "" ? "" : ` ${identity}`} (${error.code})${locSuffix}: ${error.message}`,
        );
      }
    }
  }

  const currentReferences =
    "current" in binding && binding.current !== undefined
      ? binding.current.references
      : undefined;
  const changedIds = new Set<string>();
  for (const change of binding.changes) {
    if ("referenceId" in change) {
      changedIds.add(change.referenceId);
    }
    lines.push(...formatChange(change, currentReferences, lineRanges));
  }

  if (currentReferences !== undefined) {
    const otherReferences = Object.values(currentReferences).filter(
      (reference) =>
        !changedIds.has(reference.definition.id) &&
        !erroredIds.has(reference.definition.id),
    );
    if (otherReferences.length > 0) {
      lines.push(
        binding.changes.some((change) => change.kind === "binding-added")
          ? "References in binding:"
          : "Other references to check:",
      );
      for (const reference of otherReferences) {
        const location = formatLocation(
          reference.range,
          referenceFileInfo(reference.definition.target),
          lineRanges,
          reference.definition.id,
        );
        lines.push(
          location === undefined
            ? `  - ${reference.definition.id}`
            : `  - ${reference.definition.id} (${location})`,
        );
      }
    }
  }
  return lines;
}

function formatLocation(
  range: TextRange | undefined,
  fileInfo: string | undefined,
  lineRanges: LineRangeRecord | undefined,
  referenceId?: string,
): string | undefined {
  if (range !== undefined) {
    const lineRange = lineRanges?.[lineRangeKey(range, referenceId)];
    if (lineRange !== undefined) {
      return lineRange.startLine === lineRange.endLine
        ? `${range.path}:${lineRange.startLine}`
        : `${range.path}:${lineRange.startLine}-${lineRange.endLine}`;
    }
    return `${range.path} (text offset ${range.start}-${range.end})`;
  }
  return fileInfo;
}

function formatLocationSuffix(
  range: TextRange | undefined,
  fileInfo: string | undefined,
  lineRanges: LineRangeRecord | undefined,
  referenceId?: string,
): string {
  const location = formatLocation(range, fileInfo, lineRanges, referenceId);
  return location === undefined ? "" : ` (${location})`;
}

function formatChange(
  change: BindingCheckResult["changes"][number],
  currentReferences:
    | Readonly<
        Record<
          string,
          {
            readonly range?: TextRange;
            readonly definition: { readonly target: unknown };
          }
        >
      >
    | undefined,
  lineRanges: LineRangeRecord | undefined,
): string[] {
  const reference =
    "referenceId" in change && currentReferences !== undefined
      ? currentReferences[change.referenceId]
      : undefined;
  const locSuffix =
    "referenceId" in change
      ? formatLocationSuffix(
          reference?.range,
          reference === undefined
            ? undefined
            : referenceFileInfo(reference.definition.target),
          lineRanges,
          change.referenceId,
        )
      : "";

  if (change.kind === "binding-added") {
    return ["Change: binding added (not yet in baseline)"];
  }
  if (change.kind === "binding-removed") {
    return ["Change: binding removed (no longer in current declarations)"];
  }
  if (change.kind === "binding-definition") {
    return [
      `Change: binding definition changed: references ${JSON.stringify(change.before.references)} -> ${JSON.stringify(change.after.references)}`,
    ];
  }
  if (change.kind === "reference-added") {
    return [`Change: reference ${change.referenceId} added${locSuffix}`];
  }
  if (change.kind === "reference-removed") {
    return [`Change: reference ${change.referenceId} removed`];
  }
  if (change.kind === "reference-definition") {
    return [
      `Change: reference ${change.referenceId} definition changed${formatDefinitionLocations(change.before, change.after)}`,
    ];
  }
  if (change.kind === "fact" && "before" in change) {
    if (
      typeof change.before === "string" &&
      typeof change.after === "string" &&
      (isMultilineText(change.before) || isMultilineText(change.after))
    ) {
      return [
        `Change: ${change.referenceId} fact changed${locSuffix}`,
        ...formatMultilineDiff(change.before, change.after),
      ];
    }
    return [
      `Change: ${change.referenceId} fact: before ${JSON.stringify(change.before)}; after ${JSON.stringify(change.after)}${locSuffix}`,
    ];
  }
  if (change.kind === "fact") {
    return change.memberChanges.map((member) => {
      if (!member.beforePresent && member.afterPresent) {
        return `Change: ${change.referenceId} member ${member.memberId} added: ${JSON.stringify(member.after)}`;
      }
      if (member.beforePresent && !member.afterPresent) {
        return `Change: ${change.referenceId} member ${member.memberId} removed (was ${JSON.stringify(member.before)})`;
      }
      return `Change: ${change.referenceId} member ${member.memberId} changed: before ${JSON.stringify(member.before)}; after ${JSON.stringify(member.after)}`;
    });
  }
  return [`Change: ${JSON.stringify(change)}`];
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

const DIFF_CONTEXT_LINES = 2;
const MAX_LCS_CELLS = 200_000;

function isMultilineText(value: string): boolean {
  return value.includes("\n") || value.includes("\r");
}

function splitDiffLines(value: string): string[] {
  const withoutTrailingNewline = value.replace(/(?:\r\n|\r|\n)$/u, "");
  return withoutTrailingNewline.length === 0
    ? []
    : withoutTrailingNewline.split(/\r\n|\r|\n/u);
}

type DiffStep = {
  readonly kind: "equal" | "delete" | "insert";
  readonly line: string;
  readonly beforeLine: number;
  readonly afterLine: number;
};

function computeLineDiffSteps(
  beforeLines: readonly string[],
  afterLines: readonly string[],
): DiffStep[] {
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    beforeLines.length - 1 - suffix >= prefix &&
    afterLines.length - 1 - suffix >= prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const steps: DiffStep[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  const pushEqual = (line: string): void => {
    steps.push({ kind: "equal", line, beforeLine, afterLine });
    beforeLine += 1;
    afterLine += 1;
  };
  const pushDelete = (line: string): void => {
    steps.push({ kind: "delete", line, beforeLine, afterLine });
    beforeLine += 1;
  };
  const pushInsert = (line: string): void => {
    steps.push({ kind: "insert", line, beforeLine, afterLine });
    afterLine += 1;
  };

  for (let index = 0; index < prefix; index += 1) {
    pushEqual(beforeLines[index]!);
  }

  const beforeMid = beforeLines.slice(prefix, beforeLines.length - suffix);
  const afterMid = afterLines.slice(prefix, afterLines.length - suffix);
  if (beforeMid.length > 0 || afterMid.length > 0) {
    if (beforeMid.length * afterMid.length <= MAX_LCS_CELLS) {
      const m = beforeMid.length;
      const n = afterMid.length;
      const stride = n + 1;
      const dp = new Uint32Array((m + 1) * stride);
      for (let i = m - 1; i >= 0; i -= 1) {
        for (let j = n - 1; j >= 0; j -= 1) {
          dp[i * stride + j] =
            beforeMid[i] === afterMid[j]
              ? dp[(i + 1) * stride + (j + 1)]! + 1
              : Math.max(dp[(i + 1) * stride + j]!, dp[i * stride + (j + 1)]!);
        }
      }
      let i = 0;
      let j = 0;
      while (i < m && j < n) {
        if (beforeMid[i] === afterMid[j]) {
          pushEqual(beforeMid[i]!);
          i += 1;
          j += 1;
        } else if (dp[(i + 1) * stride + j]! >= dp[i * stride + (j + 1)]!) {
          pushDelete(beforeMid[i]!);
          i += 1;
        } else {
          pushInsert(afterMid[j]!);
          j += 1;
        }
      }
      while (i < m) {
        pushDelete(beforeMid[i]!);
        i += 1;
      }
      while (j < n) {
        pushInsert(afterMid[j]!);
        j += 1;
      }
    } else {
      for (const line of beforeMid) pushDelete(line);
      for (const line of afterMid) pushInsert(line);
    }
  }

  for (
    let index = beforeLines.length - suffix;
    index < beforeLines.length;
    index += 1
  ) {
    pushEqual(beforeLines[index]!);
  }
  return steps;
}

function formatMultilineDiff(before: string, after: string): string[] {
  const beforeLines = splitDiffLines(before);
  const afterLines = splitDiffLines(after);
  const steps = computeLineDiffSteps(beforeLines, afterLines);

  const hunks: { start: number; end: number }[] = [];
  for (let index = 0; index < steps.length; index += 1) {
    if (steps[index]!.kind === "equal") continue;
    const start = Math.max(0, index - DIFF_CONTEXT_LINES);
    const end = Math.min(steps.length - 1, index + DIFF_CONTEXT_LINES);
    const previous = hunks.at(-1);
    if (previous !== undefined && start <= previous.end + 1) {
      previous.end = end;
    } else {
      hunks.push({ start, end });
    }
  }

  if (hunks.length === 0) {
    return ["  (line endings or trailing newline changed)"];
  }

  const maxLineNumber = Math.max(beforeLines.length, afterLines.length, 1);
  const width = String(maxLineNumber).length;
  const output: string[] = [];
  for (const hunk of hunks) {
    const slice = steps.slice(hunk.start, hunk.end + 1);
    const first = slice[0]!;
    const beforeCount = slice.filter((step) => step.kind !== "insert").length;
    const afterCount = slice.filter((step) => step.kind !== "delete").length;
    const beforeStart =
      beforeCount === 0 ? Math.max(0, first.beforeLine - 1) : first.beforeLine;
    const afterStart =
      afterCount === 0 ? Math.max(0, first.afterLine - 1) : first.afterLine;
    output.push(
      `  @@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`,
    );
    for (const step of slice) {
      if (step.kind === "equal") {
        output.push(
          `    ${String(step.afterLine).padStart(width)} | ${step.line}`,
        );
      } else if (step.kind === "delete") {
        output.push(
          `  - ${String(step.beforeLine).padStart(width)} | ${step.line}`,
        );
      } else {
        output.push(
          `  + ${String(step.afterLine).padStart(width)} | ${step.line}`,
        );
      }
    }
  }
  return output;
}
