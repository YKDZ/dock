import { markdown } from "@dock/reference-markdown";
import { typescript } from "@dock/reference-typescript";
import { binding } from "@dock/sdk";

import { keep } from "../../../../../packages/query-core/src/__tests__/keep.evidence.ts";

const statement = markdown
  .from("../../docs/framework/react/reference/functions/keepPreviousData.md")
  .section("Returns")
  .node({ type: "paragraph", contains: "The previous data" })
  .reference("keep-return-doc");
const implementation = typescript
  .from("src/utils.ts")
  .symbol("keepPreviousData", "function")
  .reference("keep-function");

export default [
  binding("keep-status", [statement, keep.status], {
    note: "只比较原生测试状态；不能发现实现与测试预期同步改变后仍通过。",
  }),
  binding("keep-observation", [statement, keep.status, keep.result], {
    note: "样例对象的实际返回值和对象身份；不证明所有泛型输入或 UI 行为。",
  }),
  binding("keep-source", [implementation, statement], {
    note: "函数完整符号源码；正常重构也需审阅，不推断语义等价。",
  }),
];
