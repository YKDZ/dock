import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  captured,
  integrity,
  packageNames,
  validateArtifacts,
  type ArtifactManifest,
} from "./release-artifacts.ts";

const registry = "https://registry.npmjs.org/";
const repository = "YKDZ/dock";
const directory = resolve(process.argv[3] ?? ".artifacts/release");
const commit = captured("git", ["rev-parse", "HEAD"]).toString().trim();

type Acceptance = {
  commit: string;
  manifest: string;
  notes: string;
  registryBefore: Record<string, string | null>;
};

function visible(command: string, args: string[], cwd = process.cwd()): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  assert.equal(result.status, 0, `${command} 执行失败，保留原制品后重试。`);
}

function npmView(spec: string, field: string): unknown {
  const result = spawnSync(
    "npm",
    ["view", spec, field, "--json", `--registry=${registry}`],
    { encoding: "utf8" },
  );
  if (result.status === 0)
    return result.stdout.trim() ? (JSON.parse(result.stdout) as unknown) : null;
  let code: unknown;
  try {
    code = (JSON.parse(result.stdout) as { error?: { code?: unknown } }).error
      ?.code;
  } catch {
    /* 非 JSON 错误由下方报告 */
  }
  assert.equal(code, "E404", `npm 查询失败：${result.stderr || result.stdout}`);
  return null;
}

function distTag(version: string): string {
  return version.includes("-") ? "next" : "latest";
}

async function accepted(): Promise<{
  manifest: ArtifactManifest;
  acceptance: Acceptance;
}> {
  try {
    await access(join(directory, "accepted.json"));
  } catch {
    throw new Error(
      "原验收制品缺失；请恢复原 verified-release 制品，不能重新打包继续发布。",
    );
  }
  const acceptance = JSON.parse(
    await readFile(join(directory, "accepted.json"), "utf8"),
  ) as Acceptance;
  assert.equal(acceptance.commit, commit, "验收提交不符");
  assert.equal(
    integrity(await readFile(join(directory, "manifest.json"))),
    acceptance.manifest,
    "验收后清单发生变化",
  );
  assert.equal(
    integrity(await readFile(join(directory, "CHANGELOG.md"))),
    acceptance.notes,
    "验收后发布说明发生变化",
  );
  const manifest = await validateArtifacts(directory, commit);
  for (const name of packageNames) {
    assert.ok(
      Object.hasOwn(acceptance.registryBefore, name),
      `缺少 ${name} 的发布前状态`,
    );
  }
  return { manifest, acceptance };
}

async function verify(): Promise<void> {
  // 重跑只能继续使用原交接，不能重新准备一批相同版本的文件。
  try {
    await access(join(directory, "accepted.json"));
  } catch {
    return prepare();
  }
  await accepted();
}

async function prepare(): Promise<void> {
  assert.equal(
    captured("git", ["status", "--porcelain", "--untracked-files=normal"])
      .toString()
      .trim(),
    "",
    "验收需要已提交且干净的工作区",
  );
  assert.equal(
    captured("npm", ["--version"]).toString().trim(),
    "12.2.1",
    "发布准备使用 npm 12.2.1",
  );
  let sourceVersion: string | undefined;
  for (const name of packageNames) {
    const source = JSON.parse(
      captured("pnpm", [
        "--filter",
        name,
        "exec",
        "cat",
        "package.json",
      ]).toString(),
    ) as { version: string };
    sourceVersion ??= source.version;
    assert.equal(source.version, sourceVersion, "七包源码版本不一致");
    assert.equal(
      npmView(`${name}@${source.version}`, "dist"),
      null,
      `${name}@${source.version} 已有外部发布；必须恢复原验收制品，不能重新打包`,
    );
  }
  visible("pnpm", ["check:full"]);
  const candidate = resolve(".artifacts/candidate");
  const manifest = await validateArtifacts(candidate, commit);
  for (const file of [
    "manifest.json",
    ...manifest.packages.map(({ file }) => file),
  ]) {
    await copyFile(join(candidate, file), join(directory, file));
  }
  assert.equal(manifest.version, sourceVersion, "源码与制品版本不一致");
  const notes = await readFile("CHANGELOG.md");
  assert.ok(
    notes.toString().includes(`## ${manifest.version}\n`),
    "缺少本版本发布说明",
  );
  await copyFile("CHANGELOG.md", join(directory, "CHANGELOG.md"));
  const registryBefore: Record<string, string | null> = {};
  for (const name of packageNames) {
    const tags = npmView(
      `${name}@${distTag(manifest.version)}`,
      "dist-tags",
    ) as Record<string, string> | null;
    registryBefore[name] = tags?.[distTag(manifest.version)] ?? null;
  }
  assert.equal(
    captured("git", ["status", "--porcelain", "--untracked-files=normal"])
      .toString()
      .trim(),
    "",
    "验收期间工作区发生变化，请重新准备",
  );
  assert.equal(
    captured("git", ["rev-parse", "HEAD"]).toString().trim(),
    commit,
    "验收期间提交发生变化，请重新准备",
  );
  const acceptance: Acceptance = {
    commit,
    manifest: integrity(await readFile(join(directory, "manifest.json"))),
    notes: integrity(notes),
    registryBefore,
  };
  await writeFile(
    join(directory, "accepted.json"),
    `${JSON.stringify(acceptance, null, 2)}\n`,
  );
  process.stdout.write(`正式验收完成：${manifest.version}，提交 ${commit}\n`);
}

