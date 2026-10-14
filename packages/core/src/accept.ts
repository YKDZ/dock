import { assertBaseline } from "./contracts.ts";
import type {
  AcceptanceIssue,
  AcceptanceOutcome,
  BindingAudit,
  BindingBaseline,
  CheckReport,
  AcceptedReferenceFact,
  Baseline,
  CurrentBinding,
  JsonValue,
  ReferenceDefinition,
} from "./contracts.ts";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function comparableReference(definition: ReferenceDefinition): JsonValue {
  return {
    id: definition.id,
    target: definition.target,
    ...(definition.selection === undefined
      ? {}
      : { selection: definition.selection }),
  };
}

function comparableBinding(binding: CurrentBinding): JsonValue {
  const references: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const [referenceId, fact] of Object.entries(binding.references)) {
    references[referenceId] = {
      definition: comparableReference(fact.definition),
      value: fact.value,
    };
  }
  return {
    definition: {
      id: binding.definition.id,
      documents: [...binding.definition.documents].sort(),
      references: [...binding.definition.references].sort(),
    },
    references,
  };
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function sameReviewedState(left: BindingAudit, right: BindingAudit): boolean {
  if (left.bindingId !== right.bindingId) return false;
  if ("untracked" in left || "untracked" in right) {
    if (!("untracked" in left) || !("untracked" in right)) return false;
    const leftRemoval = left.changes[0];
    const rightRemoval = right.changes[0];
    return (
      leftRemoval?.kind === "binding-removed" &&
      rightRemoval?.kind === "binding-removed" &&
      same(leftRemoval.before, rightRemoval.before)
    );
  }
  if ("errors" in left || "errors" in right) return false;
  return same(
    comparableBinding(left.current),
    comparableBinding(right.current),
  );
}

/** 仅在显式选择的全部关联都具有有效证据时创建新基线。 */
export function accept(
  reviewed: CheckReport,
  baseline: Baseline | undefined,
  bindingIds: readonly string[],
  current: CheckReport,
): AcceptanceOutcome {
  assertBaseline(baseline);
  const errors: AcceptanceIssue[] = [];
  const expectedBaseline = baseline ?? null;
  if (!same(reviewed.reviewedBaseline, expectedBaseline)) {
    errors.push({
      code: "reviewed-baseline-changed",
      message: "审阅报告依据的基线已变化，请重新核对并阅读当前报告。",
    });
  }
  if (!same(current.reviewedBaseline, expectedBaseline)) {
    errors.push({
      code: "current-baseline-changed",
      message: "当前核对使用的基线与待更新基线不一致。",
    });
  }
  if (bindingIds.length === 0)
    errors.push({
      code: "empty-selection",
      message: "必须明确选择至少一条关联。",
    });
  if (new Set(bindingIds).size !== bindingIds.length) {
    errors.push({
      code: "duplicate-selection",
      message: "接受范围不能重复选择关联。",
    });
  }

  const selected: BindingAudit[] = [];
  for (const bindingId of bindingIds) {
    const item = reviewed.bindings.find(
      (candidate) => candidate.bindingId === bindingId,
    );
    const freshMatches = current.bindings.filter(
      (candidate) => candidate.bindingId === bindingId,
    );
    if (!item) {
      errors.push({
        bindingId,
        code: "missing-review",
        message: "本次核对没有该关联的结果。",
      });
      continue;
    }
    if (freshMatches.length !== 1) {
      errors.push({
        bindingId,
        code: "missing-current-review",
        message: "接受前未取得该关联唯一的当前核对结果，请重新核对。",
      });
      continue;
    }
    const fresh = freshMatches[0]!;
    if ("errors" in fresh) {
      errors.push(...fresh.errors.map((error) => ({ bindingId, ...error })));
      continue;
    }
    if ("errors" in item) {
      errors.push({
        bindingId,
        code: "stale-review",
        message: "已审阅报告含核对错误；请修复来源、重新核对并阅读新报告。",
      });
      continue;
    }
    if (!sameReviewedState(item, fresh)) {
      errors.push({
        bindingId,
        code: "stale-review",
        message: "来源状态与已审阅报告不同；请重新核对、阅读当前差异后再接受。",
      });
      continue;
    }
    selected.push(fresh);
  }

  if (errors.length) return { status: "rejected", errors };

  const nextBindings: Record<string, BindingBaseline> = Object.assign(
    Object.create(null) as Record<string, BindingBaseline>,
    structuredClone(baseline?.bindings ?? {}),
  );
  for (const item of selected) {
    if ("untracked" in item) {
      delete nextBindings[item.bindingId];
      continue;
    }
    if (!("current" in item)) continue;
    const references: Record<string, AcceptedReferenceFact> = Object.create(
      null,
    ) as Record<string, AcceptedReferenceFact>;
    for (const [referenceId, fact] of Object.entries(item.current.references)) {
      references[referenceId] = {
        definition: structuredClone(fact.definition),
        value: structuredClone(fact.value),
      };
    }
    nextBindings[item.bindingId] = {
      definition: structuredClone(item.current.definition),
      references,
    };
  }

  return {
    status: "accepted",
    baseline: { version: 1, bindings: nextBindings },
  };
}
