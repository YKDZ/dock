import { typescript } from "@dock/reference-typescript";
import { binding, defineConfig } from "@dock/sdk";

const declaration = typescript
  .from(process.env.DOCK_SYMBOL_TARGET ?? "symbol-source.ts")
  .symbol(
    process.env.DOCK_SYMBOL_MODE === "missing" ? "absent" : "calculate",
    "function",
  );
export const expression =
  process.env.DOCK_SYMBOL_MODE === "quote"
    ? declaration.quote("input + 2").reference("calculate-expression")
    : declaration
        .match("return (input \\+ \\d+);", 1)
        .reference("calculate-expression");

export const config = defineConfig({
  baseline: "typescript.baseline.json",
  plugins: [typescript],
  bindings: [binding("typescript-policy", [expression])],
});

export default config;
