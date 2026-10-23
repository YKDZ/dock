import { readFileSync } from "node:fs";

import {
  defineCli,
  helpCapability,
  outputCapability,
  versionCapability,
  text,
} from "@ykdz/cli-contract";
import type {
  BaselineUpdateIssue,
  BindingCheckResult,
  TextRange,
} from "@ykdz/dock-core";
import { z } from "zod";

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

const inspectCommand = define.command("inspect")({
  kind: "command",
  parent: "dock",
  name: "inspect",
  description: "查看解析后的声明、检查范围与文件信息",
  fields: {
    config: {
      kind: "valueOption",
      longOption: "--config",
      description: "显式选择 ESM 配置入口",
    },
    binding: {
      kind: "repeatableOption",
      longOption: "--binding",
      description: "选择关联 ID，可重复提供",
    },
    reference: {
      kind: "repeatableOption",
      longOption: "--reference",
      description: "选择引用 ID，可重复提供",
    },
    file: {
      kind: "repeatableOption",
      longOption: "--file",
      description: "选择直接目标文件，可重复提供",
    },
  },
  input: z.object({
    config: z.string().min(1),
    binding: z.array(z.string().min(1)).optional(),
    reference: z.array(z.string().min(1)).optional(),
    file: z.array(z.string().min(1)).optional(),
  }),
  success: {
    kind: "data",
    variants: {
      inspected: {
        description: "已解析声明与检查范围",
        schema: z.object({ resolution: z.unknown() }),
        exitCode: 0,
        text: ({ resolution }) =>
          text.lines(formatResolution(resolution as ResolvedMaintenance)),
      },
    },
  },
  failures: {
    maintenanceFailed: {
      description: "配置加载或解析失败",
      schema: failurePayload,
      exitCode: 1,
      text: ({ code, message }) => text.lines([`维护失败（${code}）`, message]),
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

const checkCommand = define.command("check")({
  kind: "command",
  parent: "dock",
  name: "check",
  description: "核对已登记关联与基线的变化",
  fields: {
    config: {
      kind: "valueOption",
      longOption: "--config",
      description: "显式选择 ESM 配置入口",
    },
    binding: {
      kind: "repeatableOption",
      longOption: "--binding",
      description: "选择关联 ID，可重复提供",
    },
    reference: {
      kind: "repeatableOption",
      longOption: "--reference",
      description: "选择引用 ID，可重复提供",
    },
    file: {
      kind: "repeatableOption",
      longOption: "--file",
      description: "选择直接目标文件，可重复提供",
    },
  },
  input: z.object({
    config: z.string().min(1),
    binding: z.array(z.string().min(1)).optional(),
    reference: z.array(z.string().min(1)).optional(),
    file: z.array(z.string().min(1)).optional(),
  }),
  success: {
    kind: "data",
    variants: {
      consistent: {
        description: "所有关联与基线一致",
        schema: reportPayload,
        exitCode: 0,
        text: ({ report }) => text.lines(formatReport(report as CheckReport)),
      },
      changed: {
        description: "至少一条关联存在有效差异",
        schema: reportPayload,
        exitCode: 1,
        text: ({ report }) => text.lines(formatReport(report as CheckReport)),
      },
      errors: {
        description: "至少一条关联无法完成核对",
        schema: reportPayload,
        exitCode: 1,
        text: ({ report }) => text.lines(formatReport(report as CheckReport)),
      },
    },
  },
  failures: {
    maintenanceFailed: {
      description: "配置加载或维护操作失败",
      schema: failurePayload,
      exitCode: 1,
      text: ({ code, message }) => text.lines([`维护失败（${code}）`, message]),
    },
  },
  async handler({ input, outcome }) {
    try {
      const report = await check(input.config, inputScope(input));
      const hasErrors = report.bindings.some((binding) => "errors" in binding);
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

const updateCommand = define.command("update")({
  kind: "command",
  parent: "baseline",
  name: "update",
  description: "重新采集并显式更新基线",
  fields: {
    config: {
      kind: "valueOption",
      longOption: "--config",
      description: "显式选择 ESM 配置入口",
    },
    binding: {
      kind: "repeatableOption",
      longOption: "--binding",
      description: "选择关联 ID，可重复提供",
    },
    reference: {
      kind: "repeatableOption",
      longOption: "--reference",
      description: "选择引用 ID，可重复提供",
    },
    file: {
      kind: "repeatableOption",
      longOption: "--file",
      description: "选择直接目标文件，可重复提供",
    },
  },
  input: z.object({
    config: z.string().min(1),
    binding: z.array(z.string().min(1)).optional(),
    reference: z.array(z.string().min(1)).optional(),
    file: z.array(z.string().min(1)).optional(),
  }),
  success: {
    kind: "data",
    variants: {
      updated: {
        description: "基线已更新",
        schema: reportPayload,
        exitCode: 0,
        text: ({ report }) => text.lines(formatReport(report as CheckReport)),
      },
      rejected: {
        description: "当前证据或更新范围不允许保存基线",
        schema: rejectedUpdatePayload,
        exitCode: 1,
        text: ({ report, errors }) =>
          text.lines(
            formatRejectedUpdate(
              report as CheckReport,
              errors as BaselineUpdateIssue[],
            ),
          ),
      },
    },
  },
  failures: {
    maintenanceFailed: {
      description: "配置加载、核对或保存失败",
      schema: failurePayload,
      exitCode: 1,
      text: ({ code, message }) => text.lines([`维护失败（${code}）`, message]),
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

export const cli = define({
  root: "dock",
  help: helpCapability({
    shortAlias: "-h",
    headings: {
      usage: "用法",
      commands: "命令",
      arguments: "参数",
      options: "选项",
    },
    wording: {
      commandPlaceholder: "命令",
      choices: "（候选：{choices}）",
      default: "（默认：{value}）",
      countExactly: "{fields} 恰好出现 {count} 项",
      countAtLeast: "{fields} 至少出现 {min} 项",
      countAtMost: "{fields} 至多出现 {max} 项",
      countBetween: "{fields} 出现 {min} 到 {max} 项",
      whenOnMatch: "当全部满足 {facts} 时，{onMatch}",
      whenOtherwise: "当不满足 {facts} 时，{otherwise}",
      whenOnMatchOtherwise:
        "当全部满足 {facts} 时，{onMatch}；否则 {otherwise}",
      require: "必须提供 {fields}",
      forbid: "不得提供 {fields}",
      present: "必须提供 {field}",
      equals: "{field} 必须等于 {value}",
      forbiddenCombination: "不得同时满足 {facts}",
    },
  }),
  output: outputCapability({
    defaultFormat: "text",
    compatibilityFlags: { "--json": "structured" },
  }),
  version: versionCapability({
    value: text.line(
      (
        JSON.parse(
          readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ) as { version: string }
      ).version,
    ),
    description: "显示安装版本",
  }),
  usageFailureExitCode: 64,
  commands: {
    dock: {
      kind: "rootGroup",
      name: "dock",
      description: "显式检查并维护已登记的关联基线",
    },
    baseline: {
      kind: "commandGroup",
      parent: "dock",
      name: "baseline",
      description: "基线维护命令",
    },
    ...inspectCommand,
    ...checkCommand,
    ...updateCommand,
  },
});

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
    `范围：${report.scope.length === 0 ? "无关联" : report.scope.join("、")}`,
  ];
  for (const diagnostic of report.pluginDiagnostics) {
    for (const line of diagnostic.text) {
      lines.push(`插件 ${diagnostic.pluginId}：${line}`);
    }
  }
  for (const error of report.pluginErrors) {
    lines.push(
      `插件 ${error.pluginId} 错误（${error.code}）：${error.message}`,
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
    `根目录：${resolution.root}`,
    `基线：${resolution.baselinePath}`,
    `基线状态：${context.baseline === undefined ? "尚未创建" : "已读取"}`,
    `检查范围：${scope.length === 0 ? "无关联" : scope.join("、")}`,
    `插件：${resolution.plugins.length === 0 ? "无" : resolution.plugins.map(({ id }) => id).join("、")}`,
  ];
  if (resolution.configPath !== undefined) {
    lines.unshift(`配置入口：${resolution.configPath}`);
  }
  for (const reference of context.references) {
    lines.push(`引用声明 ${reference.id}：${JSON.stringify(reference)}`);
  }
  for (const binding of context.bindings) {
    lines.push(`关联声明 ${binding.id}：${JSON.stringify(binding)}`);
  }
  for (const plugin of resolution.plugins) {
    lines.push(
      `插件 ${plugin.id}：完整声明引用 ${plugin.references.length === 0 ? "无" : plugin.references.join("、")}；本次选中 ${plugin.selectedReferences.length === 0 ? "无" : plugin.selectedReferences.join("、")}`,
    );
    if (plugin.description !== undefined) {
      lines.push(...plugin.description.text);
    }
  }
  for (const file of resolution.files) {
    lines.push(`目标文件 ${file.path}：${file.references.join("、")}`);
  }
  for (const source of resolution.declarationSources.config) {
    lines.push(`配置来源：${source}`);
  }
  for (const [id, sources] of Object.entries(
    resolution.declarationSources.bindings,
  )) {
    for (const source of sources) {
      lines.push(`关联 ${id} 的声明来源：${source}`);
    }
  }
  for (const [id, sources] of Object.entries(
    resolution.declarationSources.references,
  )) {
    for (const source of sources) {
      lines.push(`引用 ${id} 的声明来源：${source}`);
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
      `更新错误${identity === "" ? "" : ` ${identity}`}（${error.code}）${formatRange(error.range)}：${error.message}`,
    );
  }
  return lines;
}

function formatBinding(binding: BindingCheckResult): string[] {
  const lines = [`关联 ${binding.bindingId}`];
  if ("errors" in binding) {
    for (const error of binding.errors) {
      const identity = [error.referenceId, error.memberId]
        .filter(Boolean)
        .join(" / ");
      lines.push(
        `错误${identity === "" ? "" : ` ${identity}`}（${error.code}）${formatRange(error.range)}：${error.message}`,
      );
    }
    return lines;
  }
  if ("current" in binding) {
    for (const reference of Object.values(binding.current.references)) {
      const fileInfo = referenceFileInfo(reference.definition.target);
      const file = fileInfo === undefined ? "" : `，文件 ${fileInfo}`;
      lines.push(`引用 ${reference.definition.id}${file}`);
      lines.push(`当前事实：${JSON.stringify(reference.value)}`);
      if (reference.range !== undefined) {
        lines.push(
          `位置 ${reference.range.path}（文本偏移 ${reference.range.start}–${reference.range.end}）`,
        );
      }
    }
  }
  if (binding.changes.length === 0) {
    lines.push("与基线一致。");
  } else {
    for (const change of binding.changes) {
      lines.push(`变化：${describeChange(change)}`);
    }
  }
  return lines;
}

function formatRange(range: TextRange | undefined): string {
  return range === undefined
    ? ""
    : `（${range.path}，文本偏移 ${range.start}–${range.end}）`;
}

function describeChange(change: BindingCheckResult["changes"][number]): string {
  if (change.kind === "fact" && "before" in change) {
    return `${change.referenceId} 事实：旧值 ${JSON.stringify(change.before)}；新值 ${JSON.stringify(change.after)}`;
  }
  if (change.kind === "fact") {
    return `${change.referenceId} 成员事实：${JSON.stringify(change.memberChanges)}`;
  }
  if (change.kind === "binding-definition") {
    return `关联定义：旧值 ${JSON.stringify(change.before)}；新值 ${JSON.stringify(change.after)}`;
  }
  if (change.kind === "reference-definition") {
    return `引用 ${change.referenceId} 定义变化${formatDefinitionLocations(change.before, change.after)}`;
  }
  return JSON.stringify(change);
}

function formatDefinitionLocations(before: unknown, after: unknown): string {
  const beforeFile = definitionFileInfo(before);
  const afterFile = definitionFileInfo(after);
  if (beforeFile !== undefined && afterFile !== undefined) {
    return beforeFile === afterFile
      ? `（目标文件 ${afterFile}）`
      : `：旧目标文件 ${beforeFile}；新目标文件 ${afterFile}`;
  }
  if (beforeFile !== undefined) return `：旧目标文件 ${beforeFile}`;
  if (afterFile !== undefined) return `：新目标文件 ${afterFile}`;
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
