import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const names = [
  "@ykdz/dock-core",
  "@ykdz/dock",
  "@ykdz/dock-reference-file",
  "@ykdz/dock-reference-markdown",
  "@ykdz/dock-reference-node-test",
  "@ykdz/dock-reference-typescript",
  "@ykdz/dock-reference-vitest",
];
const sha = (bytes: Uint8Array) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const commit = spawnSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).stdout.trim();
type NpmState = {
  calls: string[][];
  packages: {
    name: string;
    version: string;
    file: string;
    integrity: string;
  }[];
  versions: Record<string, Record<string, { integrity: string }>>;
  tags: Record<string, Record<string, string>>;
  failPublishAt?: number;
  failAfterWrite?: boolean;
  failInstall?: boolean;
};
type GithubState = {
  calls: string[][];
  tag?: string;
  release?: {
    name: string;
    body: string;
    prerelease: boolean;
    draft: boolean;
    target_commitish: string;
    assets: { name: string }[];
  };
  assets: Record<string, string>;
  failCreateAfterWrite?: boolean;
  failUploadAt?: number;
  runArtifacts?: { name: string; expired: boolean }[];
  runJobs?: {
    name: string;
    started_at: string | null;
    conclusion: string | null;
  }[];
};

async function batch(version: string) {
  const directory = await mkdtemp(join(tmpdir(), "dock-release-"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  for (const name of ["npm", "gh"]) {
    const path = join(bin, name);
    const fixture = fileURLToPath(
      new URL(`./fixtures/${name}.ts`, import.meta.url),
    );
    await writeFile(
      path,
      `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`,
    );
    await chmod(path, 0o755);
  }
  const packages = [];
  for (const [index, name] of names.entries()) {
    const source = join(directory, `source-${index}`, "package");
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name,
        version,
        type: "module",
        dependencies: index === 1 ? { [names[0]!]: version } : {},
      }),
    );
    if (index === 1) {
      await writeFile(
        join(source, "cli.js"),
        `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nif (args[0] === '--version') console.log('${version}');\nelse appendFileSync(process.env.DOCK_RELEASE_TEST_CLI, JSON.stringify(args) + '\\n');\n`,
      );
      await chmod(join(source, "cli.js"), 0o755);
    }
    const file = `package-${index}.tgz`;
    assert.equal(
      spawnSync("tar", [
        "-czf",
        join(directory, file),
        "-C",
        join(source, ".."),
        "package",
      ]).status,
      0,
    );
    packages.push({
      name,
      version,
      file,
      integrity: sha(await readFile(join(directory, file))),
    });
  }
  const manifest = Buffer.from(JSON.stringify({ commit, version, packages }));
  const notes = Buffer.from(`## ${version}\n公开发布\n`);
  await writeFile(join(directory, "manifest.json"), manifest);
  await writeFile(join(directory, "CHANGELOG.md"), notes);
  await writeFile(
    join(directory, "accepted.json"),
    JSON.stringify({
      commit,
      manifest: sha(manifest),
      notes: sha(notes),
      registryBefore: Object.fromEntries(names.map((name) => [name, null])),
    }),
  );
  const npmFile = join(directory, "npm.json");
  const githubFile = join(directory, "github.json");
  const state: NpmState = {
    calls: [],
    packages: packages.map((entry) => ({
      ...entry,
      file: join(directory, entry.file),
    })),
    versions: {},
    tags: {},
  };
  await writeFile(npmFile, JSON.stringify(state));
  await writeFile(githubFile, JSON.stringify({ calls: [], assets: {} }));
  const run = (command: string, environment: Record<string, string> = {}) =>
    spawnSync(
      process.execPath,
      [resolve("scripts/release.ts"), command, directory],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...environment,
          PATH: `${bin}:${process.env.PATH}`,
          DOCK_RELEASE_TEST_STATE: npmFile,
          DOCK_RELEASE_TEST_GITHUB: githubFile,
          DOCK_RELEASE_TEST_CLI: join(directory, "cli.log"),
        },
      },
    );
  return {
    directory,
    packages,
    run,
    npm: async () => JSON.parse(await readFile(npmFile, "utf8")) as NpmState,
    setNpm: (value: NpmState) => writeFile(npmFile, JSON.stringify(value)),
    github: async () =>
      JSON.parse(await readFile(githubFile, "utf8")) as GithubState,
    setGithub: (value: GithubState) =>
      writeFile(githubFile, JSON.stringify(value)),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

void test("原验收制品缺失时停止发布并说明原因", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dock-release-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["scripts/release.ts", "publish", directory],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /验收制品缺失/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const version of ["0.1.0-next.0", "0.1.0"]) {
  void test(`${version} 使用原制品发布、注册表消费并创建对应 Release`, async () => {
    const context = await batch(version);
    try {
      const state = await context.npm();
      // 首次稳定发布时允许只有 next，尚无 latest。
      if (version === "0.1.0")
        for (const name of names) state.tags[name] = { next: "0.1.0-next.0" };
      await context.setNpm(state);
      for (const command of [
        "verify",
        "publish",
        "registry",
        "release",
        "publish",
        "release",
      ]) {
        const result = context.run(command);
        assert.equal(result.status, 0, result.stdout + result.stderr);
      }
      const published = await context.npm();
      const writes = published.calls.filter((args) => args[0] === "publish");
      assert.deepEqual(
        writes.map((args) => args[1]),
        state.packages.map(({ file }) => file),
      );
      for (const args of writes)
        assert.ok(
          args.includes(`--tag=${version.includes("-") ? "next" : "latest"}`),
        );
      const github = await context.github();
      assert.equal(github.tag, commit);
      assert.equal(github.release?.prerelease, version.includes("-"));
      for (const entry of context.packages) {
        assert.equal(
          sha(Buffer.from(github.assets[entry.file]!, "base64")),
          entry.integrity,
        );
      }
      assert.deepEqual(
        (await readFile(join(context.directory, "cli.log"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]),
        [
          ["baseline", "update", "--config", "dock.config.mjs"],
          ["inspect", "--config", "dock.config.mjs"],
          ["check", "--config", "dock.config.mjs"],
        ],
      );
    } finally {
      await context.close();
    }
  });
}

for (const afterWrite of [false, true]) {
  void test(`部分发布失败后恢复，外部写入${afterWrite ? "已" : "未"}成功`, async () => {
    const context = await batch("0.1.0");
    try {
      await context.setNpm({
        ...(await context.npm()),
        failPublishAt: 2,
        failAfterWrite: afterWrite,
      });
      assert.notEqual(context.run("publish").status, 0);
      assert.equal(
        Object.keys((await context.npm()).versions).length,
        afterWrite ? 3 : 2,
      );
      const resumed = context.run("publish");
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(Object.keys((await context.npm()).versions).length, 7);
      const calls = (await context.npm()).calls.filter(
        (args) => args[0] === "publish",
      );
      assert.equal(
        calls.filter(
          (args) =>
            args[1] === join(context.directory, context.packages[0]!.file),
        ).length,
        1,
      );
    } finally {
      await context.close();
    }
  });
}

void test("注册表安装失败保留已发布版本，恢复验收后完成中断的 Release", async () => {
  const context = await batch("0.1.0");
  try {
    assert.equal(context.run("publish").status, 0);
    await context.setNpm({ ...(await context.npm()), failInstall: true });
    assert.notEqual(context.run("registry").status, 0);
    assert.notEqual(context.run("release").status, 0);
    assert.equal((await context.github()).calls.length, 0);
    await context.setNpm({ ...(await context.npm()), failInstall: false });
    assert.equal(context.run("registry").status, 0);
    await context.setGithub({
      ...(await context.github()),
      failCreateAfterWrite: true,
    });
    assert.notEqual(context.run("release").status, 0);
    assert.equal((await context.github()).release?.assets.length, 0);
    const resumed = context.run("release");
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal((await context.github()).release?.assets.length, 11);
  } finally {
    await context.close();
  }
});

for (const fault of [
  "missing",
  "bytes",
  "commit",
  "manifest",
  "remote-integrity",
  "remote-tag",
] as const) {
  void test(`拒绝冲突并保留远端成果：${fault}`, async () => {
    const context = await batch("0.1.0");
    try {
      const first = context.packages[0]!;
      if (fault === "missing") await rm(join(context.directory, first.file));
      if (fault === "bytes")
        await writeFile(join(context.directory, first.file), "改变的内容");
      if (fault === "commit" || fault === "manifest") {
        const manifest = JSON.parse(
          await readFile(join(context.directory, "manifest.json"), "utf8"),
        ) as { commit: string; version: string };
        if (fault === "commit") manifest.commit = "其他提交";
        else manifest.version = "0.2.0";
        await writeFile(
          join(context.directory, "manifest.json"),
          JSON.stringify(manifest),
        );
      }
      if (fault === "remote-integrity" || fault === "remote-tag") {
        const state = await context.npm();
        state.versions[first.name] = {
          "0.1.0": {
            integrity:
              fault === "remote-integrity" ? "其他内容" : first.integrity,
          },
        };
        state.tags[first.name] = {
          latest: fault === "remote-tag" ? "0.2.0" : "0.1.0",
        };
        await context.setNpm(state);
      }
      const before = await context.npm();
      const result = context.run("publish");
      assert.notEqual(result.status, 0);
      const after = await context.npm();
      assert.deepEqual(after.versions, before.versions);
      assert.deepEqual(after.tags, before.tags);
      assert.equal(after.calls.filter((args) => args[0] !== "view").length, 0);
    } finally {
      await context.close();
    }
  });
}

void test("GitHub 标签、发布说明与附件冲突时不覆盖", async () => {
  const context = await batch("0.1.0");
  try {
    assert.equal(context.run("publish").status, 0);
    assert.equal(context.run("registry").status, 0);
    await context.setGithub({ ...(await context.github()), tag: "其他提交" });
    assert.notEqual(context.run("release").status, 0);
    await context.setGithub({ ...(await context.github()), tag: commit });
    assert.equal(context.run("release").status, 0);
    const original = await context.github();
    await context.setGithub({
      ...original,
      release: { ...original.release!, body: "其他发布说明" },
    });
    assert.notEqual(context.run("release").status, 0);
    await context.setGithub({
      ...original,
      assets: {
        ...original.assets,
        "manifest.json": Buffer.from("其他制品").toString("base64"),
      },
    });
    assert.notEqual(context.run("release").status, 0);
    const after = await context.github();
    assert.equal(after.calls.filter((args) => args[1] === "create").length, 1);
    assert.equal(after.calls.filter((args) => args[1] === "upload").length, 11);
  } finally {
    await context.close();
  }
});

void test("附件上传中断后保留草稿和原附件，补齐后公开", async () => {
  const context = await batch("0.1.0");
  try {
    assert.equal(context.run("publish").status, 0);
    assert.equal(context.run("registry").status, 0);
    await context.setGithub({ ...(await context.github()), failUploadAt: 3 });
    assert.notEqual(context.run("release").status, 0);
    const partial = await context.github();
    assert.equal(partial.release?.draft, true);
    assert.equal(partial.release.assets.length, 3);
    const resumed = context.run("release");
    assert.equal(resumed.status, 0, resumed.stderr);
    const completed = await context.github();
    assert.equal(completed.release?.draft, false);
    assert.equal(completed.release.assets.length, 11);
    for (const [name, bytes] of Object.entries(partial.assets))
      assert.equal(completed.assets[name], bytes);
    assert.equal(
      completed.calls.filter((args) => args[1] === "create").length,
      1,
    );
  } finally {
    await context.close();
  }
});

for (const scenario of [
  "before-handoff",
  "lost-after-publish",
  "expired",
  "original",
] as const) {
  void test(`工作流恢复依据外部事实：${scenario}`, async () => {
    const context = await batch("0.1.0");
    try {
      const github = await context.github();
      github.runArtifacts =
        scenario === "original" || scenario === "expired"
          ? [{ name: "verified-release", expired: scenario === "expired" }]
          : [];
      github.runJobs = [
        { name: "verify", started_at: "2026-10-19", conclusion: "failure" },
        {
          name: "publish",
          started_at: scenario === "lost-after-publish" ? "2026-10-19" : null,
          conclusion: scenario === "lost-after-publish" ? "failure" : "skipped",
        },
      ];
      await context.setGithub(github);
      const output = join(context.directory, "output.txt");
      const result = context.run("restore", {
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_OUTPUT: output,
      });
      if (scenario === "before-handoff" || scenario === "original") {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
          await readFile(output, "utf8"),
          `restored=${scenario === "original"}\n`,
        );
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /原验收制品/u);
      }
      assert.equal((await context.npm()).calls.length, 0);
      assert.equal(
        (await context.github()).calls.filter(
          (args) => args[0] !== "api" && args[0] !== "run",
        ).length,
        0,
      );
    } finally {
      await context.close();
    }
  });
}

