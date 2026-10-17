import { isJsonValue, type JsonValue } from "./json-value.ts";

export type { JsonValue } from "./json-value.ts";

/** 当前文本位置用于解释结果，不参与事实比较。 */
export type TextRange = { path: string; start: number; end: number };

/** 定位目标及选择规则与当前取得的值分别比较。 */
export type ReferenceDefinition = {
  id: string;
  target: JsonValue;
  selection?: JsonValue;
  note?: string;
};

/** 无方向的非空引用集合，每条引用都是取得一致性结果的必需条件。 */
export type BindingDefinition = {
  id: string;
  references: string[];
  note?: string;
};

/** 声明集合表示全部已登记关联，或仅表示本次提供的局部子集。 */
export type DeclarationCompleteness = "complete" | "partial";

/** 成员发现是否包含引用目标中的全部成员。 */
export type MemberDiscoveryCompleteness = "complete" | "partial";

export type ReferenceResult =
  | { referenceId: string; value: JsonValue; range?: TextRange }
  | {
      referenceId: string;
      collection: {
        completeness: MemberDiscoveryCompleteness;
        members: ReferenceMemberResult[];
      };
      range?: TextRange;
    }
  | {
      referenceId: string;
      error: { code: string; message: string };
      range?: TextRange;
    };

/** 成员由适配器提供稳定身份；结果值保留其内部数组顺序。 */
export type ReferenceMemberResult =
  | { id: string; value: JsonValue }
  | { id: string; error: { code: string; message: string } };

export type BaselineReferenceFact = {
  definition: ReferenceDefinition;
  value: JsonValue;
  /** 缺省表示一般 JSON 事实；成员集合用此标记区别同形标量值。 */
  valueKind?: "member-collection";
};
export type BindingBaseline = {
  definition: BindingDefinition;
  references: Record<string, BaselineReferenceFact>;
};
export type Baseline = {
  version: 2;
  bindings: Record<string, BindingBaseline>;
};

export type CurrentReferenceFact = BaselineReferenceFact & {
  range?: TextRange;
};
export type CurrentBinding = {
  definition: BindingDefinition;
  references: Record<string, CurrentReferenceFact>;
};

export type CollectionMemberChange = {
  memberId: string;
  beforePresent: boolean;
  afterPresent: boolean;
  before?: JsonValue;
  after?: JsonValue;
};

export type BindingChange =
  | { kind: "binding-added" }
  | { kind: "binding-removed"; before: BindingDefinition }
  | {
      kind: "binding-definition";
      before: BindingDefinition;
      after: BindingDefinition;
    }
  | { kind: "reference-added"; referenceId: string }
  | { kind: "reference-removed"; referenceId: string }
  | {
      kind: "reference-definition";
      referenceId: string;
      before: ReferenceDefinition;
      after: ReferenceDefinition;
    }
  | {
      kind: "fact";
      referenceId: string;
      before: JsonValue;
      after: JsonValue;
      beforeKind?: "member-collection";
      afterKind?: "member-collection";
    }
  | {
      kind: "fact";
      referenceId: string;
      memberChanges: CollectionMemberChange[];
      beforeKind?: "member-collection";
      afterKind?: "member-collection";
    };

export type CheckError = {
  referenceId?: string;
  memberId?: string;
  code: string;
  message: string;
  range?: TextRange;
};
type BindingCheckResultBase = { bindingId: string; changes: BindingChange[] };
export type BindingCheckResult =
  | (BindingCheckResultBase & {
      consistency: "consistent" | "inconsistent";
      current: CurrentBinding;
      errors?: never;
    })
  | (BindingCheckResultBase & {
      errors: CheckError[];
      consistency?: never;
      current?: never;
      untracked?: never;
    })
  | (BindingCheckResultBase & {
      untracked: true;
      consistency: "inconsistent";
      changes: [{ kind: "binding-removed"; before: BindingDefinition }];
      current?: never;
      errors?: never;
    });

/** 核对前已经确定的声明、历史状态与检查范围。 */
export type CheckContext = {
  references: ReferenceDefinition[];
  bindings: BindingDefinition[];
  baseline?: Baseline;
  declarationCompleteness?: DeclarationCompleteness;
  scope?: readonly string[];
};
export type CheckInput = CheckContext & { facts: ReferenceResult[] };
export type CheckReport = {
  declaration: {
    completeness: DeclarationCompleteness;
    bindingIds: string[];
  };
  scope: string[];
  bindings: BindingCheckResult[];
};

