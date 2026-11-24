---
"@ykdz/dock": minor
---

- 调整 Node.js 原生测试与 Vitest 测试结果引用的基线比较规则：仅按所属插件、解析出的实际测试文件、所选测试或测试组以及读取的状态或观察键核对引用定义，不再把共享运行名称、无关测试文件、额外测试、`namePattern`、`configFile` 或未选用的观察键写入比较定义；若配置或路径调整导致引用改指另一实际文件、测试、测试组或观察键，仍会报告引用定义变化。
- 基线格式升级至版本 `3`（不兼容旧版）。使用旧版本基线执行 `dock check` 或 `dock baseline update` 时会明确报告版本不受支持并保留原基线文件。升级时请按以下步骤显式重建基线：
  1. 核对当前配置、引用目标与基线中的关联内容。
  2. 移除或替换旧版 `dock.baseline.json` 文件。
  3. 运行 `dock baseline update --config <配置文件>` 生成新版基线。
  4. 运行 `dock check --config <配置文件>` 确认检查通过。
- 精简 `dock check` 与 `dock baseline update` 的默认文本输出：
  - 检查范围内所有关联一致且无错误时，仅输出检查范围（`Scope`）与摘要（`All checked bindings are consistent with baseline.`），不再打印例行插件诊断或一致引用的当前事实。
  - 关联存在变化或核对错误时，先列核对错误，再列已有证据支持的变化；多行文本变化只展开变动附近的局部行级差异，并列出同一关联中其余待核对引用的名称与行号位置（如 `path:10` 或 `path:10-15`）。
  - 需要完整事实、原始文本范围或例行插件诊断时，改用 `--output structured`。
- 调整 `updateBaseline` 返回值与 `dock baseline update --output structured`（`variant: "rejected"`）的错误归属，并明确默认文本的更新结果：
  - 关联核对错误仅保存在所属关联报告 `report.bindings[i].errors` 中，不再复制到顶层 `errors`；顶层 `errors` 仅保留操作级拒绝原因（如 `empty-selection`），`BaselineUpdateIssue` 类型字段调整为 `{ code, message }`。
  - 默认文本模式下，`dock baseline update` 对每条关联错误只解释一次原因，并在末尾明确输出 `Baseline updated.` 或 `Baseline was not updated.`；选区为空时展示 `Scope: none` 与操作级错误，不再先输出一致摘要。
  - 迁移读取更新结果的调用方脚本：遍历 `report.bindings` 读取各关联的 `errors` 统计或处理核对错误，同时保留对顶层 `errors` 的检查以处理 `empty-selection` 等操作级拒绝原因。
