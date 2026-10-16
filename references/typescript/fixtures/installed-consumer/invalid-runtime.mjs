import assert from "node:assert/strict";

import { typescript } from "@dock/reference-typescript";
import { readReference } from "@dock/sdk";

import config from "./dock.config.mjs";

const invalid = {
  id: "invalid-selection",
  pluginId: "@dock/reference-typescript",
  target: "symbol-source.ts",
  selection: { kind: "typescript", steps: [{ kind: "symbol", name: [] }] },
};
await assert.rejects(readReference(config, invalid), {
  code: "invalid-typescript-selection",
});

const dynamic = typescript
  .from("symbol-source.ts")
  .symbol("calculate")
  .reference("dynamic");
dynamic.selection.steps[0].name = [];
await assert.rejects(readReference(config, dynamic), {
  code: "invalid-typescript-selection",
});
