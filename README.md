# Dock

Dock 帮助你维护文档与相关内容之间的联系。当选定的内容发生变化时，它会提醒你检查相关资料，减少修改代码后遗漏文档、互相关联的文档没有同步更新等常见偏移。

Dock 适合需要长期维护文档的项目，尤其是主要由 Agent 维护、文档较多且修改频繁的项目。

> 这份 README 也 [接入](apps/consumer-readme/) 了 Dock，其中书写的命令和示例等都可以在与实际行为发生偏移时被检查出来。

## 核心思想

你可以将一个文件、一段文档、一个代码符号或测试中记录的结果定义为引用，再将需要共同核对的引用组成关联。首次接入时，将当前状态保存为基线，供后续检查比较。

检查时，Dock 取得这些引用的当前内容或执行结果，与基线比较，并报告变化。维护者据此判断是否需要调整文档、代码或测试，确认后更新基线。

## 如何使用

先选出值得持续维护的内容，在配置中声明引用和关联，并选择所需插件。测试沿用原有的编写和运行方式。

保存初始基线后，可以在日常开发或 CI 中执行检查：

```sh
dock check --config dock.config.ts
```

看到变化后，核对相关内容，完成必要修改，再保存新的基线：

```sh
dock baseline update --config dock.config.ts
```

从少量关键内容开始即可，后续按维护需要逐步增加关联。

## 扩展

需要维护的资产类型可以按需扩展。只要能够取得可比较的内容或结果，就可以编写插件将其接入 Dock，再与已有引用组成关联，沿用相同的检查和基线更新流程。

目前原生支持以下类型：

- [文件](references/file/)：检查文件是否存在，选取全文或文本片段。
- [Markdown 文档](references/markdown/)：选取章节、表格等结构化内容或标记范围。
- [TypeScript 代码](references/typescript/)：按符号和声明路径选取代码。
- [Node.js 测试](references/node-test/)：取得原生测试状态及测试中记录的结果。
- [Vitest 测试](references/vitest/)：取得测试或测试组的状态及测试中记录的结果。

例如，某个项目在 `package.json` 中声明 Node.js 版本要求：

```json
{ "engines": { "node": ">=22" } }
```

安装说明 `install.md` 写着“需要 Node.js 22 或更高版本”。可以编写一个读取 `engines.node` 的插件，将版本要求与安装说明关联起来。下面的配置保存为 `dock.config.mjs`：

```js
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { file } from "@ykdz/dock-reference-file";
import {
  binding,
  createReference,
  defineConfig,
  definePlugin,
} from "@ykdz/dock";

const nodeEngine = definePlugin({
  id: "node-engine",
  validate({ target }) {
    if (typeof target !== "string") {
      throw new Error("请指定包清单的路径。");
    }
  },
  async collect({ target }, { root }) {
    const data = JSON.parse(await readFile(resolve(root, target), "utf8"));
    const value = data.engines?.node;
    if (typeof value !== "string") {
      throw new Error("请在包清单中用 engines.node 声明版本要求。");
    }
    return { kind: "value", value };
  },
});

const engine = createReference("node-engine", "node-version", "package.json");
const guide = file.from("install.md").reference("install-guide");

export default defineConfig({
  plugins: [file, nodeEngine],
  bindings: [binding("installation", [guide, engine])],
});
```

先保存基线：

```sh
dock baseline update --config dock.config.mjs
```

再把 `package.json` 中的 `engines.node` 改为 `">=24"`，运行检查：

```sh
dock check --config dock.config.mjs
```

检查会报告版本要求从 `>=22` 变为 `>=24`，并列出关联的安装说明，提醒你核对其中的版本要求。