export type BaselineUpdateIssue = CheckError & { bindingId?: string };
export type BaselineUpdateOutcome =
  | { status: "updated"; baseline: Baseline; report: CheckReport }
  | { status: "rejected"; errors: BaselineUpdateIssue[]; report: CheckReport };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertMemberCollectionValue(
  value: unknown,
  referenceId: string,
): void {
  if (!Array.isArray(value)) {
    throw new TypeError(`引用 ${referenceId} 的成员集合基线必须是数组。`);
  }
  const memberIds = new Set<string>();
  for (const member of value) {
    if (
      !isRecord(member) ||
      Object.keys(member).length !== 2 ||
      !Object.hasOwn(member, "id") ||
      !Object.hasOwn(member, "value")
    ) {
      throw new TypeError(`引用 ${referenceId} 的成员集合基线记录无效。`);
    }
    assertId(member.id, `引用 ${referenceId} 的成员 ID`);
    if (memberIds.has(member.id)) {
      throw new TypeError(`引用 ${referenceId} 的成员集合基线 ID 重复。`);
    }
    if (!isJsonValue(member.value)) {
      throw new TypeError(`引用 ${referenceId} 的成员集合基线值无效。`);
    }
    memberIds.add(member.id);
  }
}

function assertId(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${context} 必须是非空文本。`);
  }
}

function assertReferenceIds(
  ids: unknown,
  bindingId: string,
): asserts ids is string[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new TypeError(`关联 ${bindingId} 的引用集合不能为空。`);
  }
  const seen = new Set<string>();
  for (const id of ids) {
    assertId(id, `关联 ${bindingId} 的引用 ID`);
    if (seen.has(id))
      throw new TypeError(`关联 ${bindingId} 的引用集合包含重复身份：${id}`);
    seen.add(id);
  }
}

export function assertBindingDefinition(
  value: unknown,
): asserts value is BindingDefinition {
  if (!isRecord(value)) throw new TypeError("关联定义必须是对象。");
  assertId(value.id, "关联 ID");
  assertReferenceIds(value.references, value.id);
  if (value.note !== undefined && typeof value.note !== "string") {
    throw new TypeError(`关联 ${value.id} 的 note 必须是文本。`);
  }
}

export function assertReferenceDefinition(
  value: unknown,
): asserts value is ReferenceDefinition {
  if (!isRecord(value)) throw new TypeError("引用定义必须是对象。");
  assertId(value.id, "引用 ID");
  if (!Object.hasOwn(value, "target"))
    throw new TypeError(`引用 ${value.id} 缺少 target。`);
  if (!isJsonValue(value.target)) {
    throw new TypeError(`引用 ${value.id} 的 target 必须是有效 JSON 值。`);
  }
  if (value.selection !== undefined && !isJsonValue(value.selection)) {
    throw new TypeError(`引用 ${value.id} 的 selection 必须是有效 JSON 值。`);
  }
  if (value.note !== undefined && typeof value.note !== "string") {
    throw new TypeError(`引用 ${value.id} 的 note 必须是文本。`);
  }
}

export function assertBaseline(value: Baseline | undefined): void {
  if (value === undefined) return;
  if (!isRecord(value) || !isRecord(value.bindings)) {
    throw new TypeError("基线格式无效。");
  }
  if (value.version !== 2) {
    throw new TypeError(
      `不支持基线版本 ${String(value.version)}，需要版本 2。`,
    );
  }
  for (const [id, binding] of Object.entries(value.bindings)) {
    if (!isRecord(binding) || !isRecord(binding.references)) {
      throw new TypeError(`关联 ${id} 的基线格式无效。`);
    }
    assertBindingDefinition(binding.definition);
    if (binding.definition.id !== id)
      throw new TypeError(`关联 ${id} 的基线 ID 不匹配。`);

    const required = new Set(binding.definition.references);
    const actual = Object.keys(binding.references);
    if (
      actual.length !== required.size ||
      actual.some((referenceId) => !required.has(referenceId))
    ) {
      throw new TypeError(`关联 ${id} 的基线没有保存全部必需引用。`);
    }
    for (const [referenceId, reference] of Object.entries(binding.references)) {
      if (!isRecord(reference))
        throw new TypeError(`引用 ${referenceId} 的基线格式无效。`);
      assertReferenceDefinition(reference.definition);
      if (
        reference.definition.id !== referenceId ||
        !Object.hasOwn(reference, "value") ||
        !isJsonValue(reference.value) ||
        (reference.valueKind !== undefined &&
          reference.valueKind !== "member-collection")
      ) {
        throw new TypeError(`引用 ${referenceId} 的基线记录无效。`);
      }
      if (reference.valueKind === "member-collection") {
        assertMemberCollectionValue(reference.value, referenceId);
      }
    }
  }
}
