import {
  inspect,
  type Config,
  type MaintenanceScope,
  type ResolvedMaintenance,
  type ResolvedRun,
} from "@ykdz/dock";
import {
  check,
  updateBaseline,
  type CheckContext,
  type ReferenceResult,
} from "@ykdz/dock-core";

async function consume(config: Config, url: URL): Promise<void> {
  const scope: MaintenanceScope = { reference: ["guide"] };
  const resolution: ResolvedMaintenance = await inspect(config, scope);
  const context: CheckContext = resolution.context;
  const complete: "complete" = resolution.context.declarationCompleteness;
  const selected: readonly string[] = resolution.context.scope;
  const sources: readonly string[] = resolution.declarationSources.config;
  const runs: readonly ResolvedRun[] = resolution.runs;
  const files: readonly { path: string; references: readonly string[] }[] =
    resolution.files;
  const facts: ReferenceResult[] = [{ referenceId: "guide", value: "正文" }];
  check({ ...context, facts });
  updateBaseline({ ...context, facts });
  await inspect("dock.config.mjs", { binding: selected });
  await inspect(url, { file: ["guide.md"] });
  void complete;
  void sources;
  void files;
  void runs;
}

void consume;
