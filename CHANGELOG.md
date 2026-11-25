# 发布记录

## 0.4.0

- 公开 npm 包迁至 `@boringparts/dock`（根入口 `@boringparts/dock`，子路径 `/core`、`/markdown`、`/typescript`、`/node-test`、`/vitest`，命令行入口保持为 `dock`）；代码仓库、主页与问题追踪地址迁至 `https://github.com/boringparts/dock`，许可证版权署名更新为 `boringparts`。原 `@ykdz/dock*` 旧包不再维护。
- 五个内置引用插件的处理器身份切换为与 npm scope 解耦的短命名空间：`dock:file`、`dock:markdown`、`dock:typescript`、`dock:node-test`、`dock:vitest`（不保留旧 `@ykdz/dock-reference-*` 兼容别名）；Vitest 跨物理安装共享的内部桥接键同步迁移至 `@boringparts/dock/vitest/<version>/attempt-context`。升级时需将依赖与导入路径切换至 `@boringparts/dock`，若外部脚本按字面量筛选 `pluginDiagnostics`、`pluginErrors` 或测试诊断 `framework` 字段需同步改为 `dock:*`，并按下方 V3 基线步骤显式重建基线。
- 调整 Node.js 原生测试与 Vitest 测试结果引用的基线比较规则：仅按所属插件、解析出的实际测试文件、所选测试或测试组以及要读取的状态或观察键核对引用定义，不再把共享运行名称、无关测试文件、额外测试、`namePattern`、`configFile` 或未选用的观察键写入比较定义；若配置或路径调整导致引用改指另一实际文件、测试、测试组或观察键，仍会报告引用定义变化。
- 基线格式升级至版本 `3`（不兼容旧版）。使用旧版本基线执行 `dock check` 或 `dock baseline update` 时，会明确报告版本不受支持并保留原基线文件。升级时请按以下步骤显式重建基线：
  1. 核对当前配置、引用目标与旧基线中的关联内容。
  2. 移除或替换旧版基线文件（默认为 `dock.baseline.json`）。
  3. 运行 `dock baseline update --config <配置文件>` 生成新版基线。
  4. 运行 `dock check --config <配置文件>` 确认检查通过。
- 新增基于无损 JSON CST 的 V3 基线损坏诊断：校验 Dock 自有记录的允许字段并从 JSON 原文识别重复键，准确区分缺少与多余的引用事实，指出基线文件、字段路径与行号；基线损坏时阻止更新并保留原文件字节，插件自定义业务事实字段继续原样保留。
- 支持在 Markdown 原文旁通过 `<!-- dock:bind {"id":"...","with":[...]} -->` HTML 注释声明原生关联，复用现有关联引用或配置显式提供的引用；支持在配置中通过 `sources` 显式登记 Markdown 声明来源，同时对纳入配置范围的 Markdown 文档主动校验全部 Dock 指令语法、参数与标记配对（代码示例保留原样），并在默认文本输出中按根因去重。声明来源读取失败时隔离故障并保留原基线；完整声明移除关联时明确报告取消跟踪，经显式更新移除历史记录。
- 精简 `dock check` 与 `dock baseline update` 的默认文本输出：
  - 检查范围内所有关联一致且无错误时，仅输出检查范围（`Scope`）与摘要（`All checked bindings are consistent with baseline.`），不再打印例行插件诊断或一致引用的当前事实。
  - 关联存在变化或核对错误时，先列核对错误，再列有证据支持的变化；多行文本变化只展开变动附近的局部行级差异，并列出同一关联中其余待核对引用的名称与行号位置（如 `path:10` 或 `path:10-15`）。
  - 需要完整事实、原始文本范围或例行插件诊断时，改用 `--output structured`。
- 调整 `updateBaseline` 返回值与 `dock baseline update --output structured`（`variant: "rejected"`）的错误归属，并明确默认文本输出中的更新结果：
  - 关联核对错误仅保存在所属关联报告 `report.bindings[i].errors` 中，不再复制到顶层 `errors`；顶层 `errors` 仅保留操作级拒绝原因（如 `empty-selection`），`BaselineUpdateIssue` 类型字段调整为 `{ code, message }`。
  - 默认文本模式下，`dock baseline update` 对每条关联错误只输出一次原因，并在末尾明确输出 `Baseline updated.` 或 `Baseline was not updated.`；选区为空时输出 `Scope: none` 与操作级错误，不再先输出一致摘要。
  - 读取更新结果的调用方脚本请按如下方式迁移：遍历 `report.bindings` 读取各关联的 `errors` 来统计或处理核对错误，同时检查顶层 `errors` 以处理 `empty-selection` 等操作级拒绝原因。
- 核对内核、维护宿主、文本选择与五个内置插件拆分为仓库内私有 `@dock/*` 工作区包，由 `@boringparts/dock` 构建并聚合为单个无私有依赖的发布包交付。

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
