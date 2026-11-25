/** 1-based line and column location with 0-based UTF-16 code unit offset in a JSON string. */
export type JsonPosition = {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
};

/** Half-open [start, end) source span for a JSON CST node or property key. */
export type JsonSpan = {
  readonly start: JsonPosition;
  readonly end: JsonPosition;
};

/** Raw property entry on an object CST node; preserves source order and duplicate keys. */
export type JsonPropertyNode = {
  readonly key: string;
  readonly rawKey: string;
  readonly keySpan: JsonSpan;
  readonly value: JsonCstNode;
  readonly span: JsonSpan;
};

/** Lossless concrete syntax tree node for strict RFC 8259 JSON documents. */
export type JsonCstNode =
  | { readonly kind: "null"; readonly value: null; readonly span: JsonSpan }
  | {
      readonly kind: "boolean";
      readonly value: boolean;
      readonly span: JsonSpan;
    }
  | {
      readonly kind: "number";
      readonly value: number;
      readonly raw: string;
      readonly span: JsonSpan;
    }
  | {
      readonly kind: "string";
      readonly value: string;
      readonly raw: string;
      readonly span: JsonSpan;
    }
  | {
      readonly kind: "array";
      readonly items: readonly JsonCstNode[];
      readonly span: JsonSpan;
    }
  | {
      readonly kind: "object";
      readonly properties: readonly JsonPropertyNode[];
      readonly span: JsonSpan;
    };

/** Plain JSON value produced from a CST node. */
export type JsonCstValue =
  | null
  | boolean
  | number
  | string
  | JsonCstValue[]
  | { [key: string]: JsonCstValue };

/** Syntax error thrown by `parseJsonDocument` with 1-based line/column and 0-based offset. */
export class JsonSyntaxError extends SyntaxError {
  readonly offset: number;
  readonly line: number;
  readonly column: number;

  constructor(message: string, position: JsonPosition) {
    super(message);
    this.name = "JsonSyntaxError";
    this.offset = position.offset;
    this.line = position.line;
    this.column = position.column;
  }
}

const MAX_JSON_DEPTH = 1024;