for (const field of ["name", "version", "dependency"] as const) {
  void test(`压缩包与批次不符时拒绝发布：${field}`, async () => {
    const context = await batch("0.1.0");
    try {
      const source = join(context.directory, "source-1", "package");
      const metadata = JSON.parse(
        await readFile(join(source, "package.json"), "utf8"),
      ) as {
        name: string;
        version: string;
        dependencies: Record<string, string>;
      };
      if (field === "name") metadata.name = "@other/dock";
      if (field === "version") metadata.version = "0.2.0";
      if (field === "dependency") metadata.dependencies[names[0]!] = "^0.1.0";
      await writeFile(join(source, "package.json"), JSON.stringify(metadata));
      const artifact = context.packages[1]!;
      assert.equal(
        spawnSync("tar", [
          "-czf",
          join(context.directory, artifact.file),
          "-C",
          join(source, ".."),
          "package",
        ]).status,
        0,
      );
      const manifest = JSON.parse(
        await readFile(join(context.directory, "manifest.json"), "utf8"),
      ) as { packages: { integrity: string }[] };
      manifest.packages[1]!.integrity = sha(
        await readFile(join(context.directory, artifact.file)),
      );
      const bytes = Buffer.from(JSON.stringify(manifest));
      await writeFile(join(context.directory, "manifest.json"), bytes);
      const acceptance = JSON.parse(
        await readFile(join(context.directory, "accepted.json"), "utf8"),
      ) as { manifest: string };
      acceptance.manifest = sha(bytes);
      await writeFile(
        join(context.directory, "accepted.json"),
        JSON.stringify(acceptance),
      );
      assert.notEqual(context.run("publish").status, 0);
      assert.equal((await context.npm()).calls.length, 0);
    } finally {
      await context.close();
    }
  });
}
