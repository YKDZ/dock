import { assertBaseline } from "./contracts.ts";
import type {
  AcceptanceIssue,
  AcceptanceOutcome,
  BindingAudit,
  BindingBaseline,
  CheckReport,
  AcceptedReferenceFact,
  Baseline,
} from "./contracts.ts";

/** 仅在显式选择的全部关联都具有有效证据时创建新基线。 */
export function accept(
  report: CheckReport,
  baseline: Baseline | undefined,
  bindingIds: readonly string[],
): AcceptanceOutcome {
  assertBaseline(baseline);
  const errors: AcceptanceIssue[] = [];
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
    const item = report.bindings.find(
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
    if ("errors" in item) {
      errors.push(...item.errors.map((error) => ({ bindingId, ...error })));
      continue;
    }
    selected.push(item);
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
