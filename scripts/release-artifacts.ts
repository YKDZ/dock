import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export const packageNames = [
  "@ykdz/dock-core",
  "@ykdz/dock",
  "@ykdz/dock-reference-file",
  "@ykdz/dock-reference-markdown",
  "@ykdz/dock-reference-node-test",
  "@ykdz/dock-reference-typescript",
  "@ykdz/dock-reference-vitest",
] as const;

export type Artifact = {
  name: string;
  version: string;
  file: string;
  integrity: string;
};
export type ArtifactManifest = {
  commit: string;
  version: string;
  packages: Artifact[];
};

type PackedPackage = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export function captured(
  command: string,
  args: string[],
  cwd = process.cwd(),
): Buffer {
  const result = spawnSync(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")}: ${result.stderr?.toString() ?? result.error?.message}`,
  );
  return result.stdout;
}

export function integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function unpackManifest(file: string): PackedPackage {
  return JSON.parse(
    captured("tar", ["-xOf", file, "package/package.json"]).toString(),
  ) as PackedPackage;
}

export async function collectArtifacts(
  directory: string,
): Promise<ArtifactManifest> {
  await mkdir(directory, { recursive: true });
  const packages: Artifact[] = [];
  for (const name of packageNames) {
    // 包所属任务决定打包文件，根仅通过 pnpm 取得其产物。
    const bytes = captured("pnpm", [
      "--filter",
      name,
      "exec",
      "cat",
      ".artifacts/package.tgz",
    ]);
    const file = `${name.replace("@", "").replace("/", "-")}.tgz`;
    await writeFile(join(directory, file), bytes);
    const packed = unpackManifest(join(directory, file));
    packages.push({
      name: packed.name,
      version: packed.version,
      file,
      integrity: integrity(bytes),
    });
  }
  const manifest: ArtifactManifest = {
    commit: captured("git", ["rev-parse", "HEAD"]).toString().trim(),
    version: packages[0]!.version,
    packages,
  };
  await writeFile(
    join(directory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return validateArtifacts(directory, manifest.commit);
}

export async function validateArtifacts(
  directory: string,
  commit: string,
): Promise<ArtifactManifest> {
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  ) as ArtifactManifest;
  assert.equal(manifest.commit, commit, "制品提交与本次提交不同");
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
  assert.deepEqual(
    manifest.packages.map(({ name }) => name),
    [...packageNames],
    "制品集合或顺序错误",
  );
  for (const artifact of manifest.packages) {
    assert.equal(artifact.file, basename(artifact.file));
    assert.equal(artifact.version, manifest.version, "制品版本不一致");
    const file = resolve(directory, artifact.file);
    assert.equal(
      integrity(await readFile(file)),
      artifact.integrity,
      `${artifact.name} 摘要不符`,
    );
    const packed = unpackManifest(file);
    assert.equal(packed.name, artifact.name, "压缩包名称不符");
    assert.equal(packed.version, artifact.version, "压缩包版本不符");
    for (const dependencies of [packed.dependencies, packed.peerDependencies]) {
      for (const [name, version] of Object.entries(dependencies ?? {})) {
        if ((packageNames as readonly string[]).includes(name)) {
          assert.equal(
            version,
            manifest.version,
            `${artifact.name} 的 ${name} 未使用同批精确版本`,
          );
        } else {
          assert.ok(
            !version.startsWith("workspace:") && !name.startsWith("@dock/"),
            `公开依赖要求私有工作区包：${name}`,
          );
        }
      }
    }
  }
  return manifest;
}
