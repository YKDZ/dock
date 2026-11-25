# @ykdz/dock

## 0.3.0

### Minor Changes

- 运行环境要求升级至 Node 26（`^26.13.1`），不再支持 Node 24。
- 原七个产品包合并为单个 `@ykdz/dock` 发布，`@ykdz/dock-core` 与五个 `@ykdz/dock-reference-*` 包不再随本版发布。根入口 `@ykdz/dock` 导出配置、插件作者接口与 `file`；子路径分别导出 `@ykdz/dock/core`、`@ykdz/dock/markdown`、`@ykdz/dock/typescript`、`@ykdz/dock/node-test` 与 `@ykdz/dock/vitest`；命令行入口保持为 `dock`。
- 产品自带 `typescript@5.9.3`；`vitest`（`4.1.11 || 5.0.3`）改为可选 peer 依赖，未安装 Vitest 时仍可正常使用其余入口与公开类型。
- 五个内置插件沿用原有处理器 ID（`@ykdz/dock-reference-file`、`@ykdz/dock-reference-markdown`、`@ykdz/dock-reference-typescript`、`@ykdz/dock-reference-node-test`、`@ykdz/dock-reference-vitest`），基线格式版本保持为 `2`。从 0.2.x 仅迁移依赖和导入路径时无需重建基线；若同步修改了被追踪文件、测试名称或文档内容，请运行 `dock baseline update --config <配置文件>` 显式更新基线后再执行 `dock check --config <配置文件>`。
- 升级至 `@ykdz/cli-contract@0.7.0`，`inspect`、`check` 与 `baseline update` 默认文本输出统一为英文。移除 `--json` 参数，机器消费改用 `--output structured`（协议版本升级为字符串 `"3"`，新增 `outputMode: "structured"`）。退出码规则保持不变：`inspected`、`consistent`、`updated` 退出 `0`；`changed`、`errors`、`rejected` 对应 `kind: "data"`、退出 `1`；`maintenanceFailed` 对应 `kind: "failure"`、退出 `1`；参数错误（含旧 `--json`）对应 `kind: "usageFailure"`、退出 `64`。
