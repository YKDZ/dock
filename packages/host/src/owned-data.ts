import { copyJsonValue, type JsonValue } from "@dock/core";

import type { PluginInformation, Reference } from "./contracts.ts";

export function ownReference(reference: Reference): Reference {
  return Object.freeze({
    ...reference,
    target: ownJsonValue(reference.target),
    ...(reference.selection === undefined
      ? {}
      : { selection: ownJsonValue(reference.selection) }),
    ...(reference.declaredAt instanceof URL
      ? { declaredAt: reference.declaredAt.href }
      : {}),
  });
}

/** Accepted values belong exclusively to the current operation; plugins and callers cannot mutate them afterwards. */
export function ownJsonValue<Value extends JsonValue>(value: Value): Value {
  const owned = copyJsonValue(value);
  freeze(owned);
  return owned as Value;
}

export function ownPluginInformation(value: unknown): PluginInformation {
  if (
    !isPlainRecord(value) ||
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.getOwnPropertyNames(value).length !== 2
  ) {
    throw new TypeError("Plugin information must contain only data and text.");
  }
  const data = Object.getOwnPropertyDescriptor(value, "data");
  const text = Object.getOwnPropertyDescriptor(value, "text");
  if (
    data === undefined ||
    !data.enumerable ||
    !("value" in data) ||
    text === undefined ||
    !text.enumerable ||
    !("value" in text)
  ) {
    throw new TypeError(
      "Plugin information cannot contain accessor properties.",
    );
  }
  const ownedData = copyJsonValue(data.value);
  const ownedText = copyJsonValue(text.value);
  if (!Array.isArray(ownedText) || !ownedText.every(isString)) {
    throw new TypeError("Plugin information text must be a string array.");
  }
  freeze(ownedData);
  freeze(ownedText);
  return Object.freeze({ data: ownedData, text: ownedText });
}

function freeze(value: JsonValue): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function isString(value: JsonValue): value is string {
  return typeof value === "string";
}