/** Returns false when `value` contains an unpaired UTF-16 surrogate code unit. */
export function isWellFormedJsonString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Parses a strict RFC 8259 JSON document into a lossless CST preserving duplicate keys and source spans. */
export function parseJsonDocument(source: string): JsonCstNode {
  if (typeof source !== "string") {
    throw new TypeError("JSON source must be a string.");
  }

  let offset = 0;
  let line = 1;
  let column = 1;

  function position(): JsonPosition {
    return { offset, line, column };
  }

  function skipWhitespace(): void {
    while (offset < source.length) {
      const code = source.charCodeAt(offset);
      if (code === 0x20 || code === 0x09) {
        offset += 1;
        column += 1;
      } else if (code === 0x0a) {
        offset += 1;
        line += 1;
        column = 1;
      } else if (code === 0x0d) {
        offset += source.charCodeAt(offset + 1) === 0x0a ? 2 : 1;
        line += 1;
        column = 1;
      } else {
        break;
      }
    }
  }

  function advanceSingleLineChars(count: number): void {
    offset += count;
    column += count;
  }

  function parseStringNode(): Extract<JsonCstNode, { kind: "string" }> {
    const start = position();
    // Consume opening '"'.
    advanceSingleLineChars(1);
    let value = "";
    let segmentStart = offset;

    while (offset < source.length) {
      const code = source.charCodeAt(offset);
      if (code === 0x22) {
        value += source.slice(segmentStart, offset);
        advanceSingleLineChars(1);
        return {
          kind: "string",
          value,
          raw: source.slice(start.offset, offset),
          span: { start, end: position() },
        };
      }
      if (code < 0x20) {
        throw new JsonSyntaxError(
          "Unescaped control character in JSON string.",
          position(),
        );
      }
      if (code === 0x5c) {
        value += source.slice(segmentStart, offset);
        const escapeStart = position();
        advanceSingleLineChars(1);
        if (offset >= source.length) {
          throw new JsonSyntaxError(
            "Unterminated escape sequence in JSON string.",
            escapeStart,
          );
        }
        const escaped = source.charCodeAt(offset);
        if (escaped === 0x22) {
          value += '"';
          advanceSingleLineChars(1);
        } else if (escaped === 0x5c) {
          value += "\\";
          advanceSingleLineChars(1);
        } else if (escaped === 0x2f) {
          value += "/";
          advanceSingleLineChars(1);
        } else if (escaped === 0x62) {
          value += "\b";
          advanceSingleLineChars(1);
        } else if (escaped === 0x66) {
          value += "\f";
          advanceSingleLineChars(1);
        } else if (escaped === 0x6e) {
          value += "\n";
          advanceSingleLineChars(1);
        } else if (escaped === 0x72) {
          value += "\r";
          advanceSingleLineChars(1);
        } else if (escaped === 0x74) {
          value += "\t";
          advanceSingleLineChars(1);
        } else if (escaped === 0x75) {
          const hex = source.slice(offset + 1, offset + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) {
            throw new JsonSyntaxError(
              "Invalid Unicode escape in JSON string.",
              escapeStart,
            );
          }
          value += String.fromCharCode(Number.parseInt(hex, 16));
          advanceSingleLineChars(5);
        } else {
          throw new JsonSyntaxError(
            `Invalid escape sequence in JSON string.`,
            escapeStart,
          );
        }
        segmentStart = offset;
        continue;
      }
      advanceSingleLineChars(1);
    }

    throw new JsonSyntaxError("Unterminated JSON string.", start);
  }

  function parseNumberNode(): Extract<JsonCstNode, { kind: "number" }> {
    const start = position();
    if (source.charCodeAt(offset) === 0x2d) {
      advanceSingleLineChars(1);
    }
    if (offset >= source.length) {
      throw new JsonSyntaxError("Expected digit in JSON number.", position());
    }
    const firstDigit = source.charCodeAt(offset);
    if (firstDigit === 0x30) {
      advanceSingleLineChars(1);
      const nextDigit = source.charCodeAt(offset);
      if (nextDigit >= 0x30 && nextDigit <= 0x39) {
        throw new JsonSyntaxError(
          "Leading zero is not allowed in JSON number.",
          position(),
        );
      }
    } else if (firstDigit >= 0x31 && firstDigit <= 0x39) {
      while (
        offset < source.length &&
        source.charCodeAt(offset) >= 0x30 &&
        source.charCodeAt(offset) <= 0x39
      ) {
        advanceSingleLineChars(1);
      }
    } else {
      throw new JsonSyntaxError("Expected digit in JSON number.", position());
    }

    if (source.charCodeAt(offset) === 0x2e) {
      advanceSingleLineChars(1);
      const fracStart = offset;
      while (
        offset < source.length &&
        source.charCodeAt(offset) >= 0x30 &&
        source.charCodeAt(offset) <= 0x39
      ) {
        advanceSingleLineChars(1);
      }
      if (offset === fracStart) {
        throw new JsonSyntaxError(
          "Expected digit after decimal point in JSON number.",
          position(),
        );
      }
    }

    const expChar = source.charCodeAt(offset);
    if (expChar === 0x65 || expChar === 0x45) {
      advanceSingleLineChars(1);
      const sign = source.charCodeAt(offset);
      if (sign === 0x2b || sign === 0x2d) {
        advanceSingleLineChars(1);
      }
      const expStart = offset;
      while (
        offset < source.length &&
        source.charCodeAt(offset) >= 0x30 &&
        source.charCodeAt(offset) <= 0x39
      ) {
        advanceSingleLineChars(1);
      }
      if (offset === expStart) {
        throw new JsonSyntaxError(
          "Expected digit in JSON number exponent.",
          position(),
        );
      }
    }

    const raw = source.slice(start.offset, offset);
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new JsonSyntaxError(
        "JSON number overflows finite IEEE-754 range.",
        start,
      );
    }
    return { kind: "number", value, raw, span: { start, end: position() } };
  }

  function parseLiteralNode(
    literal: "null" | "true" | "false",
  ): Extract<JsonCstNode, { kind: "null" | "boolean" }> {
    const start = position();
    if (!source.startsWith(literal, offset)) {
      throw new JsonSyntaxError(`Unexpected token in JSON input.`, start);
    }
    advanceSingleLineChars(literal.length);
    const span = { start, end: position() };
    if (literal === "null") {
      return { kind: "null", value: null, span };
    }
    return { kind: "boolean", value: literal === "true", span };
  }

  function parseArrayNode(
    depth: number,
  ): Extract<JsonCstNode, { kind: "array" }> {
    const start = position();
    advanceSingleLineChars(1);
    skipWhitespace();
    const items: JsonCstNode[] = [];

    if (source.charCodeAt(offset) === 0x5d) {
      advanceSingleLineChars(1);
      return { kind: "array", items, span: { start, end: position() } };
    }

    while (true) {
      skipWhitespace();
      items.push(parseValue(depth + 1));
      skipWhitespace();
      if (offset >= source.length) {
        throw new JsonSyntaxError("Unterminated JSON array.", position());
      }
      const sep = source.charCodeAt(offset);
      if (sep === 0x5d) {
        advanceSingleLineChars(1);
        return { kind: "array", items, span: { start, end: position() } };
      }
      if (sep !== 0x2c) {
        throw new JsonSyntaxError(
          "Expected ',' or ']' in JSON array.",
          position(),
        );
      }
      advanceSingleLineChars(1);
      skipWhitespace();
      if (source.charCodeAt(offset) === 0x5d) {
        throw new JsonSyntaxError(
          "Trailing comma is not allowed in JSON array.",
          position(),
        );
      }
    }
  }

  function parseObjectNode(
    depth: number,
  ): Extract<JsonCstNode, { kind: "object" }> {
    const start = position();
    advanceSingleLineChars(1);
    skipWhitespace();
    const properties: JsonPropertyNode[] = [];

    if (source.charCodeAt(offset) === 0x7d) {
      advanceSingleLineChars(1);
      return { kind: "object", properties, span: { start, end: position() } };
    }

    while (true) {
      skipWhitespace();
      if (source.charCodeAt(offset) !== 0x22) {
        throw new JsonSyntaxError(
          "Expected string property key in JSON object.",
          position(),
        );
      }
      const keyNode = parseStringNode();
      skipWhitespace();
      if (source.charCodeAt(offset) !== 0x3a) {
        throw new JsonSyntaxError(
          "Expected ':' after property key in JSON object.",
          position(),
        );
      }
      advanceSingleLineChars(1);
      skipWhitespace();
      const valueNode = parseValue(depth + 1);
      properties.push({
        key: keyNode.value,
        rawKey: keyNode.raw,
        keySpan: keyNode.span,
        value: valueNode,
        span: { start: keyNode.span.start, end: valueNode.span.end },
      });
      skipWhitespace();
      if (offset >= source.length) {
        throw new JsonSyntaxError("Unterminated JSON object.", position());
      }
      const sep = source.charCodeAt(offset);
      if (sep === 0x7d) {
        advanceSingleLineChars(1);
        return { kind: "object", properties, span: { start, end: position() } };
      }
      if (sep !== 0x2c) {
        throw new JsonSyntaxError(
          "Expected ',' or '}' in JSON object.",
          position(),
        );
      }
      advanceSingleLineChars(1);
      skipWhitespace();
      if (source.charCodeAt(offset) === 0x7d) {
        throw new JsonSyntaxError(
          "Trailing comma is not allowed in JSON object.",
          position(),
        );
      }
    }
  }

  function parseValue(depth: number): JsonCstNode {
    if (depth > MAX_JSON_DEPTH) {
      throw new JsonSyntaxError(
        "JSON nesting exceeds maximum supported depth.",
        position(),
      );
    }
    if (offset >= source.length) {
      throw new JsonSyntaxError("Unexpected end of JSON input.", position());
    }
    const code = source.charCodeAt(offset);
    if (code === 0x7b) return parseObjectNode(depth);
    if (code === 0x5b) return parseArrayNode(depth);
    if (code === 0x22) return parseStringNode();
    if (code === 0x74) return parseLiteralNode("true");
    if (code === 0x66) return parseLiteralNode("false");
    if (code === 0x6e) return parseLiteralNode("null");
    if (code === 0x2d || (code >= 0x30 && code <= 0x39)) {
      return parseNumberNode();
    }
    throw new JsonSyntaxError("Unexpected token in JSON input.", position());
  }

  skipWhitespace();
  if (offset >= source.length) {
    throw new JsonSyntaxError("Unexpected end of JSON input.", position());
  }
  const root = parseValue(0);
  skipWhitespace();
  if (offset < source.length) {
    throw new JsonSyntaxError(
      "Unexpected trailing content after JSON value.",
      position(),
    );
  }
  return root;
}

/** Converts a CST node to a plain `JsonCstValue`, preserving `"__proto__"` keys safely and rejecting lone surrogates. */
export function cstToJsonValue(node: JsonCstNode): JsonCstValue {
  if (
    node.kind === "null" ||
    node.kind === "boolean" ||
    node.kind === "number"
  ) {
    return node.value;
  }
  if (node.kind === "string") {
    if (!isWellFormedJsonString(node.value)) {
      throw new TypeError("JSON string contains an unpaired surrogate.");
    }
    return node.value;
  }
  if (node.kind === "array") {
    return node.items.map((item) => cstToJsonValue(item));
  }
  const result: Record<string, JsonCstValue> = {};
  for (const prop of node.properties) {
    if (!isWellFormedJsonString(prop.key)) {
      throw new TypeError("JSON property key contains an unpaired surrogate.");
    }
    Object.defineProperty(result, prop.key, {
      value: cstToJsonValue(prop.value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}
