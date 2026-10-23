import { inspect, type ResolvedMaintenance } from "@ykdz/dock";
import { check, type CheckContext } from "@ykdz/dock-core";

declare const resolution: ResolvedMaintenance;
const context: CheckContext = { references: [], bindings: [] };

// @ts-expect-error 查看声明不能替代采集事实。
check(context);

// @ts-expect-error 解析结果不包含尚未采集的事实。
void resolution.context.facts;

// @ts-expect-error 解析结果只包含插件身份，不包含插件执行函数。
void resolution.plugins[0].collect;

// @ts-expect-error 宿主解析的是完整配置，筛选不改变声明完整性。
const partial: "partial" = resolution.context.declarationCompleteness;
void partial;

// @ts-expect-error inspect 入口必须是配置对象、路径文本或 URL。
void inspect(42);

// @ts-expect-error inspect 与维护操作采用相同的文本范围筛选。
void inspect("dock.config.mjs", { reference: [42] });
