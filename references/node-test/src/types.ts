import type { JsonValue, ExecutionRunRecord } from "@dock/sdk";

export type NormalizedNodeRun = {
  readonly identity: string;
  readonly root: string;
  readonly testRoot: string;
  readonly files: readonly string[];
  readonly namePattern?: string;
  readonly configuration: JsonValue;
};

export type NodeEvent = {
  readonly type: string;
  readonly data?: Record<string, unknown>;
};

export type NodeSelectedTest = {
  readonly file: string;
  readonly name: string;
};

export type NodeEventTarget = {
  readonly kind: "node-test-status";
  readonly run: {
    readonly identity: string;
    readonly files: [string, ...string[]];
    readonly testRoot?: string;
    readonly namePattern?: string;
  };
  readonly file: string;
  readonly name: string;
};

export type NodeTestRunResult = ExecutionRunRecord;
