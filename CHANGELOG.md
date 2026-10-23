# 发布记录

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
