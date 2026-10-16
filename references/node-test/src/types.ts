import type { JsonValue, ExecutionRunRecord } from "@dock/sdk";

export type NormalizedNodeRun = {
  readonly identity: string;
  readonly root: string;
  readonly testRoot: string;
  readonly files: readonly string[];
  readonly observationKeys: readonly string[];
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

type NodeEventRun = {
  readonly identity: string;
  readonly files: [string, ...string[]];
  readonly testRoot?: string;
  readonly namePattern?: string;
  readonly observationKeys: string[];
};

export type NodeEventTarget =
  | {
      readonly kind: "node-test-status";
      readonly run: NodeEventRun;
      readonly file: string;
      readonly name: string;
    }
  | {
      readonly kind: "node-test-observation";
      readonly run: NodeEventRun;
      readonly file: string;
      readonly name: string;
      readonly key: string;
    };

export type NodeTestRunResult = ExecutionRunRecord;
