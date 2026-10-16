import { file } from "@dock/reference-file";
import { readReferenceInTest } from "@dock/reference-vitest";
import { defineConfig, type PluginReadResult } from "@dock/sdk";

const document = file
  .from("business.data")
  .match("value: ([^\\n]+)", 1)
  .reference("business-value");
const config = defineConfig({ plugins: [file], bindings: [] });
const read = readReferenceInTest(config, document);
const expected: Promise<PluginReadResult<string>> = read;
void expected;
