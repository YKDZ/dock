import { copyJsonValue, type JsonValue } from "@ykdz/dock-core";

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

/** 已接纳的值归本次操作所有，插件与调用方不能再改写它。 */
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
    throw new TypeError("插件说明必须只包含 data 与 text。");
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
    throw new TypeError("插件说明不能包含访问器属性。");
  }
  const ownedData = copyJsonValue(data.value);
  const ownedText = copyJsonValue(text.value);
  if (!Array.isArray(ownedText) || !ownedText.every(isString)) {
    throw new TypeError("插件说明 text 必须是字符串数组。");
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
