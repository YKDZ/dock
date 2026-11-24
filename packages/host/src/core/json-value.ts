/** JSON-shaped facts allow plugins to preserve explicit selections without adding runtime dependencies. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** All comparable values share pure-data rules; validation never evaluates accessors or conversion methods. */
export function isJsonValue(value: unknown): value is JsonValue {
  try {
    assertJsonValue(value);
    return true;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

/** Validates pure JSON data in a single zero-copy traversal without invoking accessors. */
export function assertJsonValue(value: unknown): asserts value is JsonValue {
  validate(value, new Set());
}

/** Accepts pure data and produces an independent copy; special properties and cycles fail explicitly. */
export function copyJsonValue(value: unknown): JsonValue {
  return copy(value, new Set());
}

/** Object key order is ignored, plain arrays are ordered, and 0/-0 share JSON encoding. */
export function canonicalJson(value: JsonValue): string {
  return encode(value, new Set());
}

function validate(value: unknown, active: Set<object>): void {
  if (value === null || typeof value !== "object") {
    validatePrimitive(value);
    return;
  }
  const container = inspectContainer(value, active);
  active.add(value);
  try {
    if (container.array) {
      for (let index = 0; index < container.length; index++) {
        validate(ownDataDescriptorValue(value, String(index), true), active);
      }
      return;
    }
    for (const key of container.keys) {
      validate(ownDataDescriptorValue(value, key, false), active);
    }
  } finally {
    active.delete(value);
  }
}

function copy(value: unknown, active: Set<object>): JsonValue {
  if (value === null || typeof value !== "object") {
    return validatePrimitive(value);
  }
  const container = inspectContainer(value, active);
  active.add(value);
  try {
    if (container.array) {
      const result: JsonValue[] = [];
      for (let index = 0; index < container.length; index++) {
        result.push(
          copy(ownDataDescriptorValue(value, String(index), true), active),
        );
      }
      return result;
    }
    const result: Record<string, JsonValue> = {};
    for (const key of container.keys) {
      Object.defineProperty(result, key, {
        value: copy(ownDataDescriptorValue(value, key, false), active),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return result;
  } finally {
    active.delete(value);
  }
}

function encode(value: unknown, active: Set<object>): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(validatePrimitive(value));
  }
  const container = inspectContainer(value, active);
  active.add(value);
  try {
    if (container.array) {
      const parts: string[] = [];
      for (let index = 0; index < container.length; index++) {
        parts.push(
          encode(ownDataDescriptorValue(value, String(index), true), active),
        );
      }
      return `[${parts.join(",")}]`;
    }
    container.keys.sort();
    const parts: string[] = [];
    for (const key of container.keys) {
      parts.push(
        `${JSON.stringify(key)}:${encode(ownDataDescriptorValue(value, key, false), active)}`,
      );
    }
    return `{${parts.join(",")}}`;
  } finally {
    active.delete(value);
  }
}

function validatePrimitive(value: unknown): null | boolean | number | string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Value contains a non-finite number.");
    }
    return value;
  }
  throw invalidValue();
}

function inspectContainer(
  value: object,
  active: Set<object>,
): { array: true; length: number } | { array: false; keys: string[] } {
  if (active.has(value)) {
    throw invalidValue();
  }
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    (array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(
      array
        ? "JSON array must be dense and have no extra properties."
        : "Value must be a plain JSON object without extra properties.",
    );
  }
  const keys = Object.keys(value);
  if (
    Object.getOwnPropertyNames(value).length !==
      keys.length + (array ? 1 : 0) ||
    (array && keys.length !== (value as unknown[]).length)
  ) {
    throw new TypeError(
      array
        ? "JSON array must be dense and have no extra properties."
        : "Value must be a plain JSON object without extra properties.",
    );
  }
  return array
    ? { array: true, length: (value as unknown[]).length }
    : { array: false, keys };
}

function ownDataDescriptorValue(
  value: object,
  key: string,
  array: boolean,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    (array && !descriptor.enumerable) ||
    !("value" in descriptor)
  ) {
    throw new TypeError(
      array
        ? "JSON array cannot contain holes or accessor properties."
        : "JSON object cannot contain accessor properties.",
    );
  }
  return descriptor.value;
}

function invalidValue(): TypeError {
  return new TypeError(
    "Value must be plain JSON data without cycles or special properties.",
  );
}