function remoteState(
  name: string,
  version: string,
): { dist: { integrity?: string } | null; tag: string | null } {
  const dist = npmView(`${name}@${version}`, "dist") as {
    integrity?: string;
  } | null;
  const tags = npmView(`${name}@${distTag(version)}`, "dist-tags") as Record<
    string,
    string
  > | null;
  return { dist, tag: tags?.[distTag(version)] ?? null };
}

async function publish(): Promise<void> {
  const { manifest, acceptance } = await accepted();
  // 先核对整批远端状态，再进行任何写入。
  for (const artifact of manifest.packages) {
    const state = remoteState(artifact.name, manifest.version);
    if (state.dist) {
      assert.equal(
        state.dist.integrity,
        artifact.integrity,
        `${artifact.name} 已有版本的摘要冲突`,
      );
      assert.equal(
        state.tag,
        manifest.version,
        `${artifact.name} 的分发标签已改变：${state.tag}`,
      );
    } else {
      assert.equal(
        state.tag,
        acceptance.registryBefore[artifact.name],
        `${artifact.name} 的分发标签已被其他发布改变：${state.tag}`,
      );
    }
  }
  for (const artifact of manifest.packages) {
    const state = remoteState(artifact.name, manifest.version);
    if (state.dist) {
      assert.equal(
        state.dist.integrity,
        artifact.integrity,
        `${artifact.name} 已有版本的摘要冲突`,
      );
      assert.equal(
        state.tag,
        manifest.version,
        `${artifact.name} 的分发标签已改变：${state.tag}`,
      );
      process.stdout.write(
        `保留已发布版本：${artifact.name}@${manifest.version}\n`,
      );
      continue;
    }
    assert.equal(
      state.tag,
      acceptance.registryBefore[artifact.name],
      `${artifact.name} 的分发标签已改变：${state.tag}`,
    );
    visible("npm", [
      "publish",
      resolve(directory, artifact.file),
      "--access=public",
      `--tag=${distTag(manifest.version)}`,
      `--registry=${registry}`,
    ]);
    const published = remoteState(artifact.name, manifest.version);
    assert.equal(
      published.dist?.integrity,
      artifact.integrity,
      `${artifact.name} 发布后的摘要不符`,
    );
    assert.equal(
      published.tag,
      manifest.version,
      `${artifact.name} 发布后的标签不符`,
    );
  }
}

