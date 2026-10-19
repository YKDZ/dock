import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { nodeTest } from "@ykdz/dock-reference-node-test";

import config, { exampleTest, readme } from "../dock.config.ts";

const consumer = fileURLToPath(new URL("../", import.meta.url));

await test(exampleTest.name, async () => {
  const extension = readme.section("扩展");
  const usage = readme.section("如何使用");
  const codeBody = "^[^\\r\\n]*\\r?\\n([\\s\\S]*?)\\r?\\n[^\\r\\n]*$";
  const inputs = {
    config: extension.node({ type: "code", language: "js" }).match(codeBody, 1),
    manifest: extension
      .node({ type: "code", language: "json" })
      .match(codeBody, 1),
    guide: extension.match("“([^”]+)”", 1),
    nextVersion: extension.match('`"([^"`]+)"`', 1),
    check: extension
      .node({ type: "code", contains: "dock check" })
      .match(codeBody, 1),
    baseline: extension
      .node({ type: "code", contains: "dock baseline update" })
      .match(codeBody, 1),
    usageCheck: usage
      .node({ type: "code", contains: "dock check" })
      .match(codeBody, 1),
    usageBaseline: usage
      .node({ type: "code", contains: "dock baseline update" })
      .match(codeBody, 1),
  };
  const source = {} as Record<keyof typeof inputs, string>;
  for (const key of Object.keys(inputs) as (keyof typeof inputs)[]) {
    const result = await nodeTest.readReferenceInTest(
      config,
      inputs[key].reference(`readme-input-${key}`),
    );
    source[key] = result.value;
  }

  // 临时项目沿用当前消费者已安装的依赖，配置按正常包名解析。
  const project = await mkdtemp(join(consumer, ".dock-readme-"));
  // 工作区和安装消费者都通过公开入口运行构建后的同一 CLI，命令仍取自 README。
  const bin = join(project, "bin");
  await mkdir(bin);
  const launcher = join(
    bin,
    process.platform === "win32" ? "dock.cmd" : "dock",
  );
  const node = process.execPath;
  await writeFile(
    launcher,
    process.platform === "win32"
      ? `@echo off\r\n"${node}" --input-type=module -e "import '@ykdz/dock/cli'" -- dock %*\r\n`
      : `#!/bin/sh\nexec '${node.replaceAll("'", "'\\''")}' --input-type=module -e 'import "@ykdz/dock/cli"' -- dock "$@"\n`,
  );
  await chmod(launcher, 0o755);
  function runDock(command: string) {
    const result = spawnSync(command, {
      shell: true,
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      },
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    return result;
  }
  try {
    const manifest = {
      type: "module",
      ...(JSON.parse(source.manifest) as {
        engines: { node?: string };
        version?: string;
      }),
    };
    const initialVersion = manifest.engines.node;
    assert.equal(typeof initialVersion, "string");
    assert.notEqual(initialVersion, source.nextVersion);
    await writeFile(join(project, "package.json"), JSON.stringify(manifest));
    await writeFile(join(project, "install.md"), `${source.guide}\n`);
    await writeFile(join(project, "dock.config.mjs"), source.config);

    const baseline = runDock(source.baseline);
    assert.equal(baseline.status, 0, baseline.stdout);
    const saved = await readFile(join(project, "dock.baseline.json"), "utf8");

    const unchanged = runDock(source.check);
    assert.equal(unchanged.status, 0, unchanged.stdout);
    assert.match(unchanged.stdout, /与基线一致。/u);

    manifest.version = "1.0.1";
    await writeFile(join(project, "package.json"), JSON.stringify(manifest));
    const unrelated = runDock(source.check);
    assert.equal(unrelated.status, 0, unrelated.stdout);
    assert.match(unrelated.stdout, /与基线一致。/u);

    manifest.engines.node = source.nextVersion;
    await writeFile(join(project, "package.json"), JSON.stringify(manifest));
    const changed = runDock(source.check);
    assert.equal(changed.status, 1, changed.stdout);
    assert.match(changed.stdout, /关联 installation/u);
    assert.ok(
      changed.stdout.includes(
        `变化：node-version 事实：旧值 ${JSON.stringify(initialVersion)}；新值 ${JSON.stringify(source.nextVersion)}`,
      ),
      changed.stdout,
    );
    assert.match(changed.stdout, /引用 install-guide，文件 install\.md/u);
    assert.ok(changed.stdout.includes(JSON.stringify(`${source.guide}\n`)));
    assert.equal(
      await readFile(join(project, "dock.baseline.json"), "utf8"),
      saved,
    );

    delete manifest.engines.node;
    await writeFile(join(project, "package.json"), JSON.stringify(manifest));
    const missing = runDock(source.check);
    assert.equal(missing.status, 1, missing.stdout);
    assert.match(missing.stdout, /错误 node-version/u);

    // “如何使用”里的 TypeScript 配置入口也执行同一份示例。
    manifest.engines.node = source.nextVersion;
    await writeFile(join(project, "package.json"), JSON.stringify(manifest));
    await writeFile(join(project, "dock.config.ts"), source.config);
    const updated = runDock(source.usageBaseline);
    assert.equal(updated.status, 0, updated.stdout);
    assert.notEqual(
      await readFile(join(project, "dock.baseline.json"), "utf8"),
      saved,
    );
    const confirmed = runDock(source.usageCheck);
    assert.equal(confirmed.status, 0, confirmed.stdout);
    assert.match(confirmed.stdout, /与基线一致。/u);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
