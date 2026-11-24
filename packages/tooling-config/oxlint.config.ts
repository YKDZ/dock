import { defineConfig } from "oxlint";

// Oxc's erasing-op rule does not reject enums, runtime namespaces, or parameter
// properties; TypeScript 7's erasableSyntaxOnly check enforces erasable syntax.
export default defineConfig({
  categories: { correctness: "error", suspicious: "warn" },
});
