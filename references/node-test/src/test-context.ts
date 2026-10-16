import { getTestContext } from "node:test";

/** 在活动的原生测试回调入口记录真实开始，尤其用于区分取消的子测试。 */
export function beginExecution(): void {
  const context = getTestContext();
  if (
    context === undefined ||
    !("log" in context) ||
    typeof context.log !== "function"
  ) {
    throw new Error("beginExecution 必须在活动的 Node 原生测试回调内调用。");
  }
  context.log("dock:started");
}
