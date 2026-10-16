import type { BaselineUpdateIssue, BindingCheckResult } from "@dock/core";
import {
  defineCli,
  helpCapability,
  outputCapability,
  text,
} from "@ykdz/cli-contract";
import { z } from "zod";

import { check, MaintenanceError, updateBaseline } from "./maintenance.ts";
import type { CheckReport } from "./maintenance.ts";

const define = defineCli();
const reportPayload = z.object({ report: z.unknown() });
const updateIssueSchema = z.object({
  bindingId: z.string().optional(),
  referenceId: z.string().optional(),
  memberId: z.string().optional(),
  code: z.string(),
  message: z.string(),
});
const rejectedUpdatePayload = z.object({
  report: z.unknown(),
  errors: z.array(updateIssueSchema),
});
const failurePayload = z.object({ code: z.string(), message: z.string() });

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
  },
  input: z.object({ config: z.string().min(1) }),
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
      const report = await check(input.config);
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
  },
  input: z.object({ config: z.string().min(1) }),
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
      const result = await updateBaseline(input.config);
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

function formatReport(report: CheckReport): [string, ...string[]] {
  const lines = [
    `范围：${report.scope.length === 0 ? "无关联" : report.scope.join("、")}`,
  ];
  if (report.execution !== undefined) {
    lines.push(
      `执行：${report.execution.testExecutions} 次测试尝试，${report.execution.commandAttempts} 次命令尝试`,
    );
    if (report.execution.failedCommands > 0) {
      lines.push(`原生命令失败：${report.execution.failedCommands} 次`);
    }
    for (const read of report.execution.reads ?? []) {
      const range =
        read.range === undefined
          ? ""
          : `，范围 ${read.range.path}:${read.range.start}-${read.range.end}`;
      lines.push(
        `测试内读取 ${read.referenceId}（运行 ${read.runId} / 测试 ${read.testId}）：${JSON.stringify(read.value)}${range}`,
      );
    }
  }
  for (const binding of report.bindings) {
    lines.push(...formatBinding(binding));
  }
  return lines as [string, ...string[]];
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
      `更新错误${identity === "" ? "" : ` ${identity}`}（${error.code}）：${error.message}`,
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
        `错误${identity === "" ? "" : ` ${identity}`}（${error.code}）：${error.message}`,
      );
    }
    return lines;
  }
  if ("current" in binding) {
    for (const reference of Object.values(binding.current.references)) {
      lines.push(
        `引用 ${reference.definition.id}，目标 ${JSON.stringify(reference.definition.target)}`,
      );
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
    return `引用 ${change.referenceId} 定义：旧值 ${JSON.stringify(change.before)}；新值 ${JSON.stringify(change.after)}`;
  }
  return JSON.stringify(change);
}
