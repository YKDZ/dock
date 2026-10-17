import type { JsonValue, ExecutionRunRecord } from "@dock/sdk";

export type NodeRunConfiguration = {
  readonly framework: string;
  readonly root: string;
  readonly testRoot: string;
  readonly files: string[];
  readonly observationKeys: string[];
  readonly namePattern?: string;
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
  readonly observationKeys: string[] & {
    readonly __dockTypeWitness?: {
      readonly framework: "node-test";
      readonly values: Record<string, JsonValue>;
    };
  };
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
