import { inspect, type ResolvedMaintenance } from "@ykdz/dock";
import { check, type CheckContext } from "@ykdz/dock/core";

declare const resolution: ResolvedMaintenance;
const context: CheckContext = { references: [], bindings: [] };

// @ts-expect-error Inspected declarations cannot replace collected facts.
check(context);

// @ts-expect-error Resolved maintenance does not contain uncollected facts.
void resolution.context.facts;

// @ts-expect-error Resolved maintenance contains plugin metadata, not collect functions.
void resolution.plugins[0].collect;

// @ts-expect-error Host resolves complete config; filtering does not change declaration completeness.
const partial: "partial" = resolution.context.declarationCompleteness;
void partial;

// @ts-expect-error inspect entry must be a config object, path string, or URL.
void inspect(42);

// @ts-expect-error inspect uses the same string scope filters as maintenance operations.
void inspect("dock.config.mjs", { reference: [42] });
