import { typescript } from "@dock/reference-typescript";
import {
  binding,
  defineConfig,
  readReference,
  type PluginReadResult,
} from "@dock/sdk";

const calculate = typescript
  .from("symbol-source.ts")
  .symbol("calculate", "function")
  .match("return (input \\+ \\d+);", 1)
  .reference("calculate-expression");
const nested = typescript
  .from("symbol-source.ts")
  .symbol(["Service", "run"], "method")
  .quote("return input;")
  .reference("service-run");
const marker = typescript
  .from("symbol-source.ts")
  .symbol("marker", "variable")
  .reference("marker");
const service = typescript
  .from("symbol-source.ts")
  .symbol("Service", "class")
  .reference("service");
const serviceValue = typescript
  .from("symbol-source.ts")
  .symbol(["Service", "value"], "property")
  .reference("service-value");
const contract = typescript
  .from("symbol-source.ts")
  .symbol("Contract", "interface")
  .reference("contract");
const output = typescript
  .from("symbol-source.ts")
  .symbol("Output", "type")
  .reference("output");
const contractMethod = typescript
  .from("symbol-source.ts")
  .symbol(["Contract", "run"], "method")
  .reference("contract-run");
const contractValue = typescript
  .from("symbol-source.ts")
  .symbol(["Contract", "value"], "property")
  .reference("contract-value");

const config = defineConfig({
  plugins: [typescript],
  bindings: [
    binding("symbols", [
      calculate,
      nested,
      marker,
      service,
      serviceValue,
      contract,
      output,
      contractMethod,
      contractValue,
    ]),
  ],
});

const calculation: Promise<PluginReadResult<string>> = readReference(
  config,
  calculate,
);
void calculation;