async function registryCheck(): Promise<void> {
  const { manifest } = await accepted();
  for (const artifact of manifest.packages) {
    const state = remoteState(artifact.name, manifest.version);
    assert.equal(
      state.dist?.integrity,
      artifact.integrity,
      `${artifact.name} 注册表摘要不符`,
    );
    assert.equal(
      state.tag,
      manifest.version,
      `${artifact.name} 注册表标签不符`,
    );
  }
  const consumer = await mkdtemp(join(tmpdir(), "dock-registry-"));
  try {
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    visible(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        join(consumer, "cache"),
        `--registry=${registry}`,
        ...manifest.packages.map(({ name, version }) => `${name}@${version}`),
        "vitest@4.1.11",
        "typescript@7.0.2",
      ],
      consumer,
    );
    const lock = JSON.parse(
      await readFile(join(consumer, "package-lock.json"), "utf8"),
    ) as {
      packages: Record<
        string,
        { version?: string; integrity?: string; resolved?: string }
      >;
    };
    for (const artifact of manifest.packages) {
      const installed = JSON.parse(
        await readFile(
          join(consumer, "node_modules", artifact.name, "package.json"),
          "utf8",
        ),
      ) as { version: string };
      assert.equal(installed.version, manifest.version);
      const entry = lock.packages[`node_modules/${artifact.name}`];
      assert.equal(entry?.integrity, artifact.integrity);
      assert.ok(
        entry?.resolved?.startsWith(registry),
        "安装制品必须来自真实 npm 注册表",
      );
    }
    await writeFile(join(consumer, "guide.md"), "公开安装验证\n");
    await writeFile(
      join(consumer, "dock.config.mjs"),
      [
        'import { binding, defineConfig } from "@ykdz/dock";',
        'import { file } from "@ykdz/dock-reference-file";',
        'export default defineConfig({ plugins: [file], bindings: [binding("guide", [file.from("guide.md").reference("guide")])] });',
      ].join("\n"),
    );
    const cli = join(consumer, "node_modules/.bin/dock");
    assert.equal(
      captured(cli, ["--version"], consumer).toString().trim(),
      manifest.version,
    );
    for (const args of [["baseline", "update"], ["inspect"], ["check"]]) {
      visible(cli, [...args, "--config", "dock.config.mjs"], consumer);
    }
    await writeFile(
      join(directory, "registry-accepted.json"),
      JSON.stringify({
        commit,
        manifest: integrity(await readFile(join(directory, "manifest.json"))),
      }),
    );
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

async function githubRelease(): Promise<void> {
  const { manifest, acceptance } = await accepted();
  const registryAcceptance = JSON.parse(
    await readFile(join(directory, "registry-accepted.json"), "utf8"),
  ) as { commit: string; manifest: string };
  assert.equal(registryAcceptance.commit, commit);
  assert.equal(
    registryAcceptance.manifest,
    acceptance.manifest,
    "尚未通过同批注册表安装验收",
  );
  // 每次恢复都重新确认 npm 内容，避免为已冲突的分发状态创建 Release。
  for (const artifact of manifest.packages) {
    const state = remoteState(artifact.name, manifest.version);
    assert.equal(state.dist?.integrity, artifact.integrity);
    assert.equal(state.tag, manifest.version, `${artifact.name} 分发标签冲突`);
  }
  const tag = `v${manifest.version}`;
  const api = (path: string) =>
    spawnSync("gh", ["api", `repos/${repository}/${path}`], {
      encoding: "utf8",
    });
  const ref = api(`git/ref/tags/${tag}`);
  if (ref.status === 0) {
    const reference = JSON.parse(ref.stdout) as {
      object: { sha: string; type: string };
    };
    assert.equal(reference.object.type, "commit", "已有标签类型冲突");
    assert.equal(reference.object.sha, commit, "标签指向其他提交");
  } else {
    assert.match(ref.stderr, /HTTP 404/u, `读取标签失败：${ref.stderr}`);
  }
  type ExistingRelease = {
    tag_name: string;
    name: string;
    body: string;
    prerelease: boolean;
    draft: boolean;
    target_commitish: string;
    assets: { name: string }[];
  };
  const findRelease = (): ExistingRelease | undefined => {
    const pages = JSON.parse(
      captured("gh", [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repository}/releases?per_page=100`,
      ]).toString(),
    ) as ExistingRelease[][];
    return pages.flat().find((release) => release.tag_name === tag);
  };
  let release = findRelease();
  const notes = await readFile(join(directory, "CHANGELOG.md"), "utf8");
  const files = [
    "manifest.json",
    "accepted.json",
    "registry-accepted.json",
    "CHANGELOG.md",
    ...manifest.packages.map(({ file }) => file),
  ];
  if (!release) {
    // 显式建立草稿，避免 gh 的带附件快捷路径在失败时自动删除草稿。
    visible("gh", [
      "release",
      "create",
      tag,
      "--draft",
      "--repo",
      repository,
      "--target",
      commit,
      "--title",
      tag,
      "--notes-file",
      join(directory, "CHANGELOG.md"),
      ...(manifest.version.includes("-") ? ["--prerelease"] : []),
    ]);
    release = findRelease();
    assert.ok(release, "无法读取本批草稿");
  }
  {
    const existing = release;
    assert.equal(existing.name, tag, "Release 标题冲突");
    assert.equal(existing.body, notes, "Release 说明冲突");
    assert.equal(
      existing.prerelease,
      manifest.version.includes("-"),
      "Release 类型冲突",
    );
    assert.equal(existing.target_commitish, commit, "Release 提交冲突");
    const expected = new Set(files);
    for (const asset of existing.assets)
      assert.ok(expected.has(asset.name), `Release 附件冲突：${asset.name}`);
    const download = await mkdtemp(join(tmpdir(), "dock-release-assets-"));
    try {
      if (existing.assets.length > 0)
        captured("gh", [
          "release",
          "download",
          tag,
          "--repo",
          repository,
          "--dir",
          download,
        ]);
      for (const asset of existing.assets) {
        assert.equal(
          integrity(await readFile(join(download, asset.name))),
          integrity(await readFile(join(directory, asset.name))),
          `Release 附件内容冲突：${asset.name}`,
        );
      }
    } finally {
      await rm(download, { recursive: true, force: true });
    }
    for (const file of files) {
      if (!existing.assets.some((asset) => asset.name === file)) {
        visible("gh", [
          "release",
          "upload",
          tag,
          join(directory, file),
          "--repo",
          repository,
        ]);
      }
    }
    if (existing.draft) {
      visible("gh", [
        "release",
        "edit",
        tag,
        "--draft=false",
        "--repo",
        repository,
      ]);
    }
  }
}

async function restore(): Promise<void> {
  const run = process.env.GITHUB_RUN_ID;
  const output = process.env.GITHUB_OUTPUT;
  assert.ok(run && output, "restore 仅用于 GitHub 当前运行");
  let restored = false;
  if (process.env.GITHUB_RUN_ATTEMPT !== "1") {
    const pages = JSON.parse(
      captured("gh", [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repository}/actions/runs/${run}/artifacts?per_page=100`,
      ]).toString(),
    ) as { artifacts: { name: string; expired: boolean }[] }[];
    const artifact = pages
      .flatMap((page) => page.artifacts)
      .find(({ name }) => name === "verified-release");
    if (artifact) {
      assert.equal(
        artifact.expired,
        false,
        "原验收制品已过期；停止发布，不能重新打包恢复",
      );
      visible("gh", [
        "run",
        "download",
        run,
        "--repo",
        repository,
        "--name",
        "verified-release",
        "--dir",
        directory,
      ]);
      await accepted();
      restored = true;
    } else {
      const attempts = JSON.parse(
        captured("gh", [
          "api",
          "--paginate",
          "--slurp",
          `repos/${repository}/actions/runs/${run}/jobs?filter=all&per_page=100`,
        ]).toString(),
      ) as {
        jobs: {
          name: string;
          started_at: string | null;
          conclusion: string | null;
        }[];
      }[];
      assert.ok(
        !attempts
          .flatMap((page) => page.jobs)
          .some(
            (job) =>
              job.name === "publish" &&
              job.started_at &&
              job.conclusion !== "skipped",
          ),
        "发布曾经开始但原验收制品缺失；必须恢复原文件，不能重新打包",
      );
    }
  }
  await appendFile(output, `restored=${restored}\n`);
}

try {
  await mkdir(directory, { recursive: true });
  switch (process.argv[2]) {
    case "restore":
      await restore();
      break;
    case "verify":
      await verify();
      break;
    case "publish":
      await publish();
      break;
    case "registry":
      await registryCheck();
      break;
    case "release":
      await githubRelease();
      break;
    default:
      throw new Error(
        "用法：release.ts verify|publish|registry|release|restore [原制品目录]",
      );
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
