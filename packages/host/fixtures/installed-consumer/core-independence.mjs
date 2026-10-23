import assert from "node:assert/strict";

import { check, updateBaseline } from "@ykdz/dock-core";

const seed = {
  references: [{ id: "guide", target: { path: "docs/guide.md" } }],
  bindings: [{ id: "guide-policy", references: ["guide"] }],
  facts: [{ referenceId: "guide", value: { paragraphs: ["before"] } }],
};
const created = updateBaseline(seed);
assert.equal(created.status, "updated");
if (created.status !== "updated") throw new Error("无法建立核对基线。");

const checkBaseline = created.baseline;
const checkInput = {
  references: [{ id: "guide", target: { path: "docs/guide-v2.md" } }],
  bindings: [{ id: "guide-policy", references: ["guide"] }],
  facts: [{ referenceId: "guide", value: { paragraphs: ["after"] } }],
  baseline: checkBaseline,
};
const baselineBeforeCheck = JSON.stringify(checkBaseline);
const checked = check(checkInput);
assert.equal(JSON.stringify(checkBaseline), baselineBeforeCheck);
const checkedBinding = checked.bindings[0];
assert.ok(checkedBinding && "current" in checkedBinding);
if (!checkedBinding || !("current" in checkedBinding)) {
  throw new Error("核对报告缺少当前关联。");
}
const referenceChange = checkedBinding.changes.find(
  (change) => change.kind === "reference-definition",
);
const factChange = checkedBinding.changes.find(
  (change) => change.kind === "fact" && "before" in change,
);
assert.ok(referenceChange && referenceChange.kind === "reference-definition");
assert.ok(factChange && factChange.kind === "fact" && "before" in factChange);
if (
  !referenceChange ||
  referenceChange.kind !== "reference-definition" ||
  !factChange ||
  factChange.kind !== "fact" ||
  !("before" in factChange)
) {
  throw new Error("核对报告缺少旧定义或旧事实。");
}

checkInput.references[0].target.path = "input.md";
checkInput.bindings[0].references[0] = "input-reference";
checkInput.facts[0].value.paragraphs[0] = "input-fact";
assert.equal(
  checkedBinding.current.references.guide.definition.target.path,
  "docs/guide-v2.md",
);
assert.equal(
  checkedBinding.current.references.guide.value.paragraphs[0],
  "after",
);

const oldBinding = checkBaseline.bindings["guide-policy"];
assert.ok(oldBinding);
if (!oldBinding) throw new Error("已建立的关联基线缺失。");
oldBinding.definition.references[0] = "input-baseline-reference";
oldBinding.references.guide.definition.target.path = "input-baseline.md";
oldBinding.references.guide.value.paragraphs[0] = "input-baseline-fact";
assert.equal(referenceChange.before.target.path, "docs/guide.md");
assert.deepEqual(factChange.before, { paragraphs: ["before"] });
referenceChange.before.target.path = "report.md";
factChange.before.paragraphs[0] = "report-fact";
assert.equal(
  oldBinding.references.guide.definition.target.path,
  "input-baseline.md",
);
assert.equal(
  oldBinding.references.guide.value.paragraphs[0],
  "input-baseline-fact",
);

const removalBaselineResult = updateBaseline(seed);
assert.equal(removalBaselineResult.status, "updated");
if (removalBaselineResult.status !== "updated") {
  throw new Error("无法建立取消跟踪基线。");
}
const removalBaseline = removalBaselineResult.baseline;
const removal = check({
  references: [],
  bindings: [],
  facts: [],
  baseline: removalBaseline,
  declarationCompleteness: "complete",
}).bindings[0];
assert.ok(removal && "untracked" in removal && removal.untracked);
if (!removal || !("untracked" in removal) || !removal.untracked) {
  throw new Error("完整声明未保留取消跟踪说明。");
}
const removedDefinition = removal.changes[0].before;
removalBaseline.bindings["guide-policy"].definition.references[0] =
  "input-removal";
assert.equal(removedDefinition.references[0], "guide");
removedDefinition.references[0] = "report-removal";
assert.equal(
  removalBaseline.bindings["guide-policy"].definition.references[0],
  "input-removal",
);

const updateSeed = updateBaseline(seed);
assert.equal(updateSeed.status, "updated");
if (updateSeed.status !== "updated") throw new Error("无法重建更新基线。");
const updateInput = {
  references: [{ id: "guide", target: { path: "docs/guide-v2.md" } }],
  bindings: [{ id: "guide-policy", references: ["guide"] }],
  facts: [{ referenceId: "guide", value: { paragraphs: ["after"] } }],
  baseline: updateSeed.baseline,
};
const updated = updateBaseline(updateInput);
assert.equal(updated.status, "updated");
if (updated.status !== "updated") throw new Error("有效事实未更新基线。");
const updatedBinding = updated.report.bindings[0];
assert.ok(updatedBinding && "current" in updatedBinding);
if (!updatedBinding || !("current" in updatedBinding)) {
  throw new Error("更新报告缺少当前关联。");
}
const reportedReference = updatedBinding.current.references.guide;
const storedBinding = updated.baseline.bindings["guide-policy"];
assert.ok(storedBinding);
if (!storedBinding) throw new Error("更新后的关联基线缺失。");
const storedReference = storedBinding.references.guide;

updateInput.references[0].target.path = "input-update.md";
updateInput.facts[0].value.paragraphs[0] = "input-update-fact";
assert.equal(reportedReference.definition.target.path, "docs/guide-v2.md");
assert.equal(reportedReference.value.paragraphs[0], "after");
assert.equal(storedReference.definition.target.path, "docs/guide-v2.md");
assert.equal(storedReference.value.paragraphs[0], "after");

reportedReference.definition.target.path = "report-update.md";
reportedReference.value.paragraphs[0] = "report-update-fact";
assert.equal(storedReference.definition.target.path, "docs/guide-v2.md");
assert.equal(storedReference.value.paragraphs[0], "after");
storedReference.definition.target.path = "baseline-update.md";
storedReference.value.paragraphs[0] = "baseline-update-fact";
assert.equal(reportedReference.definition.target.path, "report-update.md");
assert.equal(reportedReference.value.paragraphs[0], "report-update-fact");
