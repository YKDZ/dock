import {
  check,
  definePlugin,
  type PluginBatchResult,
  type PluginContext,
  type PluginRequest,
  type Reference,
} from "@ykdz/dock";

type ScopeReference = Reference<
  "fixture:scope-negative",
  "scope-negative-reference",
  { readonly path: string },
  string
>;

const valid = definePlugin({
  id: "fixture:scope-negative",
  validate(_reference: ScopeReference): void {},
  collect(request: PluginRequest<ScopeReference>): PluginBatchResult<string> {
    return {
      results: request.selectedReferences.map(({ id }) => ({
        referenceId: id,
        kind: "value",
        value: "scope fact",
      })),
    };
  },
  fileInfo(_reference: ScopeReference, _context: PluginContext): string {
    return "guide.md";
  },
});
void valid;

// @ts-expect-error 范围筛选项必须使用公开的字符串 ID。
void check({ plugins: [], bindings: [] }, { binding: [42] });

definePlugin({
  id: "fixture:scope-negative",
  validate(_reference: ScopeReference): void {},
  collect(request: PluginRequest<ScopeReference>): PluginBatchResult<string> {
    return {
      results: request.selectedReferences.map(({ id }) => ({
        referenceId: id,
        kind: "value",
        value: "scope fact",
      })),
    };
  },
  // @ts-expect-error 插件文件信息只能返回路径文本或 file: URL。
  fileInfo(): number {
    return 1;
  },
});

type WrongTargetReference = Reference<
  "fixture:scope-negative",
  string,
  string,
  string
>;
const wrongReferenceRequest = {
  id: "fixture:scope-negative" as const,
  validate(_reference: ScopeReference): void {},
  collect(
    _request: PluginRequest<WrongTargetReference>,
  ): PluginBatchResult<string> {
    return { results: [] };
  },
};
// @ts-expect-error collect 必须接受与 validate 相同的引用类型。
definePlugin(wrongReferenceRequest);

const wrongPreparedRequest = {
  id: "fixture:scope-negative" as const,
  validate(_reference: ScopeReference): void {},
  prepare(): { count: number } {
    return { count: 1 };
  },
  collect(
    _request: PluginRequest<ScopeReference, { count: string }>,
  ): PluginBatchResult<string> {
    return { results: [] };
  },
};
// @ts-expect-error collect 必须接受 prepare 返回的准备数据类型。
definePlugin(wrongPreparedRequest);

const wrongPluginIdentity = {
  id: "another-plugin" as const,
  validate(_reference: ScopeReference): void {},
  collect(_request: PluginRequest<ScopeReference>): PluginBatchResult<string> {
    return { results: [] };
  },
};
// @ts-expect-error 插件身份必须与引用声明的插件身份一致。
definePlugin(wrongPluginIdentity);

const wrongFactValue = {
  id: "fixture:scope-negative" as const,
  validate(_reference: ScopeReference): void {},
  collect(_request: PluginRequest<ScopeReference>): PluginBatchResult<number> {
    return { results: [] };
  },
};
// @ts-expect-error 批量成功值必须匹配引用事实值类型。
definePlugin(wrongFactValue);
