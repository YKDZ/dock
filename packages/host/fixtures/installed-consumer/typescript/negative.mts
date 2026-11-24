import { typescript } from "@ykdz/dock/typescript";

// @ts-expect-error Declaration kind must belong to the supported set.
typescript.from("symbol-source.ts").symbol("calculate", "enum");

// @ts-expect-error Symbol path must contain at least one name.
typescript.from("symbol-source.ts").symbol([], "function");

// @ts-expect-error Quote selection only accepts a string.
typescript.from("symbol-source.ts").symbol("calculate").quote(42);
