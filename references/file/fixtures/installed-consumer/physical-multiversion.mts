import {
  binding,
  check,
  createReference,
  defineConfig,
  updateBaseline,
} from "@ykdz/dock";

import {
  makeBinding,
  physicalPlugin,
  physicalPluginId,
  readCollectionCount,
  resetCollectionCount,
  sharedReference,
  type PhysicalTarget,
  type PhysicalValue,
} from "./secondary/physical-author.mts";

const primarySharedReference = createReference<
  typeof physicalPluginId,
  "shared-reference",
  PhysicalTarget,
  PhysicalValue
>(
  physicalPluginId,
  "shared-reference",
  { path: "shared.json" },
  {
    declaredAt: "primary-author.mts",
  },
);
const primaryReference = createReference<
  typeof physicalPluginId,
  "primary-reference",
  PhysicalTarget,
  PhysicalValue
>(physicalPluginId, "primary-reference", { path: "primary.json" });

const config = defineConfig({
  plugins: [physicalPlugin],
  bindings: [
    makeBinding("secondary-policy", [sharedReference, primaryReference]),
    binding("primary-policy", [primarySharedReference]),
  ],
  baseline: "physical-multiversion.baseline.json",
});

resetCollectionCount();
const updated = await updateBaseline(config);
assert(updated.status === "updated", "同版本多实例基线应成功。");
assert(readCollectionCount() === 2, "共享引用每次维护只采集一次。");
const current = await check(config);
assert(readCollectionCount() === 4, "下一次维护重新采集当前事实。");
assert(
  current.bindings.every((result) => result.consistency === "consistent"),
  "同版本多实例当前报告应一致。",
);

const conflictingReference = createReference<
  typeof physicalPluginId,
  "shared-reference",
  PhysicalTarget,
  PhysicalValue
>(physicalPluginId, "shared-reference", { path: "different.json" });
let conflict: unknown;
try {
  defineConfig({
    plugins: [physicalPlugin],
    bindings: [
      makeBinding("first-policy", [sharedReference]),
      binding("second-policy", [conflictingReference]),
    ],
  });
} catch (error) {
  conflict = error;
}
assert(
  conflict instanceof Error &&
    /引用身份 shared-reference 对应多个不同定义/.test(conflict.message),
  "冲突定义应在配置组装时拒绝。",
);
assert(readCollectionCount() === 4, "冲突必须在任何采集前拒绝。");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
