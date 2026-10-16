import { markdown } from "@dock/reference-markdown";
import { typescript } from "@dock/reference-typescript";
import { vitest } from "@dock/reference-vitest";
import { defineConfig } from "@dock/sdk";

import keepBindings from "./docs/framework/react/reference/functions/keepPreviousData.dock.ts";

export default defineConfig({
  root: "packages/query-core",
  baseline: "../../dock.baseline.json",
  plugins: [markdown, typescript, vitest],
  bindings: keepBindings,
});
