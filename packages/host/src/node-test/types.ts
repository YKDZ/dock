import type { JsonValue, TextRange } from "@dock/core";

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

/** Terminal status recorded for a single native test from Node's TestsStream. */
export type NodeTestStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "todo"
  | "filtered"
  | "cancelled"
  | "not-run"
  | "duplicate";

/** A business observation recorded during a specific attempt (`attempt`) of an active Node native test. */
export type NodeObservationRecord = {
  readonly attempt: number;
  readonly key: string;
  readonly value: JsonValue;
};

/** A reference read recorded during a specific attempt (`attempt`) to explain what value and range the test observed. */
export type NodeReadRecord = {
  readonly attempt: number;
  readonly referenceId: string;
  readonly value: JsonValue;
  readonly range?: TextRange;
};

/** Single test record mapped from native Node test events; `attemptCount`, `observations`, and `reads` explain how the test ran and what evidence it produced. */
export type NodeTestRecord = {
  readonly id: string;
  readonly status: NodeTestStatus;
  readonly started: boolean;
  readonly attemptCount: number;
  readonly message?: string;
  readonly observations?: readonly NodeObservationRecord[];
  readonly reads?: readonly NodeReadRecord[];
};

/** Run record retained by the Node plugin; internal to this plugin and not part of host protocol. */
export type NodeTestRunResult = {
  readonly lifecycle: "complete" | "incomplete";
  readonly commandAttempts: number;
  readonly testExecutions: number;
  readonly tests: readonly NodeTestRecord[];
  readonly errors: readonly {
    readonly code: string;
    readonly message: string;
  }[];
  readonly commandResult?: {
    readonly exitCode: number | null;
    readonly signal: string | null;
  };
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
