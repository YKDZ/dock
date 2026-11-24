# Dock

<a target="_blank" href="https://www.npmjs.com/package/@ykdz/dock"><img alt="NPM Version" src="https://img.shields.io/npm/v/%40ykdz%2Fdock"></a>

Dock 帮助你维护文档与相关内容之间的联系。当选定的内容发生变化时，它会提醒你检查相关资料，减少修改代码后遗漏文档、互相关联的文档没有同步更新等常见偏移。

Dock 适合需要长期维护文档的项目，尤其是主要由 Agent 维护、文档较多且修改频繁的项目。

> 这份 README 也 [接入](apps/consumer-readme/) 了 Dock，其中书写的命令和示例等都可以在与实际行为发生偏移时被检查出来。

## 核心思想

引用可以指向整个文件、一段文档、一个代码符号或测试中记录的结果。把需要一起核对的引用放在一组，就构成了关联。例如，一组引用可以分别指向项目的 Node.js 版本要求和安装说明。

首次使用时，把当前状态保存为基线。以后每次检查，Dock 都会把各个引用的当前内容或执行结果与基线比较。如果发现变化，报告会列出变动的内容和与它关联的其他引用。

## 如何使用

可以先挑几项需要长期核对的内容，在 `dock.config.ts` 中选好对应的插件，声明引用和关联，以后再按需添加。引用测试结果时，测试仍然可以照常编写和运行。

配置好后，先保存基线。

```sh
dock baseline update --config dock.config.ts
```

之后，在日常开发或 CI 中运行检查。

```sh
dock check --config dock.config.ts
```

如果 Dock 报告了变化，先核对同一关联里的内容，判断文档、代码或测试是否需要修改。确认后，再运行上面的 `dock baseline update` 命令更新基线。

## 扩展

要核对其他类型的内容，可以编写插件来读取相应的内容或执行结果。只要插件返回的值可以比较，就能把新引用与已有引用关联起来，照常检查和更新基线。

例如，某个项目在 `package.json` 中指定了所需的 Node.js 版本。

```json
{ "engines": { "node": ">=22" } }
```

安装说明 `install.md` 里写着“需要 Node.js 22 或更高版本”。要在版本要求变动时提醒维护者核对这句话，可以用插件读取 `engines.node`，再把这个字段与安装说明关联起来。将以下配置保存为 `dock.config.mjs`。

```js
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  binding,
  createReference,
  defineConfig,
  definePlugin,
  file,
} from "@ykdz/dock";

const nodeEngine = definePlugin({
  id: "node-engine",
  validate({ target }) {
    if (typeof target !== "string") {
      throw new Error("Specify the package manifest path.");
    }
  },
  async collect(request, { root }) {
    const results = [];
    for (const reference of request.selectedReferences) {
      const target = reference.target;
      if (typeof target !== "string") {
        throw new Error("Package manifest path must be a string.");
      }
      const data = JSON.parse(await readFile(resolve(root, target), "utf8"));
      const value = data.engines?.node;
      results.push(
        typeof value === "string"
          ? { referenceId: reference.id, kind: "value", value }
          : {
              referenceId: reference.id,
              kind: "error",
              error: {
                code: "node-version-missing",
                message:
                  "Declare the version requirement with engines.node in package.json.",
              },
            },
      );
    }
    return { results };
  },
});

const engine = createReference("node-engine", "node-version", "package.json");
const guide = file.from("install.md").reference("install-guide");

export default defineConfig({
  plugins: [file, nodeEngine],
  bindings: [binding("installation", [guide, engine])],
});
```

先保存当前的版本要求和安装说明，作为基线。

```sh
dock baseline update --config dock.config.mjs
```

把 `package.json` 中的 `engines.node` 改为 `">=24"`，再运行检查。

```sh
dock check --config dock.config.mjs
```

Dock 会报告版本要求从 `>=22` 变为 `>=24`，并列出关联的 `install.md`。这样你就能看到，安装说明里写的最低版本还是 22。
