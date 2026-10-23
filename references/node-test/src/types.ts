import type { JsonValue, TextRange } from "@ykdz/dock";

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

/** Node TestsStream 对单条原生测试的终态。 */
export type NodeTestStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "todo"
  | "filtered"
  | "cancelled"
  | "not-run"
  | "duplicate";

/** Node 原生活动记录的一条业务观察。 */
export type NodeObservationRecord = {
  readonly attempt: number;
  readonly key: string;
  readonly value: JsonValue;
};

/** Node 原生测试内实际发生的引用读取。 */
export type NodeReadRecord = {
  readonly attempt: number;
  readonly referenceId: string;
  readonly value: JsonValue;
  readonly range?: TextRange;
};

/** Node 原生事件映射出的单条测试记录。 */
export type NodeTestRecord = {
  readonly id: string;
  readonly status: NodeTestStatus;
  readonly started: boolean;
  readonly attemptCount: number;
  readonly message?: string;
  readonly observations?: readonly NodeObservationRecord[];
  readonly reads?: readonly NodeReadRecord[];
};

/** Node 插件持有的本次运行记录，不属于宿主公共协议。 */
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
