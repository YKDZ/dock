import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = join(
  packageDirectory,
  "fixtures",
  "installed-consumer",
  "scope-runtime.mjs",
);

/** 在既有 Node 消费者中验证直接测试文件筛选与完整运行身份预检。 */
export async function verifyInstalledScope(consumer: string): Promise<void> {
  const result = await run(process.execPath, [fixture], consumer);
  assert.equal(
    result.code,
    0,
    `Node 安装制品范围筛选验收失败：\n${result.stdout}\n${result.stderr}`,
  );
}

function run(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
