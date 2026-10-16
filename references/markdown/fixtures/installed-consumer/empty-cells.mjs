import { mkdir, readFile, writeFile } from "node:fs/promises";

import { markdown } from "@dock/reference-markdown";
import {
  binding,
  check,
  defineConfig,
  readReference,
  updateBaseline,
} from "@dock/sdk";

const cases = [
  {
    name: "quoted-table",
    source: "> | 名称 | 值 |\n> | --- | --- |\n> | api |  |\n",
  },
  {
    name: "unmatched-backtick",
    source: "| 名称 | 文本 | 值 |\n| --- | --- | --- |\n| api | `未闭合 |  |\n",
  },
  {
    name: "code-pipe-delimiter",
    source:
      "| 名称 | A | B | 值 |\n| --- | --- | --- | --- |\n| api | `a|b` |  |\n",
  },
];
const results = [];

for (const testCase of cases) {
  const root = `empty-cell-cases/${testCase.name}`;
  await mkdir(root, { recursive: true });
  await writeFile(`${root}/guide.md`, testCase.source, "utf8");
  const reference = markdown
    .from("guide.md")
    .tableCell({ column: "值", row: { column: "名称", value: "api" } })
    .reference("cell");
  const config = defineConfig({
    root,
    plugins: [markdown],
    bindings: [binding("policy", [reference])],
  });

  let read;
  try {
    read = await readReference(config, reference);
  } catch (error) {
    read = { code: error.code, message: error.message };
  }
  const report = await check(config);
  const update = await updateBaseline(config);
  let savedValue;
  try {
    const baseline = JSON.parse(
      await readFile(`${root}/dock.baseline.json`, "utf8"),
    );
    savedValue = baseline.bindings.policy.references.cell.value;
  } catch {}
  results.push({
    name: testCase.name,
    source: testCase.source,
    read,
    report,
    updateStatus: update.status,
    savedValue,
  });
}

process.stdout.write(`${JSON.stringify(results)}\n`);
