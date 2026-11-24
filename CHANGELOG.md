# 发布记录

## 0.3.0

- 运行环境要求升级至 Node 26（`^26.13.1`），不再支持 Node 24。
- 原七个产品包合并为单个 `@ykdz/dock` 发布，`@ykdz/dock-core` 与五个 `@ykdz/dock-reference-*` 包不再随本版发布。根入口 `@ykdz/dock` 导出配置、插件作者接口与 `file`；子路径分别导出 `@ykdz/dock/core`、`@ykdz/dock/markdown`、`@ykdz/dock/typescript`、`@ykdz/dock/node-test` 与 `@ykdz/dock/vitest`；命令行入口保持为 `dock`。
- 产品自带 `typescript@5.9.3`；`vitest`（`4.1.11 || 5.0.3`）改为可选 peer 依赖，未安装 Vitest 时仍可正常使用其余入口与公开类型。
- 五个内置插件沿用原有处理器 ID（`@ykdz/dock-reference-file`、`@ykdz/dock-reference-markdown`、`@ykdz/dock-reference-typescript`、`@ykdz/dock-reference-node-test`、`@ykdz/dock-reference-vitest`），基线格式版本保持为 `2`。从 0.2.x 仅迁移依赖和导入路径时无需重建基线；若同步修改了被追踪文件、测试名称或文档内容，请运行 `dock baseline update --config <配置文件>` 显式更新基线后再执行 `dock check --config <配置文件>`。
- 升级至 `@ykdz/cli-contract@0.7.0`，`inspect`、`check` 与 `baseline update` 默认文本输出统一为英文。移除 `--json` 参数，机器消费改用 `--output structured`（协议版本升级为字符串 `"3"`，新增 `outputMode: "structured"`）。退出码规则保持不变：`inspected`、`consistent`、`updated` 退出 `0`；`changed`、`errors`、`rejected` 对应 `kind: "data"`、退出 `1`；`maintenanceFailed` 对应 `kind: "failure"`、退出 `1`；参数错误（含旧 `--json`）对应 `kind: "usageFailure"`、退出 `64`。

## 0.2.0

- 七个公开包统一升级至 0.2.0，继续作为同版本配套单元安装；`@ykdz/dock`、`@ykdz/dock-core`、五个引用插件及 `dock` 命令保持原身份。
- 插件采集改为一次接收完整声明和本次选中引用，并返回逐引用结果；运行记录和类别诊断由所属插件提供。自定义插件需迁移到批量 `collect` 返回值，查看说明可由 `describe` 提供。
- 旧 `execution.declare`、`execution.execute` 与 `validateReferences` 迁至 `prepare` 和批量 `collect`：在 `prepare` 完成完整集合预检并返回纯数据，在一次 `collect` 内自管共享执行与收尾；旧 `inspect.runs` 的查看信息改读 `plugins[].description`，具体运行诊断由对应插件在 `pluginDiagnostics` 中提供。
- 检查报告移除宿主测试统计，改由 `pluginDiagnostics` 按插件保留结构化数据与文字，插件诊断格式错误列入 `pluginErrors`。消费者应按来源读取插件诊断。
- 当前基线编码不变，无需重建基线。请将七个产品包一起升级到 0.2.0，不要混用跨版本宿主与插件。

## 0.1.0

- 首个正式版本，七个包按同版本配套发布，SDK 提供 `dock` 命令。
- 保持预发行版的公开接口与基线格式，支持文件、Markdown、TypeScript、Node.js 测试和 Vitest 引用核对。

## 0.1.0-next.0

- 首次公开预发行七个同版本配套的包，SDK 提供 `dock` 命令。
- 文件、Markdown、TypeScript、Node.js 测试和 Vitest 插件使用公开包名作为处理器身份；已有基线需核对并更新。
- `dock --version` 显示实际安装版本。
- Node.js 测试插件支持 Node 24.21.0；Vitest 插件支持 4.1.11 和 5.0.3。

补丁版本保持公开接口与基线兼容；不兼容改动进入下一个小版本并说明影响。不支持的旧基线会明确报错。
