import { typescript } from "@dock/reference-typescript";

// @ts-expect-error 声明种类必须属于公开集合。
typescript.from("symbol-source.ts").symbol("calculate", "enum");

// @ts-expect-error 符号路径至少包含一个名称。
typescript.from("symbol-source.ts").symbol([], "function");

// @ts-expect-error 文本选择只能接收字符串。
typescript.from("symbol-source.ts").symbol("calculate").quote(42);
