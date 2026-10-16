import {
  createReference,
  definePlugin,
  check,
  type PluginContext,
  type PluginResult,
  type Reference,
} from "@dock/sdk";

type ScopeReference = Reference<
  "fixture:scope-negative",
  "scope-negative-reference",
  { readonly path: string },
  string
>;

const reference = createReference<
  "fixture:scope-negative",
  "scope-negative-reference",
  { readonly path: string },
  string
>("fixture:scope-negative", "scope-negative-reference", { path: "guide.md" });
void reference;
const plugin = definePlugin({
  id: "fixture:scope-negative",
  validate(_reference: ScopeReference): void {},
  collect(_reference: ScopeReference): PluginResult<string> {
    return { kind: "value", value: "scope fact" };
  },
  fileInfo(_reference: ScopeReference, _context: PluginContext): string {
    return "guide.md";
  },
});
void plugin;

// @ts-expect-error 范围筛选项必须使用公开的字符串 ID。
void check({ plugins: [], bindings: [] }, { binding: [42] });

definePlugin({
  id: "fixture:scope-negative",
  validate(_reference: ScopeReference): void {},
  collect(_reference: ScopeReference): PluginResult<string> {
    return { kind: "value", value: "scope fact" };
  },
  // @ts-expect-error 插件文件信息只能返回路径文本或 file: URL。
  fileInfo(): number {
    return 1;
  },
});

definePlugin({
  id: "fixture:scope-negative",
  validate(_reference: ScopeReference): void {},
  collect(_reference: ScopeReference): PluginResult<string> {
    return { kind: "value", value: "scope fact" };
  },
  // @ts-expect-error 执行预检的身份必须是文本，配置必须是 JSON 值。
  validateReferences() {
    return [{ identity: 1, configuration: new Date() }];
  },
});
