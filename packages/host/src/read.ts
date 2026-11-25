import { copyJsonValue, type JsonValue, type TextRange } from "@dock/core";

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

/** Reads the currently selected value for a reference without requiring it to belong to a binding in config. */
export async function readReference<
  const Plugins extends readonly ReferencePlugin[],
  const Ref extends ReadableReferenceOf<Plugins>,
>(
  config: Config<Plugins>,
  reference: Ref,
): Promise<PluginReadResult<ReferenceValue<Ref>>> {
  const ownedReference = acceptReadReference(reference);
  const prepared = prepareConfig(config, process.cwd());
  const candidate = prepared.plugins.get(ownedReference.pluginId) as
    | RuntimePlugin
    | undefined;
  if (candidate === undefined) {
    throw new MaintenanceError(
      "plugin-not-registered",
      `Plugin is not registered for reference ${ownedReference.id}: ${ownedReference.pluginId}`,
    );
  }
  if (typeof candidate.read !== "function") {
    throw new MaintenanceError(
      "reference-not-readable",
      `Plugin ${ownedReference.pluginId} for reference ${ownedReference.id} does not support reading.`,
    );
  }

  const reader = candidate.read as RuntimeReader;
  try {
    if (typeof candidate.validate === "function") {
      candidate.validate(ownedReference);
    }
    const result = await reader(ownedReference, { root: prepared.root });
    return validateReadResult<ReferenceValue<Ref>>(ownedReference.id, result);
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    const code = readErrorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    throw new MaintenanceError(
      code,
      `Failed to read reference ${ownedReference.id}: ${message}`,
      { cause: error },
    );
  }
}

function acceptReadReference(value: unknown): Reference {
  if (!isRecord(value)) {
    throw invalidReadTargetError();
  }
  const id = ownDataValue(value, "id");
  const pluginId = ownDataValue(value, "pluginId");
  const target = ownDataValue(value, "target");
  const selection = ownDataValue(value, "selection");
  const note = ownDataValue(value, "note");
  const declaredAt = ownDataValue(value, "declaredAt");
  const noteValue = note.status === "value" ? note.value : undefined;
  const declaredAtValue =
    declaredAt.status === "value" ? declaredAt.value : undefined;
  if (
    id.status !== "value" ||
    typeof id.value !== "string" ||
    id.value.length === 0 ||
    pluginId.status !== "value" ||
    typeof pluginId.value !== "string" ||
    pluginId.value.length === 0 ||
    target.status !== "value" ||
    selection.status === "accessor" ||
    note.status === "accessor" ||
    declaredAt.status === "accessor" ||
    (noteValue !== undefined && typeof noteValue !== "string") ||
    (declaredAtValue !== undefined &&
      typeof declaredAtValue !== "string" &&
      !(declaredAtValue instanceof URL))
  ) {
    throw invalidReadTargetError();
  }
  try {
    return ownReference({
      id: id.value,
      pluginId: pluginId.value,
      target: target.value as JsonValue,
      ...(selection.status === "value" && selection.value !== undefined
        ? { selection: selection.value as JsonValue }
        : {}),
      ...(noteValue === undefined ? {} : { note: noteValue }),
      ...(declaredAtValue === undefined ? {} : { declaredAt: declaredAtValue }),
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw invalidReadTargetError(error);
    }
    throw error;
  }
}

function invalidReadTargetError(cause?: unknown): MaintenanceError {
  return new MaintenanceError(
    "invalid-reference",
    "Read target must be a valid reference declaration.",
    cause === undefined ? undefined : { cause },
  );
}

function validateReadResult<Value extends JsonValue>(
  referenceId: string,
  value: unknown,
): PluginReadResult<Value> {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "value" && key !== "range")
  ) {
    throw invalidReadResultError(referenceId);
  }
  const fact = ownDataValue(value, "value");
  const rangeProperty = ownDataValue(value, "range");
  if (fact.status !== "value" || rangeProperty.status === "accessor") {
    throw invalidReadResultError(referenceId);
  }
  const range =
    rangeProperty.status === "value" && rangeProperty.value !== undefined
      ? copyTextRange(rangeProperty.value)
      : undefined;
  if (
    rangeProperty.status === "value" &&
    rangeProperty.value !== undefined &&
    range === undefined
  ) {
    throw invalidReadResultError(referenceId);
  }

  let copiedValue: Value;
  try {
    copiedValue = copyJsonValue(fact.value) as Value;
  } catch (error) {
    if (error instanceof TypeError) {
      throw invalidReadResultError(referenceId, error);
    }
    throw error;
  }

  return {
    value: copiedValue,
    ...(range === undefined ? {} : { range }),
  };
}

function invalidReadResultError(
  referenceId: string,
  cause?: unknown,
): MaintenanceError {
  return new MaintenanceError(
    "invalid-plugin-read-result",
    `Plugin returned an invalid read result for reference ${referenceId}.`,
    cause === undefined ? undefined : { cause },
  );
}

function copyTextRange(value: unknown): TextRange | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 3) {
    return undefined;
  }
  const path = ownDataValue(value, "path");
  const start = ownDataValue(value, "start");
  const end = ownDataValue(value, "end");
  if (
    path.status !== "value" ||
    typeof path.value !== "string" ||
    start.status !== "value" ||
    typeof start.value !== "number" ||
    !Number.isInteger(start.value) ||
    start.value < 0 ||
    end.status !== "value" ||
    typeof end.value !== "number" ||
    !Number.isInteger(end.value) ||
    end.value < start.value
  ) {
    return undefined;
  }
  return { path: path.value, start: start.value, end: end.value };
}

type OwnDataResult =
  | { readonly status: "missing" | "accessor" }
  | { readonly status: "value"; readonly value: unknown };

function ownDataValue(value: object, key: string): OwnDataResult {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return { status: "missing" };
  if (!descriptor.enumerable || !("value" in descriptor)) {
    return { status: "accessor" };
  }
  return { status: "value", value: descriptor.value };
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
