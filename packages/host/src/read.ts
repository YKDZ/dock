import {
  copyJsonValue,
  isJsonValue,
  type JsonValue,
  type TextRange,
} from "@ykdz/dock-core";

import type {
  Config,
  PluginContext,
  PluginReadResult,
  ReadableReferenceOf,
  Reference,
  ReferencePlugin,
  ReferenceValue,
} from "./contracts.ts";
import { MaintenanceError } from "./errors.ts";
import { ownReference } from "./owned-data.ts";
import { prepareConfig } from "./resolution.ts";

type RuntimePlugin = {
  readonly id?: unknown;
  readonly validate?: unknown;
  readonly read?: unknown;
};

type RuntimeReader = (reference: Reference, context: PluginContext) => unknown;

/** 读取给定引用的当前选定值，不要求引用属于配置中的关联。 */
export async function readReference<
  const Plugins extends readonly ReferencePlugin[],
  const Ref extends ReadableReferenceOf<Plugins>,
>(
  config: Config<Plugins>,
  reference: Ref,
): Promise<PluginReadResult<ReferenceValue<Ref>>> {
  assertReference(reference);
  const ownedReference = ownReference(reference);
  const prepared = prepareConfig(config, process.cwd());
  const candidate = prepared.plugins.get(reference.pluginId) as
    | RuntimePlugin
    | undefined;
  if (candidate === undefined) {
    throw new MaintenanceError(
      "plugin-not-registered",
      `引用 ${reference.id} 的插件未登记：${reference.pluginId}`,
    );
  }
  if (typeof candidate.read !== "function") {
    throw new MaintenanceError(
      "reference-not-readable",
      `引用 ${reference.id} 的插件 ${reference.pluginId} 不支持读取。`,
    );
  }

  const reader = candidate.read as RuntimeReader;
  try {
    if (typeof candidate.validate === "function") {
      candidate.validate(ownedReference);
    }
    const result = await reader(ownedReference, { root: prepared.root });
    return validateReadResult<ReferenceValue<Ref>>(reference.id, result);
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    const code = readErrorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    throw new MaintenanceError(
      code,
      `无法读取引用 ${reference.id}：${message}`,
      { cause: error },
    );
  }
}

function assertReference(value: unknown): asserts value is Reference {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.pluginId !== "string" ||
    value.pluginId.length === 0 ||
    !Object.hasOwn(value, "target") ||
    !isJsonValue(value.target) ||
    (value.selection !== undefined && !isJsonValue(value.selection))
  ) {
    throw new MaintenanceError(
      "invalid-reference",
      "读取目标必须是有效的引用声明。",
    );
  }
}

function validateReadResult<Value extends JsonValue>(
  referenceId: string,
  value: unknown,
): PluginReadResult<Value> {
  if (
    !isRecord(value) ||
    !Object.hasOwn(value, "value") ||
    !isJsonValue(value.value) ||
    Object.keys(value).some((key) => key !== "value" && key !== "range") ||
    (value.range !== undefined && !isTextRange(value.range))
  ) {
    throw new MaintenanceError(
      "invalid-plugin-read-result",
      `插件对引用 ${referenceId} 返回了无效读取结果。`,
    );
  }

  return {
    value: copyJsonValue(value.value) as Value,
    ...(value.range === undefined ? {} : { range: { ...value.range } }),
  };
}

function isTextRange(value: unknown): value is TextRange {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    Number.isInteger(value.start) &&
    Number.isInteger(value.end) &&
    value.start >= 0 &&
    value.end >= value.start &&
    Object.keys(value).length === 3
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "reference-read-failed";
}
